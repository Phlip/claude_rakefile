#!/usr/bin/env python3
"""render-rubric-grade.py — validate rubric-grade.json and derive reward + grade.md.

The rubric grader modes (test.sh GRADER_MODE=rubric-trinary | rubric-scalar) have
the grader agent score each atomic rubric criterion independently and write
/logs/verifier/rubric-grade.json. This script:

  1. validates the shape against the staged criteria manifest
     (tests/rubric-criteria.json): every expected criterion id exactly once,
     the form's field present (trinary: verdict pass|partial|fail;
     scalar: score 0.00-1.00 two decimals), non-empty rationales. The manifest
     also carries each criterion's severity; a manifest with more than
     2 criteria of severity 'crux' is rejected outright (hard cap),
  2. renders grade.md (per-criterion verdicts + rationales),
  3. derives reward.txt: the severity-weighted mean over criteria of value,
     where trinary maps pass=1.00 / partial=0.50 / fail=0.00 and scalar uses
     the score directly. Severity weights: crux=25 (Crux),
     certain_dealbreaker=5 (Critical), possible_dealbreaker=2 (Major),
     unlikely_dealbreaker=1 (Minor); dodged_bullet criteria are weighted by
     their severity like every other category. Criteria whose manifest
     category is extra_credit carry weight 1 and are included only when their
     value is > 0 (fulfilled extra credit joins the weighted mean; unfulfilled
     extra credit is excluded rather than penalized). A non-extra-credit
     criterion with a null/missing severity falls back to
     unlikely_dealbreaker (weight 1) with a warning on stderr,
  4. rewrites rubric-grade.json in normalized form (generator stamp).

Per-criterion verdicts are the primary artifact — the aggregate is one
documented reduction of them, and downstream analysis can re-aggregate from
the normalized JSON any other way. The grader itself never sees severity
(rubric-criteria.md carries guideline + elaboration only); weighting lives
entirely in this aggregation step.

Exit codes: 0 = ok; 2 = rubric-grade.json missing/unparseable/invalid, or the
criteria manifest is bad (including the >2 crux cap violation) — the caller
treats that grader sample as invalid. Never writes partial output.
Stdlib-only and Python 3.8-compatible on purpose: python3 is the only
interpreter guaranteed in every task image.

Usage:
  python3 render-rubric-grade.py --criteria tests/rubric-criteria.json \
      --form trinary [--rubric-json /logs/verifier/rubric-grade.json] \
      [--out-dir /logs/verifier]
"""

import argparse
import json
import os
import sys
from typing import Any, Dict, List

RENDER_RUBRIC_GRADE_VERSION = "render-rubric-grade/2.0.0"
SCHEMA_VERSION = 1

FORMS = ("trinary", "scalar")
VERDICT_CENTS = {"pass": 100, "partial": 50, "fail": 0}

# Severity tiers, highest first. The weighted mean uses these weights; the
# display names appear in grade.md's summary line.
SEVERITY_ORDER = ("crux", "certain_dealbreaker", "possible_dealbreaker", "unlikely_dealbreaker")
SEVERITY_WEIGHTS = {
    "crux": 25,
    "certain_dealbreaker": 5,
    "possible_dealbreaker": 2,
    "unlikely_dealbreaker": 1,
}
SEVERITY_DISPLAY = {
    "crux": "Crux",
    "certain_dealbreaker": "Critical",
    "possible_dealbreaker": "Major",
    "unlikely_dealbreaker": "Minor",
}
DEFAULT_SEVERITY = "unlikely_dealbreaker"
EXTRA_CREDIT_WEIGHT = 1
MAX_CRUX_CRITERIA = 2

WEIGHTS_NOTE = " / ".join(
    "%s %d" % (SEVERITY_DISPLAY[s], SEVERITY_WEIGHTS[s]) for s in SEVERITY_ORDER
)


class RubricValidationError(Exception):
    """A shape/content problem in rubric-grade.json. Message names the bad path."""


def _fail(path: str, message: str) -> None:
    raise RubricValidationError("%s: %s" % (path, message))


def _validate_text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        _fail(path, "must be a non-empty string")
    return value.strip()


def _validate_score_cents(value: Any, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "must be a number")
    if value < 0 or value > 1:
        _fail(path, "must be between 0 and 1")
    cents_float = value * 100
    cents = int(round(cents_float))
    if abs(cents_float - cents) >= 1e-6:
        _fail(path, "must have at most two decimal places")
    return cents


def load_criteria_manifest(path: str) -> List[Dict[str, Any]]:
    """Read the staged criteria manifest: {task, criteria: [{id, category, severity}]}.

    Resolves each criterion's aggregation weight from its severity
    (extra_credit is always weight 1; a null/missing severity on any other
    category falls back to unlikely_dealbreaker weight 1 with a stderr
    warning). Rejects a manifest carrying more than MAX_CRUX_CRITERIA
    criteria of severity 'crux'.
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict) or not isinstance(raw.get("criteria"), list):
        raise RubricValidationError(
            "%s: must be an object with a 'criteria' array" % path
        )
    out = []
    seen = set()
    for i, entry in enumerate(raw["criteria"]):
        where = "%s: criteria[%d]" % (path, i)
        if not isinstance(entry, dict):
            raise RubricValidationError(where + ": must be an object")
        cid = entry.get("id")
        category = entry.get("category")
        severity = entry.get("severity")
        if not isinstance(cid, str) or not cid:
            raise RubricValidationError(where + ".id: must be a non-empty string")
        if not isinstance(category, str) or not category:
            raise RubricValidationError(where + ".category: must be a non-empty string")
        if severity is not None and not isinstance(severity, str):
            raise RubricValidationError(where + ".severity: must be a string or null")
        if cid in seen:
            raise RubricValidationError(where + ": duplicate id %r" % cid)
        seen.add(cid)
        if category == "extra_credit":
            weight = EXTRA_CREDIT_WEIGHT
        elif severity in SEVERITY_WEIGHTS:
            weight = SEVERITY_WEIGHTS[severity]
        else:
            if severity is None:
                reason = "has no severity"
            else:
                reason = "has unrecognized severity %r" % severity
            print(
                "render-rubric-grade: warning: criterion %r (%s) %s; "
                "treating as %s (weight %d)"
                % (cid, category, reason, DEFAULT_SEVERITY, SEVERITY_WEIGHTS[DEFAULT_SEVERITY]),
                file=sys.stderr,
            )
            weight = SEVERITY_WEIGHTS[DEFAULT_SEVERITY]
        out.append({"id": cid, "category": category, "severity": severity, "weight": weight})
    if not out:
        raise RubricValidationError("%s: criteria array is empty" % path)
    crux_ids = [c["id"] for c in out if c["severity"] == "crux"]
    if len(crux_ids) > MAX_CRUX_CRITERIA:
        raise RubricValidationError(
            "%s: %d criteria carry severity 'crux' (%s) — hard cap is %d per task"
            % (path, len(crux_ids), ", ".join(crux_ids), MAX_CRUX_CRITERIA)
        )
    return out


def validate_rubric_grade(raw: Any, form: str, expected: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Validate the grader's rubric-grade.json; return normalized entries by id."""
    if not isinstance(raw, dict):
        _fail("$", "top level must be a JSON object")
    for key in raw:
        if key not in ("schema_version", "criteria", "closing", "generator"):
            _fail("$", "unknown key %r" % key)

    version = raw.get("schema_version")
    if version != SCHEMA_VERSION or isinstance(version, bool):
        _fail("$.schema_version", "must be %d" % SCHEMA_VERSION)

    entries_raw = raw.get("criteria")
    if not isinstance(entries_raw, list):
        _fail("$.criteria", "must be an array")

    value_key = "verdict" if form == "trinary" else "score"
    forbidden_key = "score" if form == "trinary" else "verdict"

    by_id: Dict[str, Dict[str, Any]] = {}
    for i, entry in enumerate(entries_raw):
        path = "$.criteria[%d]" % i
        if not isinstance(entry, dict):
            _fail(path, "must be an object")
        for key in entry:
            if key not in ("id", value_key, "rationale"):
                if key == forbidden_key:
                    _fail(
                        path,
                        "%r does not belong in %s form output (use %r)"
                        % (forbidden_key, form, value_key),
                    )
                _fail(path, "unknown key %r" % key)
        cid = entry.get("id")
        if not isinstance(cid, str) or not cid:
            _fail(path + ".id", "must be a non-empty string")
        if cid in by_id:
            _fail(path + ".id", "duplicate criterion id %r" % cid)
        rationale = _validate_text(entry.get("rationale"), path + ".rationale")

        if form == "trinary":
            verdict = entry.get(value_key)
            if verdict not in VERDICT_CENTS:
                _fail(path + ".verdict", "must be one of 'pass', 'partial', 'fail'")
            cents = VERDICT_CENTS[verdict]
            normalized = {"id": cid, "verdict": verdict, "rationale": rationale}
        else:
            if value_key not in entry:
                _fail(path, "missing required key 'score'")
            cents = _validate_score_cents(entry.get(value_key), path + ".score")
            normalized = {"id": cid, "score": entry.get(value_key), "rationale": rationale}
        normalized["_cents"] = cents
        by_id[cid] = normalized

    expected_ids = [c["id"] for c in expected]
    missing = [cid for cid in expected_ids if cid not in by_id]
    unknown = [cid for cid in by_id if cid not in set(expected_ids)]
    if missing:
        _fail("$.criteria", "missing criterion id(s): %s" % ", ".join(sorted(missing)))
    if unknown:
        _fail("$.criteria", "unknown criterion id(s): %s" % ", ".join(sorted(unknown)))

    closing = raw.get("closing")
    if closing is not None:
        closing = _validate_text(closing, "$.closing")

    return {"by_id": by_id, "closing": closing}


def _round_half_up(p: int, q: int) -> int:
    """round_half_up(p/q) for q > 0, p >= 0 — exact integer arithmetic."""
    return (2 * p + q) // (2 * q)


def aggregate(grade: Dict[str, Any], expected: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Severity-weighted mean over criteria in cents.

    reward_cents = round_half_up(sum(weight_i * cents_i) / sum(weight_i))
    over included criteria. extra_credit (weight 1) is included only when its
    value is > 0; every other criterion is always included at its severity
    weight.
    """
    weighted_cents = 0
    total_weight = 0
    n_included = 0
    excluded_extra_credit = 0
    for criterion in expected:
        entry = grade["by_id"][criterion["id"]]
        if criterion["category"] == "extra_credit" and entry["_cents"] == 0:
            excluded_extra_credit += 1
            continue
        n_included += 1
        weighted_cents += criterion["weight"] * entry["_cents"]
        total_weight += criterion["weight"]
    if total_weight:
        reward_cents = _round_half_up(weighted_cents, total_weight)
    else:
        reward_cents = 0
    return {
        "n_included": n_included,
        "n_excluded_extra_credit": excluded_extra_credit,
        "total_weight": total_weight,
        "reward_cents": reward_cents,
    }


def _fmt(cents: int) -> str:
    return "%.2f" % (cents / 100.0)


def render_markdown(
    grade: Dict[str, Any],
    agg: Dict[str, Any],
    expected: List[Dict[str, Any]],
    form: str,
) -> str:
    excluded = agg["n_excluded_extra_credit"]
    detail = "severity-weighted mean over %d criteria; weights %s" % (
        agg["n_included"],
        WEIGHTS_NOTE,
    )
    if excluded:
        detail += "; %d unfulfilled extra-credit criteri%s excluded" % (
            excluded,
            "on" if excluded == 1 else "a",
        )
    sections = ["Rubric score (%s): %s (%s)" % (form, _fmt(agg["reward_cents"]), detail)]

    for criterion in expected:
        entry = grade["by_id"][criterion["id"]]
        if form == "trinary":
            shown = entry["verdict"].upper()
        else:
            shown = _fmt(entry["_cents"])
        label = criterion["id"]
        if criterion["category"] == "extra_credit":
            label += " (extra credit)"
        sections.append("## %s — %s\n\n%s" % (label, shown, entry["rationale"]))

    if grade["closing"]:
        sections.append("## Closing\n\n%s" % grade["closing"])

    return "\n\n".join(sections) + "\n"


def normalized_json(grade: Dict[str, Any], expected: List[Dict[str, Any]], form: str) -> str:
    def entry(cid: str) -> Dict[str, Any]:
        e = grade["by_id"][cid]
        out = {"id": e["id"], "rationale": e["rationale"]}
        if form == "trinary":
            out["verdict"] = e["verdict"]
        else:
            out["score"] = e["score"]
        return out

    out = {
        "schema_version": SCHEMA_VERSION,
        "form": form,
        "criteria": [entry(c["id"]) for c in expected],
        "closing": grade["closing"],
        "generator": {"kind": "grader", "version": RENDER_RUBRIC_GRADE_VERSION},
    }
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render grade.md + reward.txt from rubric-grade.json"
    )
    parser.add_argument("--rubric-json", default="/logs/verifier/rubric-grade.json")
    parser.add_argument("--criteria", required=True, help="staged rubric-criteria.json")
    parser.add_argument("--form", required=True, choices=FORMS)
    parser.add_argument("--out-dir", default="/logs/verifier")
    parser.add_argument("--version", action="version", version=RENDER_RUBRIC_GRADE_VERSION)
    args = parser.parse_args()

    try:
        expected = load_criteria_manifest(args.criteria)
    except (OSError, ValueError, RubricValidationError) as e:
        print("render-rubric-grade: bad criteria manifest: %s" % e, file=sys.stderr)
        return 2

    try:
        with open(args.rubric_json, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except OSError as e:
        print("render-rubric-grade: cannot read %s: %s" % (args.rubric_json, e), file=sys.stderr)
        return 2
    except ValueError as e:
        print(
            "render-rubric-grade: %s is not valid JSON: %s" % (args.rubric_json, e),
            file=sys.stderr,
        )
        return 2

    try:
        grade = validate_rubric_grade(raw, args.form, expected)
        agg = aggregate(grade, expected)
    except RubricValidationError as e:
        print("render-rubric-grade: invalid rubric-grade.json: %s" % e, file=sys.stderr)
        return 2

    markdown = render_markdown(grade, agg, expected, args.form)
    reward = _fmt(agg["reward_cents"])

    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, "grade.md"), "w", encoding="utf-8") as f:
        f.write(markdown)
    with open(os.path.join(args.out_dir, "reward.txt"), "w", encoding="utf-8") as f:
        f.write(reward + "\n")
    with open(os.path.join(args.out_dir, "rubric-grade.json"), "w", encoding="utf-8") as f:
        f.write(normalized_json(grade, expected, args.form))

    print(
        "render-rubric-grade: ok reward=%s form=%s criteria=%d excluded_extra_credit=%d total_weight=%d"
        % (reward, args.form, agg["n_included"], agg["n_excluded_extra_credit"], agg["total_weight"])
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
