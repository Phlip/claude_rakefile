"""
Harbor agent adapters built on the stock claude-code adapter.

- ``PreinstalledClaudeCode``: stock behavior, except agent-setup reuses the
  claude binary baked into the task image instead of re-downloading it.
- ``SnapshotClaudeCode``: extends it to inject --resume and --fork-session
  when a snapshot session is present in the environment.

The harbor-run script uses PreinstalledClaudeCode for manual tasks and
auto-detects snapshot-based tasks to use SnapshotClaudeCode.
"""

import base64
import io
import json
import logging
import os
import shlex
import shutil
import tarfile
import tempfile
from pathlib import Path

import atif_session
import browser_note
try:
    from dnsjail import apply_dns_jail
except ImportError:  # no helper shipped -> no jail, rather than no trials

    async def apply_dns_jail(agent, environment) -> None:  # type: ignore[misc]
        return None

from harbor.agents.installed.base import CliFlag
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.models.trial.paths import EnvironmentPaths

_UUID_FILE = "/tmp/snapshot-session/uuid.txt"
_SESSION_FILE = "/tmp/snapshot-session/session.jsonl"
_DISABLED_SUFFIX = ".snapshot-seeded-disabled"

# The "[1m]" model-id suffix is a benchmark convention for the 1M-context
# window, NOT a real model id — the wire request must send the plain id plus
# this beta header (the proxy's server-side alias for the suffixed id was
# dropped; the literal id now 400s and the claude CLI hangs retrying).
_CONTEXT_1M_BETA_HEADER = "anthropic-beta: context-1m-2025-08-07"
# Spelled out rather than imported from llm_proxy_env: this module ships to the
# worker toolkit, where a cross-import would fail at import time.
_CLIENT_METADATA_HEADER = "X-Surge-Client-Metadata"
_TRIAL_CALL_METADATA = '{"origin":"harbor-trial"}'


def _strip_1m_suffix(model: str) -> tuple[str, bool]:
    """Split a model id into (wire id, wants-1M-context). The [1m] tag stays in
    agent identity (name(), trial-config model_name); only the wire id drops it."""
    if model.endswith("[1m]"):
        return model[: -len("[1m]")], True
    return model, False


def _merge_custom_headers(*values: str | None) -> str:
    """Union newline-separated ANTHROPIC_CUSTOM_HEADERS values, keeping order.
    Local, not shared: this module ships to the toolkit without llm_proxy_env."""
    merged: list[str] = []
    for value in values:
        for line in (value or "").split("\n"):
            if line.strip() and line not in merged:
                merged.append(line)
    return "\n".join(merged)


def _with_1m_beta_header(existing: str | None) -> str:
    """Merge the 1M-context beta header into an ANTHROPIC_CUSTOM_HEADERS value."""
    return _merge_custom_headers(existing, _CONTEXT_1M_BETA_HEADER)


def _with_trial_origin(existing: str | None) -> str:
    """Restate the call origin as this trial, replacing the launching surface's.

    Replaces rather than appends: two values of one header name is not a
    merge the proxy can read.
    """
    kept = [
        line
        for line in (existing or "").split("\n")
        if line.strip() and not line.startswith(f"{_CLIENT_METADATA_HEADER}:")
    ]
    return "\n".join([*kept, f"{_CLIENT_METADATA_HEADER}: {_TRIAL_CALL_METADATA}"])

# Fast mode (claude's /fast), opted in per-trial via `--ak fast_mode=true`
# (harbor-run --fast). The --settings flag is the only headless opt-in, and it
# doubles as the availability override for a proxy base URL: claude probes
# org fast-mode status at an API route inference-only proxies don't forward,
# and without the flag that failed probe reads as "unavailable". Rendered
# pre-quoted because a bool CliFlag emits its `cli` string verbatim into a
# shell command.
_FAST_MODE_CLI = "--settings " + shlex.quote('{"fastMode":true}')

_log = logging.getLogger("snapshot-agent")

# --- Reduced "bash + str_replace_editor" tool surface (the CANONICAL agent) --
# The canonical agent runs with ONLY the built-in Bash tool (so there's no
# async-MCP startup race), and a str_replace_editor file editor is delivered as a
# CLI it invokes through Bash. The editor's logic is vendored verbatim under
# scripts/str_replace_editor_vendor/ and wrapped by scripts/str_replace_editor.
# We stage both into the sandbox at install time and point the agent at them via
# --append-system-prompt.
#
# The toolset is chosen by WHICH AGENT CLASS harbor runs, not by an env var: the
# reduced toolset is the canonical PreinstalledClaudeCode / SnapshotClaudeCode;
# the full Claude Code built-in toolset (Read/Edit/Write/Grep/...) is the SEPARATE,
# transitional FullToolsetPreinstalledClaudeCode / FullToolsetSnapshotClaudeCode
# (delete those once every snapshot session.jsonl is recorded in the reduced
# format). A different toolset is simply a different agent — see name() below.
_AGENT_CLI_DIR = "/opt/agent-cli"
_AGENT_CLI_BIN = f"{_AGENT_CLI_DIR}/str_replace_editor"
# Files copied (orchestrator-relative) into the sandbox tar, arcname -> source.
_AGENT_CLI_FILES = {
    "str_replace_editor_vendor/__init__.py": "str_replace_editor_vendor/__init__.py",
    "str_replace_editor_vendor/base.py": "str_replace_editor_vendor/base.py",
    "str_replace_editor_vendor/run.py": "str_replace_editor_vendor/run.py",
    "str_replace_editor_vendor/edit.py": "str_replace_editor_vendor/edit.py",
    "str_replace_editor": "str_replace_editor",
}
_AGENT_CLI_NOTE_FALLBACK = (
    "You are running with a restricted toolset: your ONLY built-in tool is Bash.\n\n"
    "To view and edit files, use the `str_replace_editor` command-line tool (it "
    "replicates the standard str_replace-based file editor). Invoke it from Bash "
    f"by piping ONE JSON object to {_AGENT_CLI_BIN} on stdin. Use a quoted "
    "heredoc so backslashes and quotes are preserved:\n\n"
    f"  {_AGENT_CLI_BIN} <<'EDITOR'\n"
    '  {"command":"view","path":"/abs/path/file.rb"}\n'
    "  EDITOR\n\n"
    "Commands (the JSON \"command\" field):\n"
    "- view: view a file (optionally add \"view_range\":[start,end]) or list a directory.\n"
    "- create: create a NEW file -> {\"command\":\"create\",\"path\":...,\"file_text\":\"...\"} (fails if it already exists).\n"
    "- str_replace: replace a UNIQUE substring -> {\"command\":\"str_replace\",\"path\":...,\"old_str\":\"...\",\"new_str\":\"...\"}.\n"
    "- insert: insert at a line -> {\"command\":\"insert\",\"path\":...,\"insert_line\":N,\"insert_text\":\"...\"}.\n\n"
    "All paths must be absolute. JSON strings must be valid (escape newlines as \\n "
    "and double-quotes as \\\"). For everything else (running commands, searching "
    "with grep/find, reading via sed, etc.) use Bash directly."
)


def _toolset_note(with_browser: bool = False, with_read: bool = False) -> str:
    """The toolset note appended to Claude Code's stock ``--print`` system prompt
    (via ``--append-system-prompt``) for the canonical reduced toolset.

    We APPEND rather than replace: the stock prompt's big block carries the
    DYNAMIC Environment section (cwd, platform, OS, model) generated per run, and
    ``--system-prompt`` (full replace) would drop it — leaving the reduced-toolset
    agent without the Environment/Memory sections the full-toolset agent has (and
    those differ host-vs-sandbox, so they can't be hardcoded faithfully).
    Appending keeps the sandbox's real block intact; this note is added last to
    override the two stock spots that name tools this harness lacks (the "prefer
    the dedicated file/search tools" Harness bullet and the Memory section's "use
    the Write tool"). Single source of truth is toolset_note.md (read as-is, with
    only surrounding whitespace trimmed). Falls back to the built-in note if the
    file is missing."""
    path = Path(__file__).resolve().parent / "toolset_note.md"
    try:
        note = path.read_text(encoding="utf-8").strip()
    except OSError:
        note = _AGENT_CLI_NOTE_FALLBACK
    # Order matters: the Read correction must come AFTER the base note, because it supersedes
    # that note's "there are no Read/Grep/Glob tools" line. Shipping the base note alone to a
    # Read-enabled agent would be a false statement about its own toolset.
    if with_read:
        read_note = Path(__file__).resolve().parent / "toolset_note_read.md"
        try:
            note = f"{note}\n\n{read_note.read_text(encoding='utf-8').strip()}"
        except OSError:
            _log.warning("toolset_note_read.md missing; Read correction omitted")
    if with_browser:
        extra = browser_note.browser_note()
        if extra:
            note = f"{note}\n\n{extra}"
    return note


class PreinstalledClaudeCode(ClaudeCode):
    """Canonical agent: the reduced ``bash + str_replace_editor`` toolset, with
    agent-setup reusing the claude binary baked into the task image instead of
    re-downloading it. Manual (non-snapshot) tasks use this directly.

    A different toolset is a different AGENT (not an env-var flag), so this class
    names itself ``claude-code-reduced-toolset`` — the agent identity carries the
    toolset and there's no separate toolset field anywhere. The full Claude Code
    built-in toolset is the transitional :class:`FullToolsetPreinstalledClaudeCode`
    (name ``claude-code``). (Harbor records the name in each trial's result.json;
    we don't use ``harbor traces export`` — which would otherwise require a
    registry name — so a descriptive non-registry name is fine. Provenance is also
    in the trial config's ``agent.import_path``.)
    """

    # Set by _probe_browser() during install(); read by build_cli_flags(). Declared
    # here so the full-toolset subclass (which skips the probe) still has a value.
    _has_browser = False

    # Adding fast_mode HERE (the shared base) makes `--ak fast_mode=true` a known
    # kwarg on every Claude agent class, and every build_cli_flags variant —
    # reduced, browser, full-toolset — renders it via this table.
    CLI_FLAGS = [
        *ClaudeCode.CLI_FLAGS,
        CliFlag("fast_mode", cli=_FAST_MODE_CLI, type="bool"),
    ]

    @staticmethod
    def name() -> str:
        return "claude-code-reduced-toolset"

    # Manual tasks inherit harbor's run(), so the jail has to be applied here as well as on
    # the snapshot path — which overrides run() and never reaches this one.
    async def run(self, instruction, environment, context) -> None:  # type: ignore[override]
        await apply_dns_jail(self, environment)
        await super().run(instruction, environment, context)

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Normalize a "[1m]"-suffixed model id HERE, in the shared base of all
        # four Claude agent classes, so every run path sends the plain wire id —
        # including stock ClaudeCode.run(), which this class inherits for manual
        # (non-snapshot) tasks and which reads self.model_name directly. The 1M
        # window is requested via the beta header instead, delivered through
        # harbor's extra_env channel (merged into every agent exec on 0.9.x,
        # wired via Trial.scoped_exec_env on 0.18.x); _build_env also mirrors it
        # for the snapshot run path. The [1m] identity survives on purpose:
        # BaseAgent's _init_model_info already cached the suffixed id (for
        # to_agent_info) before this rebinding, and the trial config's
        # agent.model_name records the id as passed on the CLI.
        model = self.model_name
        if not model:
            # Stock ClaudeCode.run() falls back to os.environ["ANTHROPIC_MODEL"]
            # verbatim, with no overridable hook on the manual-task path — so
            # when no model was pinned, adopt a [1m]-suffixed env model here
            # (same effective wire value, normalized). A plain env model stays
            # on the stock fallback path untouched.
            model = os.environ.get("ANTHROPIC_MODEL", "")
        stripped, wants_1m = _strip_1m_suffix(model)
        if wants_1m:
            self.model_name = stripped
            self._extra_env["ANTHROPIC_CUSTOM_HEADERS"] = _with_1m_beta_header(
                self._extra_env.get("ANTHROPIC_CUSTOM_HEADERS")
            )

    async def install(self, environment) -> None:
        """Canonical (reduced) setup: stage the str_replace_editor CLI, then ensure
        the claude binary. The full-toolset subclass skips the staging (it has no
        editor CLI) and reuses ``_ensure_claude_binary`` directly."""
        await self._stage_agent_cli(environment)
        await self._ensure_claude_binary(environment)
        await self._probe_browser(environment)

    async def _probe_browser(self, environment) -> None:
        """Record whether this image ships the Playwright `pw` wrapper, so the toolset
        note mentions the browser only on images that have one. Runs during install(),
        which harbor calls before build_cli_flags() reads the result. The probe and the
        note text are shared with the codex adapter via browser_note.py."""
        self._has_browser = await browser_note.probe_browser(environment)

    async def _ensure_claude_binary(self, environment) -> None:
        """Reuse the claude binary already baked into the task image instead
        of re-downloading it at agent-setup.

        Harbor's stock ``install()`` pipes ``claude.ai/install.sh`` to bash
        inside the live sandbox — a ~240 MB binary download racing the 360 s
        agent-setup timeout. On a slow or stalling egress path (classic on
        WSL2/Docker Desktop) the download never finishes and every trial dies
        with ``AgentSetupTimeoutError`` — pure waste, since our task
        Dockerfiles already bake claude into ``/usr/local/bin``. Probe for a
        working binary first; fall back to harbor's installer only when the
        image truly lacks one, when an explicit agent-version pin doesn't
        match the baked binary, or when the probe itself errors. The probe
        is local and sub-second, so the fallbacks are effectively no worse
        than stock behavior.
        """
        try:
            probe = await environment.exec(
                command=(
                    'export PATH="$HOME/.local/bin:$PATH"; '
                    "command -v claude >/dev/null 2>&1 && claude --version"
                ),
                timeout_sec=30,
            )
        except Exception as exc:  # noqa: BLE001 — any probe failure → stock path
            _log.debug(
                "claude preinstall probe failed (%s); using stock installer", exc
            )
            await ClaudeCode.install(self, environment)
            return

        if probe.return_code == 0:
            pinned = getattr(self, "_version", None)
            baked = self.parse_version(probe.stdout or "")
            if not pinned or baked == pinned:
                _log.info(
                    "claude already in image (%s); skipping runtime download",
                    (probe.stdout or "").strip(),
                )
                return
            _log.info(
                "image bakes claude %s but %s was requested; using stock installer",
                baked,
                pinned,
            )
        await ClaudeCode.install(self, environment)

    def build_cli_flags(self) -> str:
        """Emit the reduced ``bash + str_replace_editor`` toolset flags: restrict
        the built-in toolset to ``--tools Bash`` and append the toolset note.

        harbor's stock adapter exposes only ``--allowedTools`` /
        ``--disallowedTools`` (permission lists). Under
        ``--permission-mode=bypassPermissions`` (which both run paths use) an
        allowlist does NOT remove tools — every built-in stays available, just
        auto-approved. claude's ``--tools`` flag is the one that sets the
        AVAILABLE toolset; ``Bash`` leaves Bash as the only built-in.

        APPEND (not replace) the toolset note: --append keeps the sandbox's real,
        dynamically-generated Environment/Memory block intact, and the note (added
        last) overrides the stock prompt's references to tools this harness lacks
        (the "prefer the dedicated file/search tools" bullet and the Memory
        section's "use the Write tool"). See _toolset_note(). The full-toolset
        subclass overrides this back to stock ``ClaudeCode.build_cli_flags``.
        """
        flags = super().build_cli_flags()
        note = _toolset_note(with_browser=self._has_browser)
        extra = f"--tools Bash --append-system-prompt {shlex.quote(note)}"
        return f"{flags} {extra}" if flags else extra

    async def _claude_format_session_path(self, environment, env, session_uuid: str) -> str:
        """Path in the sandbox to a session.jsonl Claude can resume.

        A task authored on another harness stages THAT harness's native blob, which
        `claude --resume` cannot read. Convert it through the ATIF hub and upload the
        result. A Claude-authored task — every task before multi-harness authoring —
        returns the staged path untouched, so its install stays byte-identical.
        """
        async def _read(command: str) -> str | None:
            try:
                result = await environment.exec(command=command, env=env, timeout_sec=30)
            except Exception as exc:  # best-effort: fall back to installing as-is
                _log.warning("Could not read staged session (%s); installing verbatim", exc)
                return None
            return getattr(result, "stdout", "") or ""

        # Probe the head first: a Claude-authored session needs no conversion, and that is
        # the common case, so pulling a multi-megabyte transcript through exec to learn
        # only that is waste. Act on the probe only when it says "claude" — a truncated
        # ATIF blob (one JSON object) parses as nothing, which is not the same answer.
        head = await _read(f"head -c 8192 {_SESSION_FILE} 2>/dev/null || true")
        if head is None:
            return _SESSION_FILE
        if atif_session.detect_format(head) == "claude":
            return _SESSION_FILE

        text = await _read(f"cat {_SESSION_FILE} 2>/dev/null || true")
        if text is None:
            return _SESSION_FILE
        fmt = atif_session.detect_format(text)
        if fmt in (None, "claude"):
            return _SESSION_FILE

        from datetime import datetime, timezone

        iso_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        lines = atif_session.atif_to_claude_session(
            atif_session.to_atif(text), session_id=session_uuid, iso_ts=iso_ts
        )
        if not lines:
            _log.warning("Converted %s session was empty; installing verbatim", fmt)
            return _SESSION_FILE

        _log.info(
            "Seeding Claude from a %s-authored session: %d records via ATIF", fmt, len(lines)
        )
        remote = "/tmp/snapshot-session/session.claude.jsonl"
        with tempfile.NamedTemporaryFile(
            "w", suffix=".jsonl", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write("\n".join(lines) + "\n")
            host_path = tmp.name
        try:
            await environment.upload_file(host_path, remote)
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment, command=f"chown {environment.default_user} {shlex.quote(remote)}"
                )
        finally:
            try:
                os.unlink(host_path)
            except OSError:
                pass
        return remote

    async def _stage_agent_cli(self, environment) -> None:
        """Stage the vendored str_replace_editor CLI into the sandbox.

        Bundles scripts/str_replace_editor_vendor/ (the verbatim EditTool source)
        plus the wrapper into a tar, ships it as base64 in one root exec, and
        unpacks it to ``/opt/agent-cli`` with the wrapper made executable. Runs at
        install time so the CLI is present before the agent's first turn.
        """
        here = Path(__file__).resolve().parent
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for arcname, rel in _AGENT_CLI_FILES.items():
                src = here / rel
                if not src.is_file():
                    raise FileNotFoundError(
                        f"str_replace_editor: missing vendored file {src} "
                        f"(expected scripts/{rel})"
                    )
                tar.add(str(src), arcname=arcname)
        b64 = base64.b64encode(buf.getvalue()).decode()
        command = (
            f"mkdir -p {_AGENT_CLI_DIR} && "
            f"printf %s {shlex.quote(b64)} | base64 -d | "
            f"tar xzf - -C {_AGENT_CLI_DIR} && "
            f"chmod -R a+rX {_AGENT_CLI_DIR} && chmod a+rx {_AGENT_CLI_BIN} && "
            # Fail loudly at setup if python3 is absent — the CLI needs it.
            f"command -v python3 >/dev/null 2>&1 || "
            f'{{ echo "str_replace_editor: python3 not found in sandbox" >&2; exit 1; }}'
        )
        await self.exec_as_root(environment, command=command, timeout_sec=120)
        _log.info("Staged str_replace_editor CLI to %s", _AGENT_CLI_BIN)
        await self._selftest_agent_cli(environment)

    async def _selftest_agent_cli(self, environment) -> None:
        """Fail loudly at setup if the staged CLI can't actually run an edit.

        Invokes the REAL staged wrapper (``_AGENT_CLI_BIN``) exactly the way the
        agent will — one JSON object piped on stdin — and asserts the edit landed
        on disk. This exercises the whole path end-to-end (the wrapper's shebang,
        its exec permissions, stdin JSON parsing, ``sys.path`` into the vendored
        package, and the vendored EditTool itself), so a broken wrapper, wrong
        perms, or a bad python (the vendored edit.py uses PEP 604 ``X | None`` and
        needs python >= 3.10) errors the trial at agent-setup instead of silently
        mid-benchmark. The python version is logged for visibility.

        ``set -e`` + the trailing OK echo mean any failure in the pipe (the
        wrapper) or the grep yields rc != 0 / no OK marker, which we raise on."""
        json_fmt = (
            '{"command":"str_replace","path":"%s",'
            '"old_str":"alpha","new_str":"ALPHA"}'
        )
        cmd = (
            "python3 --version 2>&1; "
            "set -e; "
            'TMP="$(mktemp)"; '
            'printf "alpha\\nbeta\\n" > "$TMP"; '
            f"printf '{json_fmt}' \"$TMP\" | {_AGENT_CLI_BIN}; "
            'grep -q ALPHA "$TMP"; '
            'echo "str_replace_editor self-test OK"'
        )
        result = await self.exec_as_root(environment, command=cmd, timeout_sec=30)
        out = (getattr(result, "stdout", "") or "").strip()
        rc = getattr(result, "return_code", 0)
        _log.info("str_replace_editor self-test (rc=%s): %s", rc, out.replace("\n", " | "))
        if rc != 0 or "self-test OK" not in out:
            raise RuntimeError(
                f"str_replace_editor self-test failed (rc={rc}). The staged "
                f"str_replace_editor could not perform an edit in the sandbox "
                f"(often python < 3.10). Output:\n{out}"
            )


class SnapshotClaudeCode(PreinstalledClaudeCode):
    """Canonical snapshot agent: resumes from a snapshot session and runs the
    reduced ``bash + str_replace_editor`` toolset. The full Claude Code built-in
    toolset is the transitional :class:`FullToolsetSnapshotClaudeCode`."""

    @staticmethod
    def name() -> str:
        return "snapshot-claude-code-reduced-toolset"

    @staticmethod
    def _is_bedrock_mode() -> bool:
        return False

    async def run(self, instruction: str, environment, context) -> None:
        env = self._build_env()
        config_dir = env["CLAUDE_CONFIG_DIR"]

        # Read the snapshot session UUID from the container
        result = await environment.exec(
            command=f"cat {_UUID_FILE} 2>/dev/null || echo ''",
            env=env,
            timeout_sec=5,
        )
        session_uuid = result.stdout.strip() if result.stdout else ""

        # Check whether the staged session.jsonl has any meaningful content.
        # snapshot-to-task may write an empty file when the snapshot has no
        # assistant entry with stop_reason="end_turn" — in that case we must
        # NOT pass --resume / --fork-session (CC errors out on an empty
        # session) and we must NOT stage the empty file.
        session_has_content = False
        if session_uuid:
            size_result = await environment.exec(
                command=(
                    f"if [ -s {_SESSION_FILE} ] && "
                    f"grep -q '[^[:space:]]' {_SESSION_FILE} 2>/dev/null; "
                    f"then echo 'yes'; else echo 'no'; fi"
                ),
                env=env,
                timeout_sec=5,
            )
            session_has_content = (
                size_result.stdout.strip() == "yes" if size_result.stdout else False
            )

        install_src = _SESSION_FILE
        escaped_instruction = shlex.quote(instruction)
        cli_flags = self.build_cli_flags()
        extra_flags = (cli_flags + " ") if cli_flags else ""

        # Install the session JSONL from the container's filesystem (COPY'd
        # in by the Dockerfile) into Claude Code's config dir. This runs in
        # the same exec call as the claude command so files are visible.
        workspace_dir = f"{config_dir}/projects/-workspace"
        if session_uuid and session_has_content:
            resume_flags = f"--resume {session_uuid} --fork-session "
            seeded_jsonl = f"{workspace_dir}/{session_uuid}.jsonl"
            install_src = await self._claude_format_session_path(
                environment, env, session_uuid
            )
            install_prefix = (
                f'mkdir -p "{workspace_dir}" && '
                f'cp "{install_src}" "{seeded_jsonl}" && '
                f'chmod -R 777 "{config_dir}" && '
            )
            # After the run, drop the seeded session JSONL so harbor's
            # trajectory converter sees ONLY the forked session claude wrote.
            # ``--fork-session`` writes the forked conversation (a SUPERSET: it
            # copies the seeded history verbatim, reusing the same ``toolu_*``
            # ids) to a NEW ``{uuid}.jsonl``. If the seed is left behind,
            # harbor's ``_convert_events_to_trajectory`` globs BOTH files and
            # merges them, producing duplicate ``tool_result`` events; the
            # second one orphans a tool_call (empty ``tool_name``), which
            # ``_convert_event_to_step`` skips, leaving a gap that trips the
            # sequential ``step_id`` invariant on the ``Trajectory`` model — so
            # the whole conversion raises and ``trajectory.json`` never lands.
            # Removing the seed in-sandbox makes a snapshot trial look exactly
            # like a stock claude-code trial (one session file) and is robust
            # even when the host-side ``populate_context_post_run`` hook below
            # is bypassed (e.g. a stale agent module on harbor's import path).
            # Guard: only remove the seed if a *different* forked JSONL exists,
            # so a claude build that appended in place (no real fork) keeps its
            # sole session file.
            seeded_cleanup = "; " + self._seeded_cleanup_cmd(
                workspace_dir, session_uuid
            )
        else:
            resume_flags = ""
            install_prefix = ""
            seeded_cleanup = ""
            if session_uuid and not session_has_content:
                # Seeded session.jsonl is empty (no end_turn assistant in the
                # source snapshot). Start fresh with --print instead.
                _log.debug(
                    "Seeded session.jsonl is empty; skipping --resume and starting fresh"
                )

        await apply_dns_jail(self, environment)
        await self.exec_as_agent(
            environment,
            command=(
                f'{install_prefix}'
                f'export PATH="$HOME/.local/bin:$PATH"; '
                f'export CLAUDE_CONFIG_DIR="{config_dir}"; '
                f"claude --verbose --output-format=stream-json "
                f"--permission-mode=bypassPermissions "
                f"{resume_flags}"
                f"{extra_flags}"
                f"--print -- {escaped_instruction} 2>&1 </dev/null | tee "
                f"/logs/agent/claude-code.txt"
                f"{seeded_cleanup}"
            ),
            env=env,
        )

    def _build_env(self) -> dict[str, str]:
        """Build the environment dict for agent execution."""
        env: dict[str, str | None] = {
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL", None),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "IS_SANDBOX": "1",
            "FORCE_AUTO_BACKGROUND_TASKS": "1",
            "ENABLE_BACKGROUND_TASKS": "1",
        }

        # The host env's header list (e.g. the proxy's X-Project-Id entry from
        # apply_llm_proxy_env) rides along with any agent-requested headers —
        # but only on a proxy base URL: a project id must never reach a
        # provider's own API (the direct-API escape hatch).
        on_proxy = "/llm_proxy/" in (env["ANTHROPIC_BASE_URL"] or "")
        header = _merge_custom_headers(
            os.environ.get("ANTHROPIC_CUSTOM_HEADERS") if on_proxy else None,
            self._extra_env.get("ANTHROPIC_CUSTOM_HEADERS"),
        )
        if on_proxy:
            header = _with_trial_origin(header)
        if self.model_name:
            # "[1m]" normalization happened once in PreinstalledClaudeCode.__init__
            # (shared by all Claude agent classes); by here model_name is the plain
            # wire id and any 1M beta header sits in self._extra_env.
            env["ANTHROPIC_MODEL"] = self.model_name.split("/")[-1]
        elif "ANTHROPIC_MODEL" in os.environ:
            # A [1m] env model was adopted into model_name by __init__, so this
            # fallback normally only sees plain ids — but the env can change
            # after construction, so normalize here too (defense in depth).
            fallback, wants_1m = _strip_1m_suffix(os.environ["ANTHROPIC_MODEL"])
            if wants_1m:
                header = _with_1m_beta_header(header)
            env["ANTHROPIC_MODEL"] = fallback

        # Mirror the [1m] beta header into this env dict: harbor versions differ
        # in where extra_env is merged (0.9.x: per-exec in _exec; 0.18.x:
        # Trial-level scoped_exec_env), so carrying it here keeps the snapshot
        # run path correct regardless of which plumbing the installed harbor has.
        if header:
            env["ANTHROPIC_CUSTOM_HEADERS"] = header

        if os.environ.get("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "").strip() == "1":
            env["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"] = "1"

        env.update(self._resolved_env_vars)
        env["CLAUDE_CONFIG_DIR"] = (EnvironmentPaths.agent_dir / "sessions").as_posix()

        return {k: v for k, v in env.items() if v}

    @staticmethod
    def _seeded_cleanup_cmd(workspace_dir: str, session_uuid: str) -> str:
        """Shell snippet (run after the claude pipeline) that deletes the seeded
        session JSONL so harbor's converter sees ONLY the forked session.

        Guarded: the seed is removed only if a *different* ``*.jsonl`` exists in
        ``workspace_dir`` — i.e. claude actually forked to a new file. If claude
        appended in place (no real fork), the seed is the sole session file and
        is kept, so we never destroy the only record of the run.
        """
        seeded_jsonl = f"{workspace_dir}/{session_uuid}.jsonl"
        return (
            f'if [ -f "{seeded_jsonl}" ] && '
            f'ls "{workspace_dir}/"*.jsonl 2>/dev/null '
            f'| grep -vq "/{session_uuid}\\.jsonl$"; '
            f'then rm -f "{seeded_jsonl}"; fi'
        )

    def populate_context_post_run(self, context) -> None:
        """Override harbor's post-run hook to make trajectory.json production
        reliable for snapshot resumes.

        The seeded session JSONL (the file we cp'd in from
        ``/tmp/snapshot-session/session.jsonl`` during run-prep) lives in
        ``sessions/projects/-workspace/{seeded_uuid}.jsonl`` alongside the
        new forked-session JSONL claude actually wrote during this trial.
        Harbor's ``_convert_events_to_trajectory`` reads BOTH files, and
        events from the seeded session — often from an older claude version
        with a slightly different schema — trip skip-paths inside
        ``_convert_event_to_step``. Skipping events breaks the sequential
        ``step_id`` invariant the ``Trajectory`` pydantic model enforces, so
        the whole conversion errors out and ``trajectory.json`` never lands.

        We work around it by moving every JSONL whose stem is not the
        forked session id aside before delegating to the parent's hook,
        then restoring it after. The forked session id is read from
        ``claude-code.txt``'s ``system/init`` event, which is the first
        thing claude writes via ``--output-format=stream-json``.

        If, after our cleanup, trajectory.json still isn't there, we log
        at WARNING (not debug) so downstream consumers can see something
        went wrong rather than silently inherit a half-broken run.
        """
        moved = self._isolate_forked_session_jsonl()
        try:
            super().populate_context_post_run(context)
        finally:
            self._restore_moved_jsonls(moved)

        trajectory_path = self.logs_dir / "trajectory.json"
        if not trajectory_path.is_file():
            # Stock conversion produced nothing even from the isolated forked
            # session. The usual culprit is a single orphaned tool_result (e.g.
            # left behind by autocompaction) that harbor skips, leaving a
            # step_id gap that sinks the whole Trajectory. Recover by rebuilding
            # from the forked session with orphaned tool_results stripped — one
            # degenerate event should not cost us the entire trajectory.
            if self._recover_trajectory_stripping_orphans():
                self.logger.info(
                    "Recovered trajectory.json by stripping orphaned tool_results"
                )

        if not trajectory_path.is_file():
            self.logger.warning(
                "trajectory.json was NOT produced in %s. Downstream tooling "
                "(grader replay, worldbench export, publish-reference-runs) "
                "depends on it. claude-code.txt: %s. sessions/projects: %s",
                self.logs_dir,
                "present" if (self.logs_dir / "claude-code.txt").is_file() else "MISSING",
                self._summarize_sessions_dir(),
            )

    def _read_forked_session_id(self) -> str | None:
        """Return the ``session_id`` from the first ``system/init`` event in
        ``claude-code.txt``, or None if it can't be found.

        Claude Code's ``--output-format=stream-json --print`` mode emits the
        init event near the top of the stream, but is allowed to emit other
        framing events before it (provider notices, warnings, etc.). Scan
        every line until we find an init event with a usable session_id, or
        we hit EOF — don't bail on the first non-init JSON we see.
        """
        stream_path = self.logs_dir / "claude-code.txt"
        if not stream_path.is_file():
            return None
        try:
            with open(stream_path, "r", encoding="utf-8") as handle:
                for line in handle:
                    stripped = line.strip()
                    if not stripped or not stripped.startswith("{"):
                        continue
                    try:
                        event = json.loads(stripped)
                    except json.JSONDecodeError:
                        continue
                    if (
                        event.get("type") == "system"
                        and event.get("subtype") == "init"
                    ):
                        sid = event.get("session_id")
                        if isinstance(sid, str) and sid:
                            return sid
        except OSError:
            return None
        return None

    def _recover_trajectory_stripping_orphans(self) -> bool:
        """Last-resort rebuild of ``trajectory.json`` from the forked session,
        tolerant of the single degenerate event that harbor's converter would
        otherwise let sink the whole trajectory.

        Harbor assigns ``step_id`` from the enumerate index BEFORE it may skip an
        event, so any event that ``_convert_event_to_step`` raises on leaves a
        gap that fails ``Trajectory.validate_step_ids`` — and the whole
        conversion is lost. Two real shapes trigger this even in a single,
        already-isolated forked session:

        - an orphaned ``tool_result`` whose ``tool_use`` was summarized away by
          autocompaction; and
        - a ``tool_result`` that shares an identical timestamp with its
          ``tool_use`` and stable-sorts ahead of it, so the result is processed
          before the call exists (also yielding an empty ``tool_name``).

        We re-run harbor's own conversion but temporarily make
        ``_convert_event_to_step`` substitute a placeholder step instead of
        raising, so one bad event costs us that single observation rather than
        the entire run. Returns ``True`` iff ``trajectory.json`` was written.
        This runs ONLY after the stock conversion already failed, so it never
        changes behavior on healthy sessions.
        """
        sessions_root = self.logs_dir / "sessions" / "projects"
        if not sessions_root.is_dir():
            return False
        jsonls: list[Path] = []
        for project_dir in sessions_root.iterdir():
            if project_dir.is_dir():
                jsonls.extend(project_dir.glob("*.jsonl"))
        if not jsonls:
            return False

        # Prefer the forked session alone; fall back to whatever is present.
        forked = self._read_forked_session_id()
        if forked and any(j.stem == forked for j in jsonls):
            jsonls = [j for j in jsonls if j.stem == forked]

        from harbor.models.trajectories.step import Step

        original_convert = self._convert_event_to_step

        def tolerant_convert(event: dict, step_id: int) -> Step:
            try:
                return original_convert(event, step_id)
            except ValueError:
                # Degenerate tool event (orphaned / mis-ordered tool_result).
                # Keep its output as a user observation so nothing is silently
                # dropped, and the sequential step_id stays intact.
                output = event.get("output")
                call_id = event.get("call_id") or "?"
                message = (
                    output
                    if isinstance(output, str) and output.strip()
                    else f"[unmatched tool_result for {call_id}]"
                )
                # Guard the timestamp: Step.validate_timestamp raises ValueError
                # on a non-ISO-8601 value, which harbor's loop would catch and
                # skip — re-introducing the exact step_id gap we're recovering
                # from. Fall back to no timestamp rather than lose the step.
                ts = event.get("timestamp")
                try:
                    return Step(
                        step_id=step_id, timestamp=ts, source="user", message=message
                    )
                except ValueError:
                    return Step(
                        step_id=step_id, timestamp=None, source="user", message=message
                    )

        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp) / "-workspace"
            session_dir.mkdir(parents=True)
            for jsonl in jsonls:
                shutil.copy(jsonl, session_dir / jsonl.name)
            self._convert_event_to_step = tolerant_convert  # type: ignore[assignment]
            try:
                trajectory = self._convert_events_to_trajectory(session_dir)
            except Exception as exc:  # noqa: BLE001
                self.logger.debug("Tolerant recovery failed: %s", exc)
                return False
            finally:
                del self._convert_event_to_step
            if not trajectory:
                return False
            try:
                with open(self.logs_dir / "trajectory.json", "w", encoding="utf-8") as handle:
                    json.dump(
                        trajectory.to_json_dict(), handle, indent=2, ensure_ascii=False
                    )
            except OSError:
                return False
            return True

    def _isolate_forked_session_jsonl(self) -> list[tuple[Path, Path]]:
        """Move any JSONL not matching the forked session id to a sibling
        ``*.snapshot-seeded-disabled`` path. Returns the list of
        (original, disabled) pairs so they can be restored after.

        If we can't determine the forked session id (no claude-code.txt, no
        init event, etc.), we leave the directory untouched. Harbor's
        converter will run as today — if it succeeds, great; if not, our
        WARNING fires.

        Safety guardrail: if NO JSONL on disk matches the forked id (e.g.
        claude wrote to an unexpected path), don't move anything aside —
        that would leave the converter with an empty session dir and
        guarantee failure. Better to let harbor's normal flow attempt the
        conversion against what's actually there.
        """
        forked = self._read_forked_session_id()
        if not forked:
            return []
        sessions_root = self.logs_dir / "sessions" / "projects"
        if not sessions_root.is_dir():
            return []

        all_jsonls: list[Path] = []
        for project_dir in sessions_root.iterdir():
            if not project_dir.is_dir():
                continue
            all_jsonls.extend(project_dir.glob("*.jsonl"))

        has_forked_match = any(j.stem == forked for j in all_jsonls)
        if not has_forked_match:
            self.logger.warning(
                "Forked session id %s from claude-code.txt has no matching "
                "JSONL in %s (found: %s). Leaving sessions/ untouched so "
                "harbor's converter can attempt against what's there.",
                forked,
                sessions_root,
                [j.name for j in all_jsonls],
            )
            return []

        moved: list[tuple[Path, Path]] = []
        for jsonl in all_jsonls:
            if jsonl.stem == forked:
                continue
            disabled = jsonl.with_suffix(jsonl.suffix + _DISABLED_SUFFIX)
            try:
                shutil.move(str(jsonl), str(disabled))
            except OSError as exc:
                # All-or-nothing: a partial move would feed the converter a
                # MIXED set (forked + still-present seeded), which is the
                # exact original failure mode this override exists to prevent.
                # Roll back any successful moves and let harbor's converter
                # run on the unmodified directory — same outcome as today
                # (likely fails, our WARNING fires), no worse.
                self.logger.warning(
                    "Could not move seeded JSONL %s aside: %s. Rolling back "
                    "any prior moves to avoid feeding the converter a mixed "
                    "set.",
                    jsonl,
                    exc,
                )
                self._restore_moved_jsonls(moved)
                return []
            moved.append((jsonl, disabled))
            _log.info(
                "Moved seeded JSONL %s aside so harbor converter only "
                "sees forked session %s",
                jsonl.name,
                forked,
            )
        return moved

    def _restore_moved_jsonls(self, moved: list[tuple[Path, Path]]) -> None:
        for original, disabled in moved:
            try:
                shutil.move(str(disabled), str(original))
            except OSError as exc:
                self.logger.warning(
                    "Could not restore seeded JSONL %s from %s: %s",
                    original,
                    disabled,
                    exc,
                )

    def _summarize_sessions_dir(self) -> str:
        sessions_root = self.logs_dir / "sessions" / "projects"
        if not sessions_root.is_dir():
            return "missing"
        parts: list[str] = []
        for project_dir in sorted(sessions_root.iterdir()):
            if not project_dir.is_dir():
                continue
            jsonls = sorted(p.name for p in project_dir.glob("*.jsonl"))
            parts.append(f"{project_dir.name}={jsonls}")
        return ", ".join(parts) if parts else "no JSONLs"


# --- TRANSITIONAL: full Claude Code built-in toolset -------------------------
# These restore Claude Code's full built-in toolset (Read/Edit/Write/Grep/Glob/
# Task/...) for snapshot session.jsonls recorded in the OLD full-toolset format.
# A different toolset is a different agent, so they keep the original
# "claude-code" / "snapshot-claude-code" names. DELETE this mixin + both classes
# once every snapshot session.jsonl is re-recorded in the reduced format.


class _BrowserToolsetMixin:
    """The canonical reduced toolset PLUS the ``Read`` built-in, for tasks that opt into a
    browser: a screenshot is only useful to an agent that can look at it, and ``Read`` is what
    turns a PNG on disk into an image the model actually sees.

    This is a SEPARATE AGENT, not a flag, per the rule that the toolset is chosen by which class
    harbor runs and the class name records it — so a benchmark row can never silently compare an
    agent that could see against one that couldn't.

    Two things to be clear-eyed about:
      * ``Read`` is not image-only. It also reads text files, PDFs and notebooks, so these tasks
        get back a file-reading built-in the reduced toolset deliberately removes. There is no
        narrower built-in; an image-only MCP tool was rejected because the canonical agent avoids
        MCP (see the async-MCP startup race note at the top of this file).
      * Tasks on this agent are not comparable with tasks on the canonical one. That is the point
        of the distinct name.
    """

    def build_cli_flags(self) -> str:
        flags = ClaudeCode.build_cli_flags(self)
        note = _toolset_note(with_browser=self._has_browser, with_read=True)
        extra = f"--tools Bash,Read --append-system-prompt {shlex.quote(note)}"
        return f"{flags} {extra}" if flags else extra


class BrowserPreinstalledClaudeCode(_BrowserToolsetMixin, PreinstalledClaudeCode):
    """Reduced toolset + Read, manual (non-snapshot) tasks."""

    @staticmethod
    def name() -> str:
        return "claude-code-reduced-toolset-browser"


class BrowserSnapshotClaudeCode(_BrowserToolsetMixin, SnapshotClaudeCode):
    """Reduced toolset + Read, snapshot tasks."""

    @staticmethod
    def name() -> str:
        return "snapshot-claude-code-reduced-toolset-browser"


class _FullToolsetMixin:
    """Override the canonical reduced toolset back to Claude Code's stock full
    built-in toolset: no str_replace_editor CLI to stage, and no --tools / note.
    Mixed in BEFORE the reduced base so its install/build_cli_flags win, while the
    snapshot resume/fork and the claude-binary probe are still inherited."""

    async def install(self, environment) -> None:
        # Full toolset has no editor CLI to stage — just ensure the claude binary.
        await self._ensure_claude_binary(environment)

    def build_cli_flags(self) -> str:
        # Stock Claude Code flags: the full built-in toolset, no --tools, no note.
        return ClaudeCode.build_cli_flags(self)


class FullToolsetPreinstalledClaudeCode(_FullToolsetMixin, PreinstalledClaudeCode):
    """TRANSITIONAL full-toolset manual agent. Delete once snapshots are reduced-format."""

    @staticmethod
    def name() -> str:
        return "claude-code"


class FullToolsetSnapshotClaudeCode(_FullToolsetMixin, SnapshotClaudeCode):
    """TRANSITIONAL full-toolset snapshot agent. Delete once snapshots are reduced-format."""

    @staticmethod
    def name() -> str:
        return "snapshot-claude-code"
