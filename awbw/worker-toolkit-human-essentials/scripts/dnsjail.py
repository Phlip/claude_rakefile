"""Apply the DNS jail to a trial container: the model endpoint resolves, nothing else does.

Opt-in with RACCOON_DNS_JAIL=1. Runs from the agent's own turn rather than from a compose
overlay — the allowlist comes from the proxy URL this process already holds (plus any hosts
RACCOON_DNS_JAIL_ALLOW adds), so nothing has to be injected into the container, and the jail works on every harbor backend. Deliberately
after agent-setup: a harness that downloads its CLI there still reaches the network to do it.
"""

import logging
import os
import shlex
from typing import Any

JAIL = "/usr/local/bin/raccoon-dns-jail"
_NO_SCRIPT = "raccoon-dns-jail: not in this image"

_URL_VARS = (
    "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL",
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
)

_EXTRA_VAR = "RACCOON_DNS_JAIL_ALLOW"

_log = logging.getLogger(__name__)


def _host(url: str) -> str:
    """Hostname out of a URL, or "" when it is not a plain hostname we can allow."""
    h = url.split("://", 1)[-1].split("/", 1)[0].rsplit("@", 1)[-1].split(":", 1)[0]
    if not h or h.startswith((".", "-")) or h.endswith(".") or not all(
        c.isascii() and (c.isalnum() or c in ".-") for c in h
    ):
        return ""
    # An IP-literal endpoint (a loopback proxy shim, say) needs no DNS at all, and a
    # --server rule for it would only be checked by a PTR query the catch-all answers.
    if all(part.isdigit() for part in h.split(".")):
        return ""
    return h


def dns_jail_allowlist() -> tuple[list[str], list[str]]:
    """(required, advisory).

    Required = the hosts this process's own env says the agent will dial; every one must
    resolve through the jail or no jail is applied, because a host the agent needs and
    cannot resolve is a dead trial. Advisory = whatever RACCOON_DNS_JAIL_ALLOW adds, which
    only warns: an added host that CNAMEs outside the allowlist cannot resolve through the
    catch-all, and must not take the whole jail down with it.
    """
    required: list[str] = []
    for var in _URL_VARS:
        h = _host(os.environ.get(var) or "")
        if h and h not in required:
            required.append(h)
    advisory: list[str] = []
    for entry in (os.environ.get(_EXTRA_VAR) or "").replace(",", " ").split():
        # Bare hostnames only: a URL silently truncated to its first path segment would
        # allow a name nobody asked for and block the one they meant.
        h = "" if ("/" in entry or ":" in entry) else _host(entry)
        if not h:
            _log.warning("DNS jail: ignoring unusable %s entry %r", _EXTRA_VAR, entry)
        elif h not in required and h not in advisory:
            advisory.append(h)
    return required, advisory


def dns_jail_enabled() -> bool:
    return os.environ.get("RACCOON_DNS_JAIL") == "1"


async def apply_dns_jail(agent: Any, environment: Any) -> None:
    """No-op unless enabled; leaves the container's DNS untouched on any doubt."""
    if not dns_jail_enabled():
        return
    required, advisory = dns_jail_allowlist()
    allow = " ".join(required)
    # A blank allowlist means no model endpoint was found: jailing would strand the agent.
    if not allow:
        _log.warning("DNS jail: no usable model endpoint — the trial keeps normal network access")
        return
    try:
        result = await agent.exec_as_root(
            environment,
            command=(
                f"if [ -x {JAIL} ]; then DNSJAIL_ALLOW={shlex.quote(allow)} "
                f"DNSJAIL_ALLOW_EXTRA={shlex.quote(' '.join(advisory))} {JAIL}; "
                f'else echo "{_NO_SCRIPT}"; fi'
            ),
        )
    except Exception as exc:  # a jail that cannot be applied must not fail the trial
        _log.warning("DNS jail: could not apply (%s) — the trial keeps normal network access", exc)
        return
    # An image frozen before this feature has nothing to invoke. Say so: a launcher that
    # believes the network is restricted when it is not is worse than no jail at all.
    if _NO_SCRIPT in (getattr(result, "stdout", "") or ""):
        _log.warning(
            "DNS jail: this task's image ships no resolver — the trial keeps normal network access"
        )
