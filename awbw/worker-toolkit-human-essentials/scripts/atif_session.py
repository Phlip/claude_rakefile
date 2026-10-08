"""Convert seed conversations between harness-native session formats, via ATIF.

Parsers turn a native session into ATIF; renderers turn ATIF back into a native
session. Adding a harness is one parser plus one renderer.

Renderers flatten tool calls to narration (`[ran Bash: {...}]` / `[result: ...]`)
rather than rebuilding native tool-call records. Every renderer must flatten
identically — see flatten_steps.
"""

from __future__ import annotations

import json
from typing import Any

ATIF_SCHEMA_VERSION = "ATIF-v1.7"

# Codex rollout record types, used to tell the formats apart.
_CODEX_ROLLOUT_TYPES = frozenset(
    {"session_meta", "response_item", "event_msg", "turn_context", "compacted"}
)


# ---------------------------------------------------------------------------
# Format detection
# ---------------------------------------------------------------------------


def detect_format(text: str) -> str | None:
    """Return 'atif', 'claude', 'codex', or None for an unrecognised/empty blob."""
    stripped = text.strip()
    if not stripped:
        return None

    # ATIF is a single JSON object, not JSONL.
    if stripped.startswith("{") and '"steps"' in stripped:
        try:
            doc = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            doc = None
        if isinstance(doc, dict) and isinstance(doc.get("steps"), list):
            return "atif"

    for raw in stripped.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("type") in _CODEX_ROLLOUT_TYPES and "message" not in rec:
            return "codex"
        if rec.get("type") in ("user", "assistant") or "message" in rec:
            return "claude"
    return None


# ---------------------------------------------------------------------------
# ATIF construction helpers
# ---------------------------------------------------------------------------


def _trajectory(steps: list[dict], *, session_id: str | None = None) -> dict:
    return {
        "schema_version": ATIF_SCHEMA_VERSION,
        "session_id": session_id,
        "agent": {"name": "unknown"},
        "steps": steps,
    }


def _step(
    step_id: int,
    source: str,
    *,
    message: str = "",
    reasoning: str | None = None,
    tool_calls: list[dict] | None = None,
    observations: list[dict] | None = None,
    timestamp: str | None = None,
) -> dict:
    step: dict[str, Any] = {
        "step_id": step_id,
        "source": source,
        "message": message,
        "is_copied_context": True,
    }
    if timestamp:
        step["timestamp"] = timestamp
    if reasoning:
        step["reasoning_content"] = reasoning
    if tool_calls:
        step["tool_calls"] = tool_calls
    if observations:
        step["observation"] = {"results": observations}
    return step


def _content_text(content: Any) -> str:
    """Text of an ATIF message or a ContentPart list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text") or "" for part in content if isinstance(part, dict)
        )
    return ""


# ---------------------------------------------------------------------------
# Parsers: native -> ATIF
# ---------------------------------------------------------------------------


def claude_session_to_atif(jsonl_text: str) -> dict:
    """Parse a Claude Code session.jsonl into ATIF steps.

    Claude records tool results on `user` records; they become observations.
    """
    steps: list[dict] = []
    session_id: str | None = None

    for raw in jsonl_text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        session_id = session_id or rec.get("sessionId")

        msg = rec.get("message") or {}
        role = msg.get("role") or rec.get("type")
        if role not in ("user", "assistant"):
            continue
        content = msg.get("content")
        if content is None:
            continue

        source = "user" if role == "user" else "agent"
        if isinstance(content, str):
            steps.append(
                _step(
                    len(steps) + 1, source, message=content, timestamp=rec.get("timestamp")
                )
            )
            continue

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls: list[dict] = []
        observations: list[dict] = []
        for block in content:
            if not isinstance(block, dict):
                text_parts.append(str(block))
                continue
            btype = block.get("type")
            if btype == "text":
                text_parts.append(block.get("text") or "")
            elif btype == "thinking":
                reasoning_parts.append(block.get("thinking") or "")
            elif btype == "tool_use":
                tool_calls.append(
                    {
                        "tool_call_id": block.get("id") or f"call_{len(tool_calls) + 1}",
                        "function_name": block.get("name") or "tool",
                        "arguments": block.get("input") or {},
                    }
                )
            elif btype == "tool_result":
                observations.append(
                    {
                        "source_call_id": block.get("tool_use_id"),
                        "content": _content_text(block.get("content")),
                    }
                )

        steps.append(
            _step(
                len(steps) + 1,
                source,
                message="".join(text_parts),
                reasoning="".join(reasoning_parts) or None,
                tool_calls=tool_calls or None,
                observations=observations or None,
                timestamp=rec.get("timestamp"),
            )
        )

    return _trajectory(steps, session_id=session_id)


def codex_rollout_to_atif(jsonl_text: str) -> dict:
    """Parse a codex rollout JSONL into ATIF steps."""
    steps: list[dict] = []
    session_id: str | None = None

    for raw in jsonl_text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue

        rtype = rec.get("type")
        payload = rec.get("payload") or {}
        if rtype == "session_meta":
            session_id = session_id or payload.get("id")
            continue
        if rtype != "response_item":
            continue

        ptype = payload.get("type")
        timestamp = rec.get("timestamp")

        if ptype == "message":
            role = payload.get("role")
            if role not in ("user", "assistant"):
                continue
            steps.append(
                _step(
                    len(steps) + 1,
                    "user" if role == "user" else "agent",
                    message=_content_text(payload.get("content")),
                    timestamp=timestamp,
                )
            )
        elif ptype in ("function_call", "local_shell_call", "custom_tool_call"):
            arguments = payload.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except (json.JSONDecodeError, ValueError):
                    arguments = {"raw": arguments}
            steps.append(
                _step(
                    len(steps) + 1,
                    "agent",
                    tool_calls=[
                        {
                            "tool_call_id": payload.get("call_id") or f"call_{len(steps)}",
                            "function_name": payload.get("name") or "tool",
                            "arguments": arguments or {},
                        }
                    ],
                    timestamp=timestamp,
                )
            )
        elif ptype in ("function_call_output", "custom_tool_call_output"):
            output = payload.get("output")
            if isinstance(output, dict):
                output = output.get("content") or json.dumps(output, ensure_ascii=False)
            steps.append(
                _step(
                    len(steps) + 1,
                    "agent",
                    observations=[
                        {
                            "source_call_id": payload.get("call_id"),
                            "content": output if isinstance(output, str) else "",
                        }
                    ],
                    timestamp=timestamp,
                )
            )
        elif ptype == "reasoning":
            summary = payload.get("summary")
            text = ""
            if isinstance(summary, list):
                text = "".join(
                    s.get("text") or "" for s in summary if isinstance(s, dict)
                )
            if text:
                steps.append(_step(len(steps) + 1, "agent", reasoning=text, timestamp=timestamp))

    return _trajectory(steps, session_id=session_id)


def to_atif(text: str) -> dict:
    """Parse whichever native format `text` is into ATIF."""
    fmt = detect_format(text)
    if fmt == "atif":
        return json.loads(text)
    if fmt == "claude":
        return claude_session_to_atif(text)
    if fmt == "codex":
        return codex_rollout_to_atif(text)
    raise ValueError("unrecognised session format (not ATIF, Claude JSONL, or codex rollout)")


# ---------------------------------------------------------------------------
# Flattening — shared by every renderer so the loss stays symmetric
# ---------------------------------------------------------------------------


def flatten_steps(atif: dict) -> list[tuple[str, str]]:
    """ATIF steps -> ordered (role, text) pairs, where role is 'user' or 'agent'.

    Tool calls and observations become agent narration; `reasoning_content` is dropped.
    """
    out: list[tuple[str, str]] = []
    for step in atif.get("steps") or []:
        if not isinstance(step, dict):
            continue
        role = "user" if step.get("source") == "user" else "agent"

        text = _content_text(step.get("message"))
        if text:
            out.append((role, text))

        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            args = json.dumps(call.get("arguments") or {}, ensure_ascii=False)
            out.append(("agent", f"[ran {call.get('function_name') or 'tool'}: {args}]"))

        observation = step.get("observation") or {}
        for result in observation.get("results") or []:
            if not isinstance(result, dict):
                continue
            out.append(("agent", f"[result: {_content_text(result.get('content'))}]"))

    return out


# ---------------------------------------------------------------------------
# Renderers: ATIF -> native
# ---------------------------------------------------------------------------


def atif_to_codex_rollout(
    atif: dict,
    iso_ts: str,
    *,
    session_meta: dict,
    max_total: int | None = None,
) -> list[str]:
    """Render ATIF as codex rollout JSONL that `codex exec resume` can continue.

    `session_meta` is supplied by the caller so this module reads no files.
    """
    lines = [json.dumps(session_meta)]
    budget = float("inf") if max_total is None else max_total

    for role, text in flatten_steps(atif):
        text = (text or "").strip()
        if not text or budget <= 0:
            continue
        text = text[: int(min(budget, len(text)))]
        ctype = "input_text" if role == "user" else "output_text"
        lines.append(
            json.dumps(
                {
                    "timestamp": iso_ts,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user" if role == "user" else "assistant",
                        "content": [{"type": ctype, "text": text}],
                    },
                }
            )
        )
        budget -= len(text)

    return lines


def atif_to_claude_session(
    atif: dict,
    *,
    session_id: str,
    cwd: str = "/workspace",
    git_branch: str = "main",
    version: str = "2.1.87",
    iso_ts: str,
    max_total: int | None = None,
) -> list[str]:
    """Render ATIF as Claude Code session.jsonl that `claude --resume` can continue.

    Records are chained by parentUuid: Claude resumes by walking that chain, not by
    file order.
    """
    lines: list[str] = []
    parent_uuid: str | None = None
    budget = float("inf") if max_total is None else max_total

    for index, (role, text) in enumerate(flatten_steps(atif), start=1):
        text = (text or "").strip()
        if not text or budget <= 0:
            continue
        text = text[: int(min(budget, len(text)))]
        uuid = _deterministic_uuid(session_id, index)
        claude_role = "user" if role == "user" else "assistant"
        record: dict[str, Any] = {
            "parentUuid": parent_uuid,
            "isSidechain": False,
            "userType": "external",
            "cwd": cwd,
            "sessionId": session_id,
            "version": version,
            "gitBranch": git_branch,
            "type": claude_role,
            "uuid": uuid,
            "timestamp": iso_ts,
        }
        if claude_role == "user":
            record["message"] = {"role": "user", "content": text}
        else:
            record["message"] = {
                "role": "assistant",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
            }
        lines.append(json.dumps(record))
        parent_uuid = uuid
        budget -= len(text)

    return lines


def _deterministic_uuid(session_id: str, index: int) -> str:
    """A stable uuid5 per (session, position), so re-rendering is byte-identical."""
    import uuid as _uuid

    return str(_uuid.uuid5(_uuid.NAMESPACE_URL, f"raccoon-seed/{session_id}/{index}"))
