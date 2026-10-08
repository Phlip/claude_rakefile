"""Shared browser-capability disclosure for the agent harnesses.

Only images for browser-facing repos ship Playwright, so the note is conditional on probing
the sandbox for the `pw` wrapper rather than on anything about the task. Probing keeps the
claim true by construction: telling an agent it has a browser it does not have sends it after
a missing binary. To check an image yourself: `command -v pw`.

Both harnesses disclose the same text through their own mechanism:
  - Claude Code: appended to --append-system-prompt (scripts/snapshot_agent.py)
  - codex:       -c developer_instructions=... (scripts/codex_agent.py), which prepends a
                 developer message and LEAVES codex's base instructions intact. Verified with
                 `codex debug prompt-input`. Do not switch to model_instructions_file — that
                 REPLACES the base instructions.

This module exists so the probe and the text live in one place; a copy in each adapter would
drift and the drift would be invisible (both would still run, just disclosing differently).
"""

from __future__ import annotations

import logging
from pathlib import Path

_log = logging.getLogger(__name__)

_NOTE_FILE = Path(__file__).resolve().parent / "toolset_note_browser.md"
_PROBE = "command -v pw >/dev/null 2>&1 && echo yes || echo no"


def browser_note() -> str:
    """The disclosure text, or "" if the note file is missing (never fatal)."""
    try:
        return _NOTE_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        _log.warning("%s missing; browser note omitted", _NOTE_FILE.name)
        return ""


async def probe_browser(environment) -> bool:
    """True when this image ships the `pw` wrapper. Best-effort: a failed probe means no
    note, never a failed run."""
    try:
        result = await environment.exec(command=_PROBE, timeout_sec=30)
    except Exception as exc:
        _log.warning("browser probe failed (%s); omitting the browser note", exc)
        return False
    # Exact tail match, not a substring: several harbor environments exec through a LOGIN
    # shell, whose profile scripts can print to stdout. A banner containing "yes" would
    # otherwise claim a browser that isn't there — the precise failure this module exists
    # to prevent.
    found = (getattr(result, "stdout", "") or "").strip().endswith("yes")
    _log.info("browser probe: pw %s", "present" if found else "absent")
    return found
