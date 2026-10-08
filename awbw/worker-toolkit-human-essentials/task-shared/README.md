# Shared task files

This directory contains the canonical copies of the files every Harbor task shares. They are **not automatically pulled in** by Harbor or any build system. Task scaffolding copies them into a task when the task is created, and a task's copies stay as created. A change here reaches new tasks through the next toolkit build.

## Files

| File                      | Copies to                              | Purpose                                                                             |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `Dockerfile`              | `<task>/environment/Dockerfile`        | Minimal container: debian + git + Claude Code                                       |
| `test.sh`                 | `<task>/tests/test.sh`                 | Verifier: launches Claude Code as grader agent                                      |
| `grader-system-prompt-consolidated.md` | `<task>/tests/grader-system-prompt-consolidated.md` | The grader system prompt. It embeds the Grading Standard; task-specific guidance is separate. |
| `render-grade-consolidated.py` | `<task>/tests/render-grade-consolidated.py` | Renders the grader's grade.json into reward.txt and grade.md                        |
| `grading-standard.md`     | *(read in place)*                      | The Grading Standard: the eight criteria the grader scores                          |
