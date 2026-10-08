"""Custom Codex agents for our devcontainer-based task images.

Harbor's stock Codex agent (`harbor.agents.installed.codex.Codex`) installs Node
via nvm into `$HOME/.nvm` during `install()`, and `setup()` ALWAYS calls
`install()` (the version probe only runs afterward). That install fails on our
task images: they are `FROM mcr.microsoft.com/devcontainers/typescript-node:20`,
which provides Node through the devcontainer nvm at `/usr/local/share/nvm`, and
the tasks run as root, where that nvm isn't auto-loaded — so harbor's
`$HOME/.nvm/nvm.sh` doesn't exist and the agent dies with "NVM failed to load".

`SystemNodeCodex` overrides `install()` to load the image's existing Node and
install only the codex CLI (no second Node via nvm). Everything else — the
trajectory parsing, the codex exec, reasoning_effort kwargs — is inherited
unchanged from the stock agent.

Use via: `--agent-import-path codex_agent:SystemNodeCodex` (PYTHONPATH=scripts).
"""

from __future__ import annotations

import json
import os
import shlex
import sys
import tempfile
import tomllib
import uuid
from pathlib import Path

import atif_session
import browser_note
try:
    from dnsjail import apply_dns_jail
except ImportError:  # no helper shipped -> no jail, rather than no trials

    async def apply_dns_jail(agent, environment) -> None:  # type: ignore[misc]
        return None


from harbor.agents.installed.codex import Codex
from harbor.models.trial.paths import EnvironmentPaths

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))

import codex_auth  # noqa: E402
from harness_registry import load_harness_registry  # noqa: E402

# Installs the codex CLI into /usr/local/bin so harbor's plain-sh execs find it.
#
# Primary path is the official standalone installer, which fetches a prebuilt
# native binary and needs only curl + tar — no Node in the image. That matters
# because most task images (Ruby/Python) ship no Node at all, and the npm route
# below can only run on the Node-bearing minority.
#
# The npm route is kept as a fallback for images where the installer can't run
# (e.g. a native binary the image's glibc rejects) but a usable npm exists.
_INSTALL_CMD = (
    "set -x; "
    "if command -v apt-get >/dev/null 2>&1; then "
    "  apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl ripgrep >/dev/null 2>&1 || true; "
    "fi; "
    'if ! command -v codex >/dev/null 2>&1; then '
    '  CODEX_INSTALL_DIR=/usr/local/bin CODEX_NON_INTERACTIVE=true '
    '    sh -c "curl -fsSL https://chatgpt.com/codex/install.sh | sh" >&2 || true; '
    "fi; "
    'if ! command -v codex >/dev/null 2>&1 && [ -x "$HOME/.local/bin/codex" ]; then '
    '  ln -sf "$HOME/.local/bin/codex" /usr/local/bin/codex; '
    "fi; "
    # npm fallback: load the devcontainer nvm, else find npm anywhere plausible.
    'if ! command -v codex >/dev/null 2>&1; then '
    '  export NVM_DIR="${NVM_DIR:-/usr/local/share/nvm}"; '
    '  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true; '
    '  if ! command -v npm >/dev/null 2>&1; then '
    '    npm_path="$(find /usr/local/share/nvm /usr/local /usr/lib /opt -name npm -type f 2>/dev/null | head -1)"; '
    '    [ -n "$npm_path" ] && export PATH="$PATH:$(dirname "$npm_path")"; '
    "  fi; "
    '  command -v npm >/dev/null 2>&1 && npm install -g @openai/codex@latest; '
    "fi; "
    'for bin in node codex; do '
    '  p="$(command -v "$bin" 2>/dev/null || true)"; '
    '  [ -n "$p" ] && [ "$p" != "/usr/local/bin/$bin" ] && ln -sf "$p" "/usr/local/bin/$bin" || true; '
    "done; "
    'command -v codex >/dev/null 2>&1 '
    '  || { echo "FATAL: codex CLI unavailable (standalone installer and npm both failed)" >&2; exit 1; }; '
    "codex --version"
)


# codex reserves its built-in provider ids, so the call-origin header needs a provider of
# our own. A trial's origin is a constant, so it is a static http_headers literal here
# rather than the env-var indirection the containers need — nothing to plumb into a
# sandbox, and no way for a missing var to lose the attribution.
PROXY_PROVIDER_TOML = """\
model_provider = "llm-proxy"

[model_providers.llm-proxy]
name = "LLM proxy"
base_url = "${OPENAI_BASE_URL}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
http_headers = { "X-Surge-Client-Metadata" = '{"origin":"harbor-trial"}' }
"""
# A custom provider reads its key from env_key and never from auth.json, so the proxy
# path must carry this even when an auth file was uploaded.
PROXY_KEY_VAR = "OPENAI_API_KEY"


def proxy_provider_config(openai_base_url: str) -> dict:
    """PROXY_PROVIDER_TOML as harbor's config dict, pointed at this trial's URL."""
    return tomllib.loads(PROXY_PROVIDER_TOML.replace("${OPENAI_BASE_URL}", openai_base_url))




class SystemNodeCodex(Codex):
    # Set by install()'s probe, read by build_cli_flags(). Mirrors the claude adapter.
    _has_browser = False

    # Non-snapshot codex tasks run this class directly; the native-snapshot resume path
    # overrides run() and applies the jail itself.
    async def run(self, instruction, environment, context):  # type: ignore[override]
        self._refuse_shell_hostile_key()
        await apply_dns_jail(self, environment)
        await super().run(instruction, environment, context)

    def _auth_json_setup(self, remote_auth_path: str) -> tuple[dict[str, str], str]:
        return codex_auth.auth_json_setup(
            self._get_env("OPENAI_API_KEY") or "", remote_auth_path
        )

    def _proxy_provider_flags(self) -> str:
        """`-c` overrides putting the trial on our own provider — the only place codex
        can be told to send the call-origin header.

        On the command line rather than in config.toml because harbor writes that file
        itself, differently per version (0.20 hardcodes the block inline), while these
        flags are ours in every version.
        """
        base_url = self._get_env("OPENAI_BASE_URL") or ""
        if "/llm_proxy/" not in base_url:
            return ""
        # A custom provider ignores auth.json, so leave that flow on the built-in
        # provider: losing attribution beats breaking the run's auth.
        if self._resolve_auth_json_path():
            return ""
        config = proxy_provider_config(base_url)
        provider_id = config["model_provider"]
        parts = [f"-c model_provider={provider_id}"]
        for key, value in config["model_providers"][provider_id].items():
            for path, leaf in (
                [(f"{key}.{k}", v) for k, v in value.items()]
                if isinstance(value, dict)
                else [(key, value)]
            ):
                # A TOML literal string, since the header value is JSON and carries its
                # own double quotes.
                quoted = f"'{leaf}'" if '"' in leaf else f'"{leaf}"'
                parts.append(
                    "-c "
                    + shlex.quote(f"model_providers.{provider_id}.{path}={quoted}")
                )
        return " ".join(parts)

    def _refuse_shell_hostile_key(self) -> None:
        """Harbor's own Codex.run interpolates the key into a heredoc, so a key it cannot
        escape would 401 with no stated cause. Refuse up front instead."""
        if self._resolve_auth_json_path():
            return
        bad = codex_auth.unescapable_chars(self._get_env("OPENAI_API_KEY") or "")
        if bad:
            raise ValueError(
                "OPENAI_API_KEY contains "
                + ", ".join(repr(c) for c in bad)
                + ", which harbor's stock auth.json writer cannot escape. Point "
                "CODEX_AUTH_JSON_PATH at a pre-written auth.json instead."
            )

    async def install(self, environment) -> None:  # type: ignore[override]
        await self.exec_as_root(environment, command=_INSTALL_CMD)
        self._has_browser = await browser_note.probe_browser(environment)

    def build_cli_flags(self) -> str:  # type: ignore[override]
        """Harbor's flags plus the registry's `agent_config`, so a trial's toolset
        matches the explore launcher's — which passes the same rendering as
        $RACCOON_AGENT_FLAGS. Both run paths go through here."""
        flags = super().build_cli_flags()
        reductions = load_harness_registry().require("codex").agent_config_flags()
        if reductions:
            flags = f"{flags} {reductions}".strip()
        # Both run paths go through here, so this is where the trial picks up the
        # provider that carries the call-origin header.
        provider = self._proxy_provider_flags()
        if provider:
            flags = f"{flags} {provider}".strip()
        return f"{flags} {self._browser_flag()}".strip() if self._browser_flag() else flags

    def _browser_flag(self) -> str:
        """Disclose the browser to codex the way codex takes extra instructions.

        `developer_instructions` PREPENDS a developer message and leaves codex's own base
        instructions in place — verified with `codex debug prompt-input`. That makes it the
        equivalent of claude's --append-system-prompt. `model_instructions_file`, the other
        instruction-shaped key, REPLACES the base instructions; do not use it here.
        """
        if not self._has_browser:
            return ""
        note = browser_note.browser_note()
        if not note:
            return ""
        return f"-c developer_instructions={shlex.quote(note)}"


# Where harbor's run-prep stages the prior Claude Code session for snapshot tasks
# (the same file our snapshot_agent reads). Agent-agnostic, so codex sees it too.
_STAGED_SESSION = "/tmp/snapshot-session/session.jsonl"


def render_claude_session(jsonl_text: str, max_block: int = 4000) -> str:
    """Render a Claude Code session JSONL transcript into readable plain text so a
    non-Claude agent (codex) can be handed the prior conversation as context.

    Each line is a Claude record: {"type": "user"|"assistant", "message": {"role",
    "content"}}. `content` is either a string or a list of blocks
    (text / tool_use / tool_result / thinking). We flatten to labeled turns and
    truncate oversized tool payloads so the context stays bounded."""
    out: list[str] = []

    def clip(s: str) -> str:
        s = s.rstrip()
        return s if len(s) <= max_block else s[:max_block] + "\n…[truncated]"

    for line in jsonl_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        rtype = rec.get("type")
        msg = rec.get("message") or {}
        role = msg.get("role") or rtype
        content = msg.get("content")
        if content is None:
            # non-message records (summaries, etc.) — skip unless they carry text
            txt = rec.get("summary") or rec.get("content")
            if isinstance(txt, str) and txt.strip():
                out.append(f"[{rtype}] {clip(txt)}")
            continue
        if isinstance(content, str):
            out.append(f"{role.upper()}: {clip(content)}")
            continue
        # content is a list of blocks
        for block in content:
            if not isinstance(block, dict):
                out.append(f"{role.upper()}: {clip(str(block))}")
                continue
            btype = block.get("type")
            if btype == "text":
                out.append(f"{role.upper()}: {clip(block.get('text', ''))}")
            elif btype == "thinking":
                out.append(f"{role.upper()} (thinking): {clip(block.get('thinking', ''))}")
            elif btype == "tool_use":
                name = block.get("name", "?")
                inp = json.dumps(block.get("input", {}), ensure_ascii=False)
                out.append(f"{role.upper()} [tool_use {name}]: {clip(inp)}")
            elif btype == "tool_result":
                res = block.get("content")
                if isinstance(res, list):
                    res = "".join(
                        b.get("text", "") for b in res if isinstance(b, dict)
                    )
                out.append(f"[tool_result]: {clip(str(res))}")
    return "\n".join(out)


_INLINE_PREAMBLE = (
    "You are continuing an in-progress pair-programming session. Below is the FULL "
    "prior conversation between the user and the previous assistant (you), including "
    "the tool calls that assistant made and their results. Treat it as your own prior "
    "context — the workspace already reflects any edits made in it. Then respond to the "
    "user's newest message at the end.\n\n"
    "================ PRIOR CONVERSATION ================\n"
)


class InlineSnapshotCodex(SystemNodeCodex):
    """Bridge A: run codex on snapshot tasks by INLINING the prior Claude session as
    plain-text context ahead of the user's next-turn instruction. Works for any
    provider — codex just sees a long prompt: [rendered prior conversation] + [the
    user's newest message]. For non-snapshot tasks (no staged session) it behaves
    exactly like the stock codex agent."""

    async def run(self, instruction, environment, context):  # type: ignore[override]
        session_text = ""
        try:
            result = await environment.exec(
                command=f"cat {_STAGED_SESSION} 2>/dev/null || true"
            )
            session_text = (getattr(result, "stdout", "") or "").strip()
        except Exception as exc:  # best-effort; fall back to bare instruction
            self.logger.warning("InlineSnapshotCodex: could not read session: %s", exc)

        if session_text:
            rendered = render_claude_session(session_text)
            if rendered.strip():
                instruction = (
                    _INLINE_PREAMBLE
                    + rendered
                    + "\n\n================ USER'S NEWEST MESSAGE ================\n"
                    + instruction
                )
                self.logger.info(
                    "InlineSnapshotCodex: injected %d chars of rendered prior session",
                    len(rendered),
                )
            else:
                self.logger.warning("InlineSnapshotCodex: session rendered empty")
        else:
            self.logger.info(
                "InlineSnapshotCodex: no staged session (non-snapshot task or empty); "
                "running bare instruction"
            )
        await super().run(instruction, environment, context)


# ---------------------------------------------------------------------------
# Bridge B: native codex resume.
#
# Instead of inlining the whole prior Claude session into one giant prompt
# (Bridge A, which makes codex stall on a ~50k-token blob), we translate the
# staged session into codex's OWN rollout JSONL format, drop it into
# $CODEX_HOME/sessions/<date>/rollout-<ts>-<uuid>.jsonl, and invoke
# `codex exec resume <uuid> -- <instruction>`. codex then treats the prior turns
# as its own conversation history — prompt-cached and incremental — and only has
# to reason about the user's newest message.
#
# We resume by EXPLICIT session id (not --last): --last is cwd-filtered (help:
# "--all ... disables cwd filtering"), and we can't guarantee the rollout's
# recorded cwd matches the sandbox cwd at runtime; an explicit UUID is a direct
# lookup that sidesteps that entirely.
# ---------------------------------------------------------------------------

# A real recorded codex session_meta line (with codex's base_instructions) is the
# most reliable seed for `resume`. The fixture lives in-repo (mounted into the
# devcontainer where this agent code runs); a captured host copy is a secondary
# source, and a synthesized minimal record is the final fallback.
_ROLLOUT_TEMPLATE_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex-rollout-template.jsonl"),
    "/Users/nickheiner/.claude/jobs/e8fade29/tmp/codex-rollout-template.jsonl",
)


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _session_meta(new_id: str, iso_ts: str) -> dict:
    """Return a codex `session_meta` rollout record, reusing the captured real
    template (best fidelity for resume) when readable, else a minimal synthesized
    one. The id/timestamp are always overwritten with our fresh values."""
    for template_path in _ROLLOUT_TEMPLATE_CANDIDATES:
        try:
            with open(template_path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    if rec.get("type") == "session_meta":
                        rec["timestamp"] = iso_ts
                        rec.setdefault("payload", {})
                        rec["payload"]["id"] = new_id
                        rec["payload"]["timestamp"] = iso_ts
                        return rec
        except (OSError, ValueError):
            continue
    return {
        "timestamp": iso_ts,
        "type": "session_meta",
        "payload": {
            "id": new_id,
            "timestamp": iso_ts,
            "cwd": "/workspace",
            "originator": "codex_exec",
            "cli_version": "0.135.0",
            "source": "exec",
            "thread_source": "user",
            "model_provider": "openai",
        },
    }



def is_codex_rollout(session_jsonl_text: str) -> bool:
    """True when the staged session is already a codex rollout rather than a Claude Code
    transcript. Delegates to atif_session, which owns format detection — a second copy of
    the record-type set here is how the two would eventually disagree."""
    return atif_session.detect_format(session_jsonl_text) == "codex"

def reid_codex_rollout(session_jsonl_text: str, new_id: str, iso_ts: str) -> list[str]:
    """Re-key an already-native codex rollout onto `new_id` so `codex exec resume
    <new_id>` finds it. Conversation records pass through byte-identical — a
    codex-authored snapshot resumed by codex needs no translation, which is the
    whole fidelity argument for native seeding."""
    lines = [json.dumps(_session_meta(new_id, iso_ts))]
    for raw in session_jsonl_text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(rec, dict) or rec.get("type") == "session_meta":
            continue
        lines.append(raw)
    return lines


def stage_to_codex_rollout(session_jsonl_text: str, new_id: str, iso_ts: str) -> list[str]:
    """Build a resumable codex rollout from whichever format the snapshot staged."""
    if is_codex_rollout(session_jsonl_text):
        return reid_codex_rollout(session_jsonl_text, new_id, iso_ts)
    return claude_to_codex_rollout(session_jsonl_text, new_id, iso_ts)


def claude_to_codex_rollout(
    session_jsonl_text: str, new_id: str, iso_ts: str, max_total: int | None = None
) -> list[str]:
    """Translate a staged Claude Code session into codex rollout JSONL lines so
    `codex exec resume` can continue it natively.

    Parsing and rendering live in atif_session, which routes every harness pair
    through ATIF; this stays as the codex-side entry point. `max_total` is an optional
    char cap used by tests; the default is uncapped — our seeded sessions (~20-95k
    tokens) fit every supported model's context."""
    return atif_session.atif_to_codex_rollout(
        atif_session.claude_session_to_atif(session_jsonl_text),
        iso_ts,
        session_meta=_session_meta(new_id, iso_ts),
        max_total=max_total,
    )


class NativeSnapshotCodex(SystemNodeCodex):
    """Bridge B: continue the staged Claude session via NATIVE codex resume.

    For snapshot tasks we translate `/tmp/snapshot-session/session.jsonl` into a
    codex rollout, write it under `$CODEX_HOME/sessions/`, and run
    `codex exec resume <uuid> -- <instruction>`. For non-snapshot tasks (no staged
    session) we defer to the stock fresh `codex exec` via the base agent."""

    async def _read_staged_session(self, environment) -> str:
        try:
            result = await environment.exec(
                command=f"cat {_STAGED_SESSION} 2>/dev/null || true"
            )
            return (getattr(result, "stdout", "") or "").strip()
        except Exception as exc:  # best-effort
            self.logger.warning("NativeSnapshotCodex: could not read session: %s", exc)
            return ""

    async def run(self, instruction, environment, context):  # type: ignore[override]
        # NOTE: codex unconditionally declares its `tool_search` (MCP apps tool-
        # discovery) tool, which the OpenAI API REJECTS for nano models with HTTP
        # 400 "Tool 'tool_search' is not supported". None of codex's knobs
        # (--disable tool_search / features.tool_search / enable_mcp_apps=false /
        # disabled_tools) suppress it as of codex 0.135, so nano models are NOT
        # runnable under this harness. Use a mini (e.g. gpt-5.4-mini) for the small
        # end instead. Non-nano models are unaffected.
        await apply_dns_jail(self, environment)
        session_text = await self._read_staged_session(environment)
        if not session_text:
            self.logger.info(
                "NativeSnapshotCodex: no staged session (non-snapshot task or empty); "
                "running stock fresh codex exec"
            )
            await SystemNodeCodex.run(self, instruction, environment, context)
            return

        if not self.model_name:
            raise ValueError("Model name is required")
        model = self.model_name.split("/")[-1]

        new_id = str(uuid.uuid4())
        iso_ts = _now_iso()
        rollout_lines = stage_to_codex_rollout(session_text, new_id, iso_ts)
        self.logger.info(
            "NativeSnapshotCodex: %s rollout of %d records (~%d chars) for resume %s",
            "re-keyed native" if is_codex_rollout(session_text) else "translated Claude",
            len(rollout_lines),
            sum(len(line) for line in rollout_lines),
            new_id,
        )

        # --- auth/setup: faithful to harbor's Codex.run (OPENAI_API_KEY → auth.json) ---
        escaped_instruction = shlex.quote(instruction)
        cli_flags = self.build_cli_flags()
        cli_flags_arg = (cli_flags + " ") if cli_flags else ""
        auth_json_path = self._resolve_auth_json_path()
        remote_codex_home = self._REMOTE_CODEX_HOME.as_posix()
        remote_secrets_dir = self._REMOTE_CODEX_SECRETS_DIR.as_posix()
        remote_auth_path = (self._REMOTE_CODEX_SECRETS_DIR / "auth.json").as_posix()

        env: dict[str, str] = {"CODEX_HOME": remote_codex_home}
        setup_env: dict[str, str] = {}
        await self.exec_as_agent(
            environment,
            command=(
                f'mkdir -p "$CODEX_HOME" {shlex.quote(remote_secrets_dir)} '
                f"{shlex.quote(EnvironmentPaths.agent_dir.as_posix())}"
            ),
            env=env,
        )
        if auth_json_path:
            await environment.upload_file(auth_json_path, remote_auth_path)
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment,
                    command=f"chown {environment.default_user} {remote_auth_path}",
                )
            setup_command = f'ln -sf {shlex.quote(remote_auth_path)} "$CODEX_HOME/auth.json"\n'
        else:
            env["OPENAI_API_KEY"] = self._get_env("OPENAI_API_KEY") or ""
            setup_env, auth_command = self._auth_json_setup(remote_auth_path)
            setup_command = (
                auth_command
                + f"ln -sf {shlex.quote(remote_auth_path)} \"$CODEX_HOME/auth.json\"\n"
            )
        if openai_base_url := self._get_env("OPENAI_BASE_URL"):
            env["OPENAI_BASE_URL"] = openai_base_url
            # The provider that carries the origin header rides in on build_cli_flags,
            # so this stays harbor's plain root key.
            setup_command += (
                '\ncat >>"$CODEX_HOME/config.toml" <<TOML\n'
                'openai_base_url = "${OPENAI_BASE_URL}"\n'
                "TOML"
            )
            # env_key names this, and the provider cannot fall back to auth.json.
            if proxy_key := self._get_env(PROXY_KEY_VAR):
                env[PROXY_KEY_VAR] = proxy_key
        skills_command = self._build_register_skills_command()
        if skills_command:
            setup_command += f"\n{skills_command}"
        mcp_command = self._build_register_mcp_servers_command()
        if mcp_command:
            setup_command += f"\n{mcp_command}"
        if setup_command.strip():
            await self.exec_as_agent(
                environment, command=setup_command, env={**env, **setup_env}
            )

        # --- write the converted rollout into $CODEX_HOME/sessions/<date>/ ---
        date_parts = iso_ts[:10].split("-")  # YYYY, MM, DD
        sessions_dir = f"{remote_codex_home}/sessions/{date_parts[0]}/{date_parts[1]}/{date_parts[2]}"
        rollout_name = f"rollout-{iso_ts.replace(':', '-')}-{new_id}.jsonl"
        remote_rollout = f"{sessions_dir}/{rollout_name}"
        await self.exec_as_agent(
            environment, command=f"mkdir -p {shlex.quote(sessions_dir)}", env=env
        )
        with tempfile.NamedTemporaryFile(
            "w", suffix=".jsonl", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write("\n".join(rollout_lines) + "\n")
            host_rollout = tmp.name
        try:
            await environment.upload_file(host_rollout, remote_rollout)
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment,
                    command=f"chown {environment.default_user} {shlex.quote(remote_rollout)}",
                )
        finally:
            try:
                os.unlink(host_rollout)
            except OSError:
                pass

        # --- resume by explicit session id ---
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                    f"codex exec resume {new_id} "
                    "--dangerously-bypass-approvals-and-sandbox "
                    "--skip-git-repo-check "
                    f"--model {model} "
                    "--json "
                    "--enable unified_exec "
                    f"{cli_flags_arg}"
                    "-- "
                    f"{escaped_instruction} "
                    f"2>&1 </dev/null | tee {EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME}"
                ),
                env=env,
            )
        finally:
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        f"mkdir -p {EnvironmentPaths.agent_dir.as_posix()}\n"
                        'if [ -d "$CODEX_HOME/sessions" ]; then\n'
                        f"  rm -rf {(EnvironmentPaths.agent_dir / 'sessions').as_posix()}\n"
                        f'  cp -R "$CODEX_HOME/sessions" {(EnvironmentPaths.agent_dir / "sessions").as_posix()}\n'
                        "fi"
                    ),
                    env=env,
                )
            except Exception:
                pass
