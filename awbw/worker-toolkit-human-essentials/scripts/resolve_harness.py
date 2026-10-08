#!/usr/bin/env python3
"""resolve_harness.py — turn a harness id + task dir into the flags a trial needs.

``scripts/harbor-run`` is bash and cannot parse the TOML registry, so it shells in
here and evals the result::

    RESOLVED="$(python3 scripts/resolve_harness.py --task-dir "$TASK_DIR")" || exit 1
    eval "$RESOLVED"

Python rather than TS on purpose: this ships in the worker toolkit, whose
package.json has no ``zod``/``smol-toml``, and ``tomllib`` is stdlib — so the
toolkit gains a harness-aware harbor-run with zero new dependencies. There is no TS
loader: TS callers (submit-task) shell in here, so both the schema and the selection
policy exist exactly once and there is nothing to drift.

Output is POSIX ``KEY='value'`` assignments (single-quoted, embedded quotes
escaped) on stdout; everything human-facing goes to stderr, so the eval only ever
sees assignments. A non-zero exit means "do not launch" — the point is to fail in a
second rather than burn agent minutes on a trial that cannot produce a usable grade.

Refuses to resolve when:
  - the harness id is unknown or disabled
  - the harness writes no ATIF trajectory (the grader would have no transcript)
  - the task ships a session to resume but the harness cannot resume one. This is
    the important one: it is the only failure here that would otherwise look like
    SUCCESS, with the agent answering a prompt whose conversation it never saw.
  - the harness's credential env var is unset

``--check-model`` additionally asks the proxy whether the model is granted. Opt-in
on purpose: it is a network call, and one in every run's critical path trades a fast
local failure for a new way to hang. The credential check, which is free, always runs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

from harness_registry import (  # noqa: E402
    Harness,
    HarnessRegistryError,
    load_harness_registry,
)

# Harness used when nothing selects one. Keeps every existing caller on today's
# behaviour, so adding harness selection changes no current run.
DEFAULT_HARNESS = "claude-code"

MODELS_TIMEOUT_SEC = 20


def warn(message: str) -> None:
    print(f"resolve-harness: {message}", file=sys.stderr)


def fail(message: str) -> "None":
    print(f"resolve-harness: ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def is_multi_turn(task_dir: str | None) -> bool:
    """A task is multi-turn when it ships a NON-EMPTY session to resume. Empty is
    the documented one-shot-snapshot fallback and must run cold, so size is the
    test, not existence."""
    if not task_dir:
        return False
    session = Path(task_dir) / "environment" / "session.jsonl"
    return session.is_file() and session.stat().st_size > 0


def wants_browser(task_dir: str | None) -> bool:
    """True when task.toml opts into a browser (`[metadata] browser = true`).

    Read straight from the file rather than via tomllib: this must agree with
    build-workspace.sh, which decides whether the IMAGE gets Playwright using the same
    text match. If the two ever disagree the agent is told about a browser the image
    lacks, which is the one failure the disclosure is designed to make impossible.
    Accepts the quoted form for the same reason build-workspace.sh does."""
    if not task_dir:
        return False
    toml_path = Path(task_dir) / "task.toml"
    if not toml_path.is_file():
        return False
    try:
        text = toml_path.read_text(encoding="utf-8")
    except OSError:
        return False
    return re.search(r'^[ \t]*browser[ \t]*=[ \t]*"?true"?[ \t]*$', text, re.M) is not None


def harness_from_task_toml(task_dir: str | None) -> str | None:
    """The task's own `[agent] harness` — the authoritative record of which harness
    this task was authored against.

    This is where the worker's choice lands: the snapshot flow stamps it from the CLI
    that produced the snapshot, and a manual author writes it themselves. Either way
    it is set at task-creation time, BEFORE any trial, so nothing here depends on a
    trial's output.

    Parsed with tomllib rather than a grep: a regex would happily match a commented
    line or the wrong table, and picking the wrong harness is a silent
    wrong-agent-runs bug.

    Returns None when the field is simply absent — the normal case for every task
    finalized before harness selection existed — so the caller falls through to the
    toolkit default.

    But an UNPARSEABLE task.toml refuses outright rather than falling back. Those are
    different situations and treating them alike is how the wrong harness runs
    quietly: the most likely way to break this file is adding a second `[agent]`
    table instead of a `harness` line inside the existing one (tasks already carry
    `[agent] timeout_sec`), and TOML rejects a duplicate table. Falling back there
    would run claude against a task its author wrote for codex and grade it as if
    nothing were wrong.
    """
    if not task_dir:
        return None
    path = Path(task_dir) / "task.toml"
    if not path.is_file():
        return None
    try:
        with open(path, "rb") as handle:
            doc = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        fail(
            f"{path} could not be parsed ({exc}). Refusing to guess a harness — fix "
            f'the file. If you were adding a harness, put `harness = "..."` inside '
            f"the EXISTING [agent] table rather than starting a second one."
        )
    harness = (doc.get("agent") or {}).get("harness")
    return harness if isinstance(harness, str) and harness else None


def normalize_model(harness: Harness, model: str) -> str:
    """Model id on the wire, per the harness's declared shape."""
    if harness.model_id_shape == "provider:model":
        return model.replace("/", ":")
    return model


def granted_models(harness: Harness) -> list[str] | None:
    """Model ids the key is granted, or None when the check couldn't run."""
    base_url = os.environ.get(harness.base_url_env or "")
    key = os.environ.get(harness.key_env or "")
    if not base_url or not key:
        warn("--check-model skipped: base URL or key env is unset")
        return None
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/models", headers={"Authorization": f"Bearer {key}"}
    )
    try:
        with urllib.request.urlopen(request, timeout=MODELS_TIMEOUT_SEC) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as exc:
        warn(f"--check-model skipped: /models unreachable ({exc})")
        return None
    return [m["id"] for m in body.get("data", []) if isinstance(m.get("id"), str)]


def assert_model_granted(harness: Harness, model: str) -> None:
    granted = granted_models(harness)
    if granted is None:
        return
    # The proxy LISTS ids provider-prefixed ("openai/gpt-5.6-sol") but 400s on that
    # form — requests take the bare id. Accept either spelling.
    bare = {g.split("/")[-1] for g in granted}
    if model not in granted and model not in bare:
        shown = ", ".join(granted[:12]) + (", …" if len(granted) > 12 else "")
        fail(
            f'Model "{model}" is not granted for this key. Granted ({len(granted)}): {shown}'
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--harness",
        help=f"harness id (default: the task's [agent] harness, else {DEFAULT_HARNESS})",
    )
    parser.add_argument(
        "--task-dir",
        help="task directory; decides multi-turn from environment/session.jsonl",
    )
    parser.add_argument("--model", help="override the harness's default model")
    parser.add_argument(
        "--fast",
        action="store_true",
        help="run the trial agent in the harness's fast serving mode (higher token "
        "rate, faster output). Refuses on a harness that has none.",
    )
    parser.add_argument(
        "--check-model",
        action="store_true",
        help="also ask the proxy whether the model is granted (network call)",
    )
    parser.add_argument(
        "--authoring-installs",
        action="store_true",
        help="print '<id>\\t<cli>\\t<install>' for each harness a worker can author "
        "with, and exit. Consumed by scripts/setup-harnesses.sh so the worker "
        "containers install from the registry rather than from hardcoded lists that "
        "drift.",
    )
    parser.add_argument(
        "--container-configs",
        action="store_true",
        help="print '<id>\\t<config_path>\\t<base64 container_config>' for each "
        "authoring harness that declares one, and exit. Base64 because the config is "
        "multi-line TOML and these query modes are line-oriented.",
    )
    parser.add_argument(
        "--surface",
        choices=("authoring", "explore"),
        default="authoring",
        help="which worker container --container-configs is for; explore additionally "
        "gets the capture hooks, whose commands only ship there.",
    )
    parser.add_argument(
        "--defaults",
        action="store_true",
        help="print '<id>\\t<default_model>\\t<effort_default>' for every harness, and "
        "exit. For recording what a task was authored against; nothing reads it back.",
    )
    parser.add_argument(
        "--explore-launchers",
        action="store_true",
        help="print '<id>\\t<cli>\\t<launch command>' for each authoring harness, and "
        "exit. The launch command has the registry's model, effort and agent_config "
        "already substituted, so Explore and a trial cannot disagree about them. "
        "Consumed by setup-harnesses.sh to write one launcher per harness.",
    )
    parser.add_argument(
        "--skills-dirs",
        action="store_true",
        help="print '<id>\t<skills_dir>' for each authoring harness that discovers "
        "skills from a directory, and exit. Lets setup-harnesses.sh install the "
        "snapshot skill for harnesses that have no plugin system.",
    )
    parser.add_argument(
        "--auth-files",
        action="store_true",
        help="print '<id>\t<auth_path>\t<auth_key_env>' for each authoring harness that "
        "authenticates from a file rather than the environment, and exit.",
    )
    parser.add_argument(
        "--authoring-credentials",
        action="store_true",
        help="print '<id>\\t<key_env>\\t<base_url_env>\\t<proxy_path>' for each "
        "authoring harness, and exit. Lets the containers point every harness at the "
        "same proxy key on its own provider path.",
    )
    parser.add_argument(
        "--declared-harness",
        action="store_true",
        help="print ONLY the harness --task-dir's task.toml declares (empty if it "
        "declares none) and exit. Unlike the default mode this applies no fallback, so "
        "a caller can tell 'declared' from 'defaulted'. Exists so consumers without a "
        "TOML parser never hand-roll one: a regex would match a commented line or the "
        "wrong table, and the duplicate-[agent] shape is exactly the likely mistake.",
    )
    parser.add_argument(
        "--resolve-identity",
        action="append",
        default=None,
        metavar="AGENT",
        help="resolve agent identities (a result.json config.agent import_path or name) "
        "to harness ids and exit; repeatable. Prints one TAB-separated "
        "'<identity>\\t<harness-id>' line each, with an empty id when nothing claims it. "
        "Lets callers that cannot import the registry (the worker toolkit has no "
        "zod/smol-toml) still resolve through the one source of truth.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="print the selectable harnesses and exit (what task.toml's [agent] harness accepts)",
    )
    parser.add_argument("--registry", default=None, help="registry path (tests)")
    args = parser.parse_args(argv)

    try:
        registry = (
            load_harness_registry(args.registry)
            if args.registry
            else load_harness_registry()
        )
    except HarnessRegistryError as exc:
        fail(str(exc))

    # --- read-only query modes: answer and exit, never emit assignments -------
    if args.authoring_installs:
        for harness in registry.authoring():
            print(f"{harness.id}\t{harness.cli or ''}\t{harness.install or ''}")
        return 0

    if args.container_configs:
        import base64

        for harness in registry.authoring():
            config = harness.container_config_text(surface=args.surface)
            if not (harness.config_path and config):
                continue
            blob = base64.b64encode(config.encode()).decode()
            print(f"{harness.id}\t{harness.config_path}\t{blob}")
        return 0

    if args.defaults:
        for harness in registry.all():
            print(
                f"{harness.id}\t{harness.default_model or ''}\t"
                f"{harness.effort_default or ''}"
            )
        return 0

    if args.explore_launchers:
        for harness in registry.authoring():
            print(
                f"{harness.id}\t{harness.cli or ''}\t"
                f"{harness.explore_launch_command() or ''}"
            )
        return 0

    if args.skills_dirs:
        for harness in registry.authoring():
            if harness.skills_dir:
                print(f"{harness.id}\t{harness.skills_dir}")
        return 0

    if args.auth_files:
        for harness in registry.authoring():
            if harness.auth_path and harness.auth_key_env:
                print(f"{harness.id}\t{harness.auth_path}\t{harness.auth_key_env}")
        return 0

    if args.authoring_credentials:
        for harness in registry.authoring():
            print(
                f"{harness.id}\t{harness.key_env or ''}\t"
                f"{harness.base_url_env or ''}\t{harness.proxy_path or ''}"
            )
        return 0

    if args.declared_harness:
        print(harness_from_task_toml(args.task_dir) or "")
        return 0

    if args.resolve_identity:
        for identity in args.resolve_identity:
            harness = registry.by_import_path(identity)
            print(f"{identity}\t{harness.id if harness else ''}")
        return 0

    if args.list:
        # Printed on stdout because it is the requested output here, not the
        # eval-able assignments — this mode is for a human, and never shelled into.
        for harness in registry.enabled():
            turns = (
                "multi-turn + single-turn"
                if harness.seed_native
                else "single-turn only"
            )
            model = harness.default_model or "(pass --model)"
            print(f"{harness.id:<16} {harness.label:<20} {turns:<24} {model}")
        return 0

    # --- selection ------------------------------------------------------------
    # Precedence: an explicit --harness (a benchmark, or a deliberate override) beats the
    # task's own record, which is what its author chose. Everything else — every task
    # finalized before harness selection existed — is the default.
    requested = args.harness or harness_from_task_toml(args.task_dir) or DEFAULT_HARNESS
    try:
        harness = registry.require(requested)
    except HarnessRegistryError as exc:
        fail(str(exc))

    if not harness.enabled:
        fail(
            f'Harness "{harness.id}" is disabled in the registry (never verified here). '
            f"Enable it in scripts/harness-registry.toml once a trial has been run with it."
        )
    if not harness.writes_atif:
        fail(
            f'Harness "{harness.id}" writes no ATIF trajectory, so the grader would have '
            f"no transcript and its rewards would be meaningless."
        )

    multi_turn = is_multi_turn(args.task_dir)
    if multi_turn and not harness.seed_native:
        fail(
            f'Task ships a session to resume, but harness "{harness.id}" cannot resume '
            f"one. Running anyway would look like a success while the agent answered a "
            f"prompt whose conversation it never saw."
        )

    if harness.key_env and not os.environ.get(harness.key_env):
        fail(f'{harness.key_env} is unset — required by harness "{harness.id}".')

    if args.fast and not harness.fast_kwarg:
        fail(
            f'Harness "{harness.id}" has no fast serving mode (no fast_kwarg in the '
            f"registry). Drop --fast or pick a harness that declares one."
        )

    model = args.model or harness.default_model
    if not model:
        fail(
            f'Harness "{harness.id}" has no default_model in the registry; pass --model '
            f"explicitly."
        )
    if args.check_model:
        assert_model_granted(harness, model)

    # Every assignment here becomes a harbor flag. Nothing else: the caller is bash, and
    # anything it would only echo back at the worker is said below instead.
    browser = wants_browser(args.task_dir)
    assignments = {
        "AGENT_IMPORT_PATH": harness.agent_import_path_for(multi_turn=multi_turn, browser=browser),
        "MODEL": normalize_model(harness, model),
        "EFFORT_KWARG": harness.effort_kwarg,
        "EFFORT_VALUE": (harness.effort_default or "") if harness.effort_kwarg else "",
        "FAST_KWARG": harness.fast_kwarg if args.fast else "",
    }

    warn(
        f"{harness.label} · model={assignments['MODEL']} · "
        f"{'multi-turn' if multi_turn else 'single-turn'} · "
        f"{'browser · ' if browser else ''}"
        f"{'fast · ' if args.fast else ''}"
        f"agent={assignments['AGENT_IMPORT_PATH']}"
    )
    if browser and not harness.agent_import_path_browser:
        # Not a failure: the image still gets Playwright and the agent is still told about
        # it. Only the Read-enabled toolset swap is claude-specific, and saying so beats
        # letting someone infer from a log line that the opt-in was ignored entirely.
        warn(
            f'"{harness.id}" has no browser-specific agent, so it runs its usual toolset. '
            f"The browser and its disclosure are unaffected."
        )
    if harness.flaky_hangs:
        warn(
            f"{harness.label} is known to hang with no client-side timeout on a small "
            f"fraction of trials. A silent, output-less trial is that, not a task defect."
        )
    for key, value in assignments.items():
        print(f"{key}={shlex.quote(value)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
