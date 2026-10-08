"""Pure (no-harbor) helpers for inspecting a captured reference run.

Kept separate from ``replay_agent.py`` (which imports ``harbor``) so this logic
can be unit-tested with the plain devcontainer Python and shipped in the worker
toolkit alongside the replay agent.

The one safety-critical helper here is :func:`captured_mutating_tools`: it tells
the replay agent whether a run with no ``agent-output/`` is a harmless advisory
run (the agent only read + answered in chat) or a genuine capture loss (the
agent edited files but they weren't preserved). The replay agent grades the
former from the captured transcript and refuses the latter.

Structured edit tools (``Write``/``Edit``/``MultiEdit``/``NotebookEdit``) are
obvious. ``Bash`` is the subtle one: a shell call can mutate the workspace
(``rm``, ``mv``, ``sed -i``, ``echo … > f`` …) just as easily as it can read it.
So a ``Bash`` call is treated as **potentially mutating unless the command is
verifiably read-only** (:func:`bash_mutates`) — the safe direction: an unknown
command counts as a mutation, so we never silently grade a run that lost edits.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Structured tools that always mutate the workspace.
MUTATING_TOOLS = frozenset({"Write", "Edit", "MultiEdit", "NotebookEdit"})

# Base commands that only read (or touch non-workspace state like cwd). Anything
# NOT here — or any file-writing redirection, or `sed -i`, or a non-read-only git
# subcommand — is treated as potentially mutating.
_READONLY_BASH = frozenset({
    "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "find",
    "fd", "wc", "echo", "printf", "file", "stat", "pwd", "tree", "sort", "uniq",
    "cut", "tr", "awk", "jq", "yq", "less", "more", "diff", "cmp", "basename",
    "dirname", "realpath", "readlink", "true", "false", "test", "[", "date",
    "env", "printenv", "which", "type", "command", "column", "nl", "od", "xxd",
    "hexdump", "comm", "paste", "fold", "expand", "tac", "du", "df", "seq",
    "sleep", ":", "cd", "pushd", "popd", "dirs", "whoami", "hostname", "uname",
    "id", "cksum", "md5sum", "sha1sum", "sha256sum", "strings", "wc",
})
# git subcommands that don't write the repo/workspace.
_READONLY_GIT_SUB = frozenset({
    "log", "diff", "status", "show", "blame", "grep", "ls-files", "ls-tree",
    "cat-file", "rev-parse", "describe", "shortlog", "reflog", "rev-list",
    "for-each-ref", "name-rev", "symbolic-ref", "whatchanged", "var", "help",
    "show-ref", "merge-base", "cherry", "count-objects", "verify-pack",
})
# fd-dups (2>&1, >&2, 1>&-) and /dev/null sinks are harmless; strip them before
# looking for a real file-writing redirection.
_HARMLESS_REDIR = re.compile(r"[0-9&]*>>?\s*(?:&\s*[0-9-]+|/dev/null)")
# Split a command line into segments on shell separators + substitutions.
_SEG_SPLIT = re.compile(r"\|\||&&|[|;&\n]|\$\(|`")
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


def bash_mutates(command: str) -> bool:
    """Heuristic: does this shell command potentially write the workspace?

    Conservative by design — errs toward True (an unrecognized command, a
    file-writing redirect, `sed -i`, or a non-read-only git subcommand all count
    as mutating). Read-only exploration (ls/cat/grep/find/wc/… piped together,
    with `2>/dev/null` / `>/dev/null`) returns False."""
    if not command or not command.strip():
        return False
    # Drop fd-dups (2>&1) + /dev/null sinks up front, so they neither look like a
    # file write nor split a segment on their `&` (2>&1 → bogus "1" command).
    stripped = _HARMLESS_REDIR.sub(" ", command)
    # 1. Any remaining redirection now writes a real file.
    if ">" in stripped:
        return True
    # 2. The leading command of every segment must be read-only.
    for seg in _SEG_SPLIT.split(stripped):
        toks = seg.split()
        idx = 0
        while idx < len(toks) and _ASSIGN.match(toks[idx]):  # skip VAR=val prefixes
            idx += 1
        if idx >= len(toks):
            continue
        cmd = toks[idx].rsplit("/", 1)[-1]
        rest = toks[idx + 1:]
        if cmd == "sed" and any(t == "-i" or t.startswith("-i") for t in rest):
            return True
        if cmd == "git":
            sub = next((t for t in rest if not t.startswith("-")), "")
            if sub and sub not in _READONLY_GIT_SUB:
                return True
            continue
        if cmd and cmd not in _READONLY_BASH:
            return True
    return False


def _bash_command(call_args) -> str:
    if isinstance(call_args, dict):
        return str(call_args.get("command", "") or "")
    return ""


def _scan_trajectory(trajectory_path: Path) -> set[str]:
    """Mutating tool names in an ATIF agent/trajectory.json
    (steps[].tool_calls[].function_name; Bash inspected by command)."""
    found: set[str] = set()
    if not trajectory_path.exists():
        return found
    try:
        data = json.loads(trajectory_path.read_text())
    except (json.JSONDecodeError, OSError):
        return found
    for step in data.get("steps", []):
        for call in step.get("tool_calls") or []:
            name = call.get("function_name")
            if name in MUTATING_TOOLS:
                found.add(name)
            elif name == "Bash" and bash_mutates(_bash_command(call.get("arguments"))):
                found.add("Bash")
    return found


def _scan_stream_json(stream_path: Path) -> set[str]:
    """Mutating tool names in a raw stream-json claude-code.txt
    (one JSON object per line, message.content[].tool_use; Bash by input)."""
    found: set[str] = set()
    if not stream_path.exists():
        return found
    try:
        lines = stream_path.read_text(errors="ignore").splitlines()
    except OSError:
        return found
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        message = obj.get("message") if isinstance(obj, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                continue
            name = block.get("name")
            if name in MUTATING_TOOLS:
                found.add(name)
            elif name == "Bash" and bash_mutates(_bash_command(block.get("input"))):
                found.add("Bash")
    return found


def captured_mutating_tools(reference_run_dir: Path | str) -> set[str]:
    """Return the file-mutating tool names found in a captured run's transcript.

    Checks the ATIF ``agent/trajectory.json`` first, then falls back to the raw
    stream-json ``agent/claude-code.txt``, so a lossy/partial trajectory can't
    hide a real edit. ``Bash`` is included only when its command isn't verifiably
    read-only (see :func:`bash_mutates`). An empty result means the agent made no
    workspace edits — i.e. a missing ``agent-output/`` is an advisory no-op.
    """
    ref = Path(reference_run_dir)
    return _scan_trajectory(ref / "agent" / "trajectory.json") | _scan_stream_json(
        ref / "agent" / "claude-code.txt"
    )
