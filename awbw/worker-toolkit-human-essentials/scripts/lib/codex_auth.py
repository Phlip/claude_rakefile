"""How codex is handed its API key, kept out of codex_agent so it is testable without
harbor (whose venv has no pytest, so anything importing it SKIPs in CI).

codex reads its key from `$CODEX_HOME/auth.json` and its proxy URL from config.toml —
`OPENAI_API_KEY` / `OPENAI_BASE_URL` in the environment are both ignored, verified against
0.146.0 and 0.152.0 (an env-var-only run sends no `authorization` header at all).
"""

from __future__ import annotations

import json
import shlex

# Characters harbor's own auth.json writer cannot survive: it interpolates the key into a
# shell heredoc, so `"` closes the JSON string and `\` starts an escape.
_UNESCAPABLE = '"\\\n\r'


AUTH_JSON_ENV_VAR = "RACCOON_CODEX_AUTH_JSON"


def auth_json_setup(key: str, remote_auth_path: str) -> tuple[dict[str, str], str]:
    """The one extra env var — returned separately so it reaches ONLY the setup exec — plus
    shell writing a parseable auth.json. Subshell: the umask must not outlive this write."""
    env = {AUTH_JSON_ENV_VAR: json.dumps({"OPENAI_API_KEY": key})}
    command = (
        f"(umask 077; printf '%s\\n' \"${AUTH_JSON_ENV_VAR}\" "
        f">{shlex.quote(remote_auth_path)})\n"
    )
    return env, command


def unescapable_chars(key: str) -> list[str]:
    """Which characters in `key` harbor's stock heredoc writer would corrupt — empty for
    every ordinary key, so the caller can refuse instead of 401ing three layers down."""
    return sorted({c for c in _UNESCAPABLE if c in key})
