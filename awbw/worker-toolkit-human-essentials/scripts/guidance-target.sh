#!/bin/bash
# guidance-target.sh — print the holistic-rubric file the grader reads for a task.
#
# The grader reads the task's holistic rubric under the Grading Standard.
# Detector skills call this resolver so they always assess the file the grader
# will actually read, and so the resolution rule lives in one place.
#
# Resolution order (renames are forward-only, so every generation stays readable):
#   tests/holistic-rubric.md                the current name; new tasks use it
#   tests/grader-guidance-consolidated.md   tasks created before the rename
#   tests/grader-guidance.md                legacy-generation tasks
# When none exists yet, the current name is printed — that is the file a new
# task's rubric will be written to.
#
# Usage:
#   bash scripts/guidance-target.sh <slug-or-task-dir>
#
# Output (one line): the path to the rubric file.
set -eu

arg="${1:?usage: bash scripts/guidance-target.sh <slug-or-task-dir>}"
dir="$arg"
[ -d "$dir" ] || dir="harbor-tasks/$arg"
tests="$dir/tests"
[ -d "$tests" ] || { echo "ERROR: no tests/ directory at $dir" >&2; exit 1; }

new="$tests/holistic-rubric.md"
old="$tests/grader-guidance-consolidated.md"
legacy="$tests/grader-guidance.md"

if [ -f "$new" ] && [ -f "$old" ]; then
    # Both names present: the grader's pick depends on the harness generation,
    # so an assessment of either could be an assessment of the wrong file.
    # Byte-identical copies are safe; anything else is a hard stop.
    if ! cmp -s "$new" "$old"; then
        echo "ERROR: $tests carries both holistic-rubric.md and grader-guidance-consolidated.md with different content — keep exactly one (tests/holistic-rubric.md is the current name)" >&2
        exit 1
    fi
    echo "$new"
elif [ -f "$new" ]; then
    echo "$new"
elif [ -f "$old" ]; then
    echo "$old"
elif [ -f "$legacy" ]; then
    echo "$legacy"
else
    echo "$new"
fi
