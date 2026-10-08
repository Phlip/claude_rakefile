#!/usr/bin/env python3
"""validate_task_dir.py — say WHY harbor will not accept a task directory.

``harbor run -p <dir>`` silently reinterprets a directory that fails task
validation as a *dataset* of tasks, finds none inside, and dies with
``ValueError: Either datasets or tasks must be provided.`` — a message naming
neither the path nor the missing file. ``scripts/harbor-run`` calls this first so
the author reads "tests/test.sh is missing" instead.

Must run under HARBOR'S interpreter (its uv-tool venv), not any python3.11+: it
imports harbor to reuse ``Task.is_valid_dir``, the exact predicate the CLI
branches on, so the two cannot drift.

Usage: validate_task_dir.py <task-dir> [--disable-verification]
Prints ``verdict=valid`` or ``verdict=invalid`` on stdout; the reason goes to
stderr. Callers must gate on the stdout verdict, never on the exit code alone —
an interpreter that cannot run this file at all also exits non-zero.
Exit 0 = valid, 1 = invalid, 2 = the check could not run.
"""

import sys
from pathlib import Path


def reason(task_dir: Path, disable_verification: bool) -> str | None:
    """Return why harbor rejects task_dir, or None if it accepts it."""
    from harbor.models.task.config import TaskConfig
    from harbor.models.task.paths import TaskPaths
    from harbor.models.task.task import Task

    if Task.is_valid_dir(task_dir, disable_verification=disable_verification):
        return None

    paths = TaskPaths(task_dir)
    if not paths.config_path.exists():
        return f"{paths.config_path} is missing."
    if not paths.environment_dir.exists():
        return f"{paths.environment_dir} is missing."
    try:
        config = TaskConfig.model_validate_toml(paths.config_path.read_text())
    except Exception as exc:
        return f"{paths.config_path} does not parse as a task config: {exc}"

    # A stepped task carries no root instruction.md, so only the shape harbor
    # checks may be asserted here — hence steps first, root instruction last.
    if disable_verification:
        for step in config.steps or []:
            if not paths.step_dir(step.name).exists():
                return f"{paths.step_dir(step.name)} is missing."
            if not paths.step_instruction_path(step.name).exists():
                return f"{paths.step_instruction_path(step.name)} is missing."
        if not config.steps and not paths.instruction_path.exists():
            return f"{paths.instruction_path} is missing."
    else:
        # Private, but it owns the instruction/test diagnostics is_valid_dir discards.
        try:
            Task._validate_tests(config, paths)
        except FileNotFoundError as exc:
            return str(exc)
        except AttributeError:
            pass
    return f"{task_dir} is not a task directory harbor recognizes."


def main() -> int:
    args = sys.argv[1:]
    disable_verification = "--disable-verification" in args
    positional = [a for a in args if not a.startswith("-")]
    if len(positional) != 1:
        print(
            f"usage: {sys.argv[0]} <task-dir> [--disable-verification]", file=sys.stderr
        )
        return 2
    try:
        why = reason(Path(positional[0]), disable_verification)
    except Exception as exc:
        print(f"validate_task_dir: check did not run ({exc})", file=sys.stderr)
        return 2
    if why is None:
        print("verdict=valid")
        return 0
    print("verdict=invalid")
    print(why, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
