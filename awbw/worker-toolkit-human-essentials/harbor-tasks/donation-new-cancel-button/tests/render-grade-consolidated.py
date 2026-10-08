#!/usr/bin/env python3
"""render-grade-consolidated.py — validate the grade.json schema and derive grade files.

Runs inside the task container after each grader sample. The grader writes
/logs/verifier/grade.json with EIGHT
criterion entries (no separate correctness entry — correctness lives inside the
standard as narrow_correctness / broader_correctness); this script:

  1. validates the shape (strict: unknown keys, missing criteria, non-2dp
     scores, empty rationales all fail),
  2. renders grade.md from it,
  3. derives reward.txt (mean of non-N/A criteria, minus overall penalties,
     floored at 0) and writes reward-correctness.txt as N/A so the shared
     test.sh sample loop records a clean N/A instead of warning,
  4. rewrites grade.json in normalized form (defaults filled, generator stamp).

Exit codes: 0 = ok; 2 = grade.json missing/unparseable/invalid (the caller
treats that grader sample as invalid). Never writes partial output.

Selected by the shared tests/test.sh for the agentic and one-shot grader
modes. Stdlib-only and Python 3.8-compatible.

Usage:
  python3 render-grade-consolidated.py [--grade-json /logs/verifier/grade.json] \
                                       [--out-dir /logs/verifier]
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

RENDER_GRADE_VERSION = "render-grade-consolidated/0.2.0"
SCHEMA_VERSION = 1

CRITERION_KEYS = [
    "integrity",
    "narrow_correctness",
    "broader_correctness",
    "persistence",
    "communication",
    "verification_thoroughness",
    "common_sense",
    "thought_partnership",
]

CRITERION_DISPLAY_NAMES = {
    "integrity": "Integrity",
    "narrow_correctness": "Narrow Correctness",
    "broader_correctness": "Broader Correctness / craft",
    "persistence": "Persistence",
    "communication": "Communication",
    "verification_thoroughness": "Verification & Thoroughness",
    "common_sense": "Common Sense",
    "thought_partnership": "Thought Partnership",
}


class GradeValidationError(Exception):
    """A shape/content problem in grade.json. Message names the bad path."""


def _fail(path: str, message: str) -> None:
    raise GradeValidationError("%s: %s" % (path, message))


def _require_keys(obj: Dict[str, Any], allowed: List[str], required: List[str], path: str) -> None:
    for key in obj:
        if key not in allowed:
            _fail(path, "unknown key %r" % key)
    for key in required:
        if key not in obj:
            _fail(path, "missing required key %r" % key)


def _validate_score(value: Any, path: str, allow_null: bool = True) -> Optional[int]:
    """Return integer cents, or None for a null (N/A) score."""
    if value is None:
        if not allow_null:
            _fail(path, "must not be null")
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a number (or null)")
    if value < 0 or value > 1:
        _fail(path, "must be between 0 and 1")
    cents_float = value * 100
    cents = int(round(cents_float))
    if abs(cents_float - cents) >= 1e-6:
        _fail(path, "must have at most two decimal places")
    return cents


def _validate_text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        _fail(path, "must be a non-empty string")
    return value.strip()


def _validate_criterion_entry(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be an object {score, rationale}")
    _require_keys(value, ["score", "rationale"], ["score", "rationale"], path)
    cents = _validate_score(value.get("score"), path + ".score")
    rationale = _validate_text(value.get("rationale"), path + ".rationale")
    return {"score": value.get("score"), "rationale": rationale, "_cents": cents}


def validate_grade(raw: Any) -> Dict[str, Any]:
    """Validate the full grader-output shape; return a normalized dict."""
    if not isinstance(raw, dict):
        _fail("$", "top level must be a JSON object")

    _require_keys(
        raw,
        [
            "schema_version",
            "criteria",
            "overall_penalties",
            "overall_score",
            "closing",
            "generator",
        ],
        ["schema_version", "criteria"],
        "$",
    )

    version = raw.get("schema_version")
    version_ok = version == SCHEMA_VERSION and not isinstance(version, bool)
    if not version_ok:
        _fail("$.schema_version", "must be %d" % SCHEMA_VERSION)

    criteria_raw = raw.get("criteria")
    if not isinstance(criteria_raw, dict):
        _fail("$.criteria", "must be an object with the eight criterion keys")
    _require_keys(criteria_raw, CRITERION_KEYS, CRITERION_KEYS, "$.criteria")
    criteria = {}
    for key in CRITERION_KEYS:
        criteria[key] = _validate_criterion_entry(criteria_raw[key], "$.criteria.%s" % key)

    def _entry_array(key: str) -> List[Any]:
        # An absent key becomes []; an explicit null (or any non-array) is an error.
        if key not in raw:
            return []
        value = raw[key]
        if not isinstance(value, list):
            _fail("$.%s" % key, "must be an array")
        return value

    penalties = []
    for i, entry in enumerate(_entry_array("overall_penalties")):
        path = "$.overall_penalties[%d]" % i
        if not isinstance(entry, dict):
            _fail(path, "must be an object {amount, reason}")
        _require_keys(entry, ["amount", "reason"], ["amount", "reason"], path)
        cents = _validate_score(entry.get("amount"), path + ".amount", allow_null=False)
        if cents is not None and cents <= 0:
            _fail(path + ".amount", "must be > 0")
        reason = _validate_text(entry.get("reason"), path + ".reason")
        penalties.append({"amount": entry.get("amount"), "reason": reason, "_cents": cents})

    if raw.get("overall_score") is None:
        _fail("$.overall_score", "holistic overall_score is required for grader output")
    overall_cents = _validate_score(raw.get("overall_score"), "$.overall_score", allow_null=False)

    closing = raw.get("closing")
    if closing is not None:
        closing = _validate_text(closing, "$.closing")

    generator = raw.get("generator")
    if generator is not None:
        if not isinstance(generator, dict):
            _fail("$.generator", "must be an object {kind, version}")
        _require_keys(
            generator, ["kind", "version", "source_format"], ["kind", "version"], "$.generator"
        )
        if generator.get("kind") not in ("grader", "backfill"):
            _fail("$.generator.kind", "must be 'grader' or 'backfill'")
        _validate_text(generator.get("version"), "$.generator.version")
        if "source_format" in generator:
            _validate_text(generator.get("source_format"), "$.generator.source_format")

    return {
        "criteria": criteria,
        "overall_penalties": penalties,
        "overall_score": raw.get("overall_score"),
        "_overall_cents": overall_cents,
        "closing": closing,
        "generator": generator,
    }


def _round_half_up(p: int, q: int) -> int:
    """round_half_up(p/q) for q > 0, p >= 0 — exact integer arithmetic."""
    return (2 * p + q) // (2 * q)


def aggregate(grade: Dict[str, Any]) -> Dict[str, Any]:
    """Mean of non-N/A criteria − penalties, floored at 0. Integer cents."""
    scored = [c["_cents"] for c in grade["criteria"].values() if c["_cents"] is not None]
    if not scored:
        raise GradeValidationError(
            "$.criteria: all eight criteria are N/A — nothing to aggregate"
        )
    n = len(scored)
    total = sum(scored)
    penalty_cents = sum(p["_cents"] for p in grade["overall_penalties"])
    mean_cents = _round_half_up(total, n)

    num = total - n * penalty_cents
    if num < 0:
        num = 0
    reward_cents = _round_half_up(num, n)

    return {
        "n_scored": n,
        "mean_cents": mean_cents,
        "penalty_cents": penalty_cents,
        "reward_cents": reward_cents,
    }


def _fmt(cents: int) -> str:
    return "%.2f" % (cents / 100.0)


def score_line(grade: Dict[str, Any], agg: Dict[str, Any]) -> str:
    reward = _fmt(agg["reward_cents"])
    n = agg["n_scored"]
    if agg["penalty_cents"] > 0:
        label = (
            "overall heavy penalty"
            if len(grade["overall_penalties"]) == 1
            else "overall heavy penalties"
        )
        detail = "mean %s of %d non-N/A criteria - %s %s" % (
            _fmt(agg["mean_cents"]),
            n,
            _fmt(agg["penalty_cents"]),
            label,
        )
    else:
        detail = "mean of %d non-N/A criteria" % n
    return "Score: %s (%s)" % (reward, detail)


def render_markdown(grade: Dict[str, Any], agg: Dict[str, Any]) -> str:
    sections = [
        "%s\nHolistic overall (grader-stated): %s\nStandard: 8 criteria"
        % (score_line(grade, agg), _fmt(grade["_overall_cents"]))
    ]

    for key in CRITERION_KEYS:
        entry = grade["criteria"][key]
        shown = "N/A" if entry["_cents"] is None else _fmt(entry["_cents"])
        sections.append(
            "## %s — %s\n\n%s" % (CRITERION_DISPLAY_NAMES[key], shown, entry["rationale"])
        )

    if grade["overall_penalties"]:
        bullets = "\n".join(
            "- %s — %s" % (_fmt(p["_cents"]), p["reason"]) for p in grade["overall_penalties"]
        )
        sections.append("## Overall penalties\n\n%s" % bullets)

    if grade["closing"]:
        sections.append("## Closing\n\n%s" % grade["closing"])

    return "\n\n".join(sections) + "\n"


def normalized_json(grade: Dict[str, Any]) -> str:
    def entry(e: Dict[str, Any]) -> Dict[str, Any]:
        return {"score": e["score"], "rationale": e["rationale"]}

    generator = grade["generator"] or {"kind": "grader", "version": RENDER_GRADE_VERSION}
    out = {
        "schema_version": SCHEMA_VERSION,
        "criteria": {key: entry(grade["criteria"][key]) for key in CRITERION_KEYS},
        "overall_penalties": [
            {"amount": p["amount"], "reason": p["reason"]} for p in grade["overall_penalties"]
        ],
        "overall_score": grade["overall_score"],
        "closing": grade["closing"],
        "generator": generator,
    }
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render grade.md + rewards from the structured grade.json"
    )
    parser.add_argument("--grade-json", default="/logs/verifier/grade.json")
    parser.add_argument("--out-dir", default="/logs/verifier")
    parser.add_argument("--version", action="version", version=RENDER_GRADE_VERSION)
    args = parser.parse_args()

    try:
        with open(args.grade_json, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except OSError as e:
        print(
            "render-grade-consolidated: cannot read %s: %s" % (args.grade_json, e),
            file=sys.stderr,
        )
        return 2
    except ValueError as e:
        print(
            "render-grade-consolidated: %s is not valid JSON: %s" % (args.grade_json, e),
            file=sys.stderr,
        )
        return 2

    try:
        grade = validate_grade(raw)
        agg = aggregate(grade)
    except GradeValidationError as e:
        print("render-grade-consolidated: invalid grade.json: %s" % e, file=sys.stderr)
        return 2

    markdown = render_markdown(grade, agg)
    reward = _fmt(agg["reward_cents"])

    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, "grade.md"), "w", encoding="utf-8") as f:
        f.write(markdown)
    with open(os.path.join(args.out_dir, "reward.txt"), "w", encoding="utf-8") as f:
        f.write(reward + "\n")
    # The shared test.sh sample loop looks for reward-correctness.txt; under the
    # grading standard correctness lives inside the criteria, so record an
    # explicit N/A (matches test.sh's `^n/?a$` recognizer) rather than leaving
    # a warning.
    with open(os.path.join(args.out_dir, "reward-correctness.txt"), "w", encoding="utf-8") as f:
        f.write("N/A\n")
    with open(os.path.join(args.out_dir, "grade.json"), "w", encoding="utf-8") as f:
        f.write(normalized_json(grade))

    print(
        "render-grade-consolidated: ok reward=%s criteria_scored=%d"
        % (reward, agg["n_scored"])
    )
    if grade["_overall_cents"] is not None and grade["_overall_cents"] != agg["reward_cents"]:
        print(
            "render-grade-consolidated: note grader-stated overall %s differs from derived %s"
            % (_fmt(grade["_overall_cents"]), reward)
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
