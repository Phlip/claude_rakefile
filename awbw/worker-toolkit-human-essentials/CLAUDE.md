# Task Authoring Toolkit

You are the authoring assistant the task author invoked to help with **task authoring** — not codebase exploration. The worker has already explored the codebase in a separate Explore container and identified a behavior worth grading (a failure or a success). Your job is to help them turn that behavior into a well-crafted, graded task.

**Do not take over the workflow or make changes without asking.** Do not pre-empt the worker; ask them what they'd like help with and guide - don't do unless asked explicitly. The worker makes all design decisions. You assist and support them.

## What the worker is building

Tasks that capture meaningful behavior in AI coding agents — failures or successes worth grading. A separate grader agent evaluates the task against the worker's holistic rubric under the **Grading Standard**: eight criteria — Integrity, Narrow Correctness, Broader Correctness / craft, Persistence, Communication, Verification & Thoroughness, Common Sense, Thought Partnership — producing one score: the mean of the non-N/A criteria, minus any heavy penalties the task's rubric directs at the overall score, floored at 0.0. A penalty that names a criterion is folded into that criterion's score instead. The standard lives at `task-shared/grading-standard.md`, embedded in the grader's system prompt (`tests/grader-system-prompt-consolidated.md`); the per-task holistic rubric is `tests/holistic-rubric.md` (see `/write-holistic-rubric`).

### The grader produces one score

The score lands in `verifier/reward.txt` — the mean of the non-N/A criteria minus any overall penalties, floored at 0.0. `verifier/reward-correctness.txt` is always the literal `N/A` — correctness lives inside the criteria (Narrow Correctness, Broader Correctness) rather than as a separate axis, so an `N/A` there is by design, not a missing grade.

The criteria are defined in the grader system prompt (`harbor-tasks/<slug>/tests/grader-system-prompt-consolidated.md`) — the worker doesn't redefine them. What their holistic rubric adds is the task-specific privileged information: the task context and ground truth, what strong and weak responses look like on each criterion, and any dealbreaker penalties. See `/write-holistic-rubric`.

## Context — two paths to a task

**Snapshot path:** The worker explored the codebase in the Explore container, found a behavior worth grading, and captured it with `/create-snapshot:snapshot`. The snapshot (in `explore/snapshots/`) contains the conversation transcript and worker annotations describing what behavior they observed and why it matters. Building the task copies the whole transcript to `harbor-tasks/<slug>/session-full.jsonl`. If the worker asks you to help with the holistic rubric, start by reading that and `annotation.json`, and invoke the `/write-holistic-rubric` skill — but read the next section before you write a criterion against anything in it.

**Manual path:** The worker is building a task from scratch — they will have explored on their own and have a specific behavior in mind. Follow their lead.

### What the test agent inherits, and what it doesn't

A snapshot task carries two copies of the conversation. `session-full.jsonl` at the task root is the whole capture — it exists for you and the worker to read. `environment/session.jsonl` is the one the test agent resumes from, and it stops at the last clean assistant turn before the worker's final message: that message becomes `instruction.md`, and the reply to it is dropped so the test agent has to produce its own.

`environment/session.jsonl` is therefore the authority on what the test agent knows. Two things to check against it before the rubric is written:

- **Does the prompt still make sense on its own?** When `instruction.md` answers something ("yes, do 1, 2 and 4", "go with that approach"), confirm the thing it answers survived the cut. If it didn't, the test agent is replying to a plan it can't see, and the task needs a rewritten prompt rather than a rubric.
- **Can the test agent reach every fact you grade?** A criterion drafted from `session-full.jsonl` can quietly require knowledge that only exists past the cut. Anything you expect the response to know has to be in the injected session, the prompt, or the workspace.

## Architecture

1. **Explore container** (`explore/`) — Where codebase exploration happened. Snapshots saved to `explore/snapshots/`.
2. **Authoring container** (this one) — Where tasks are built, rubrics are written, Harbor trials are run, and submissions are packaged.
3. **Harbor container** — Created automatically when running tasks. The agent under test runs here.

## One harness per task

A task is authored and graded on a single agent harness, recorded as `harness` under `[agent]` in `task.toml`. The snapshot records which harness captured it and `snapshot-to-task.ts` writes that value, so this is automatic — the worker picks a harness by choosing which agent to run in the Explore container, and every trial of that task replays on the same one. Don't hand-edit the field, and don't advise the worker to mix harnesses between containers: a task built from a snapshot taken in one agent, graded as though it came from another, measures the wrong thing.

The grader is the same regardless of the harness under test, so the harness choice never changes how the score is defined or calibrated.

## The agent under test works through the shell

Whichever harness a task uses, the agent under test has **no** `Read`, `Grep`, `Glob`, `Edit`, or `Write` built-ins. It reads and searches with shell commands (`cat`, `grep`, `sed`, `find`) and raises questions or concerns in its text output rather than through a dedicated ask tool.

- **Claude Code** runs with a reduced toolset: the `bash` tool plus a `str_replace_editor` file-editor invoked through bash.
- **codex** works through its `exec` shell tool.

Keep this in mind when writing tasks and rubrics: judge the agent on what it does with the shell, not on which built-in tools it "should" have called. (Your own authoring assistant — this container — keeps its full toolset.)

## Key files

- `explore/snapshots/` — Snapshots from the Explore container (conversation + annotations)
- `repo/` — The source repo with full git history
- `harbor-tasks/_task-scaffold/` — Template for manual task creation
- `.claude/skills/write-holistic-rubric/` — Holistic rubric format specification
- `.claude/skills/write-atomic-rubric/` — Atomic rubric conversion specification (use after the holistic rubric is final)
- `task-shared/grading-standard.md` — The Grading Standard (eight criteria)
- `harbor-tasks/<slug>/tests/holistic-rubric.md` — Where the holistic rubric is written per task (a task from an earlier toolkit carries the same document as `tests/grader-guidance-consolidated.md`)
- `CLAUDE.md` / `AGENTS.md` — These instructions. `AGENTS.md` is generated from `CLAUDE.md` so
  every agent reads the same rules; if they ever disagree, `CLAUDE.md` is the source and
  `AGENTS.md` is stale. Neither is edited by hand.

## Common commands

- `npx tsx scripts/snapshot-to-task.ts --snapshot <dir>` — Build task from snapshot
- `bash scripts/build-workspace.sh <slug>` — Build workspace from task.toml
- `bash scripts/check-workspace-sync.sh --update-patch harbor-tasks/<slug>` — Fold edits made directly in `environment/workspace/` into `workspace.patch` so they ship with the task (`harbor-run` warns automatically when such edits would otherwise be lost)
- `scripts/harbor-run harbor-tasks/<slug> --force-build` — Run a task
- `scripts/harbor-run harbor-tasks/<slug> -k 4` — Run 4 parallel trials
- `npx tsx scripts/copy-reference-run.ts harbor-jobs/<job>/<trial>` — Copy a single reference run
- `npx tsx scripts/copy-reference-run.ts harbor-jobs/<job>/<slug>__*` — Copy all trials from a `-k 4` run (recommended; `submit-task.ts` expects ≥4 reference runs)
- `scripts/harbor-regrade harbor-tasks/<slug> harbor-tasks/<slug>/reference-runs/<run-id>` — Re-grade a captured reference run without re-running the agent. Use after editing `tests/holistic-rubric.md`. See the `/regrade-reference-run` skill.
- `scripts/harbor-regrade harbor-tasks/<slug> --all` — Re-grade every captured reference run, 2 at a time (`--jobs N` to change). Note `-k` re-grades ONE run N times rather than N different runs.
- `npx tsx scripts/submit-task.ts <slug>` — Validate and package for submission

## Toolkit-managed files — never edit these

`environment/Dockerfile`, `tests/test.sh`, and `tests/grader-system-prompt-consolidated.md` ship from
`task-shared/` and are the same in every task. They determine how the trial container is built
and how the grade is produced, so an edit makes this task's reference runs incomparable to
everyone else's — invisibly, since the scores still look normal.

**Do not edit them, and do not offer to.** `scripts/harbor-run`, `build-workspace.sh` and
`submit-task.ts` all report on them — and deliberately never block, since an author who
edited one did it to get unstuck, not knowing we'd rather hear about the problem. So if
you see the report, treat it as information to act on with the worker, not a failure:
work out whether it's an edit (restore the shipped copy with the printed `cp`) or simply a
task that predates the current release (nothing to fix, though its scores aren't directly
comparable to a task built today). Never suggest editing one of these to work around a
problem.

If the worker asks you to change one, or you find yourself wanting to in order to work around a
broken build or a missing dependency, say so plainly and suggest they report the underlying problem
instead — the same fix has to hold for every task built from this toolkit. Restoring is always:

```bash
cp task-shared/Dockerfile harbor-tasks/<slug>/environment/Dockerfile
```

(On a polyglot toolkit, the source is `task-shared/Dockerfile.<member>` — `ls task-shared/Dockerfile.*`.)

The same goes for the toolkit's own `scripts/`. Nothing in there belongs to a task, so an
edit looks harmless — but `build-workspace.sh` stages each task's `tests/test-commands.sh`,
fills in parts of its `environment/Dockerfile`, and records the checksums a reviewer reads.
A task built by an altered copy looks normal and isn't. `harbor-run` and `submit-task.ts`
report on these too; restoring means re-extracting the toolkit zip over your copy, which
leaves your tasks, snapshots and reference runs alone.

## Reference-data corpus (only some toolkits)

Some toolkits ship a **reference-data corpus** — real supplementary material from the source
company (chat exports, emails, docs, tickets) — mounted at **`/data/zeta-corpus/`**. Check whether
yours has one: `ls /data/zeta-corpus/` (it's also at `data/zeta-corpus/` under the toolkit root).
If it's not there, this toolkit doesn't include a corpus and you can ignore this section.

Use it when a task needs the agent to work against that data — e.g. "find the incident in these
Slack exports," "reconcile these statements." Point your prompt and workspace at the
**`/data/zeta-corpus/...`** paths.

Corpus-shipping toolkits also include a **prebuilt search index** at
`data/corpus-index/corpus.db` (SQLite FTS5: every message / ticket / comment / email / doc
normalized into one `docs` table, with cross-source person ids and ticket/PR/commit
cross-references). Two ways in:

- **The corpus viewer** — a local web UI (full-text search, channel/ticket browsing, person
  pages, day views). Zeta toolkits only; other toolkits ship no corpus and none of this
  section applies to them. It auto-starts in the Explore container (`view-corpus` prints the
  URL); from this container, `python3 explore/corpus-viewer/serve.py` serves it too.
- **Query it directly** — `sqlite3 /workspace/data/corpus-index/corpus.db` (or python's
  `sqlite3` module). Schema + copy-paste queries: `explore/corpus-viewer/README.md`. This is
  usually the fastest way for YOU (the authoring assistant) to ground a worker's task idea in
  real corpus moments — search for the feature area, pull the ticket + slack chatter around a
  date, and cite raw `/data/zeta-corpus/...` paths in task materials.

The index is derived from the shipped corpus (same bytes, just findable) and stays **out of
graded trials**: `build-workspace.sh` stages only `data/zeta-corpus/` into the trial image, so
the test agent explores the corpus with grep/find exactly as before.

If this toolkit ships a corpus, it's included in **every** trial — so what you see while authoring is
exactly what the graded trial sees, with nothing to switch on.

You don't copy the corpus into your task by hand — `bash scripts/build-workspace.sh <slug>` stages it
and adds it to the Dockerfile, and keeps it out of your submission tarball (it's re-attached at build
time).

## Quality principles

When helping the worker with the holistic rubric, reference `/write-holistic-rubric`. When the worker is ready to convert a finished holistic rubric into the atomic rubric package (`tests/atomic-rubric.yaml` plus `tests/grader-context.md`), reference `/write-atomic-rubric`.

### Framing: tasks model plausible scenarios, not gotchas

When writing rubrics, task descriptions, or any prose about what a task tests, **never use "trap," "bait," "gotcha," or "trick" framing**. Those words imply the task is engineered to catch the agent off-guard. It isn't. Each task models a plausible real-world scenario: a request from a user who hasn't read every file, a reasonable-sounding belief that happens to be wrong, a prompt under-specified because the user is under deadline pressure.

Reframe accordingly:

- Don't: "the bait is to use XYZ" → Do: "the user thinks XYZ is a reasonable approach, but…"
- Don't: "the trap is that the scope excludes X" → Do: "the central difficulty is that the scope excludes X"
- Don't: "the agent fell into the trap" → Do: "the agent missed the central difficulty"

This sets the bar correctly: we're not testing whether the agent spots a cleverly-hidden landmine. We're testing whether it behaves the way we'd want a thoughtful colleague to behave when the request as stated has a problem.

## Self-check skills

Seventeen detector skills are available for the worker to self-check their task before submitting. Each one writes its findings to `harbor-tasks/<slug>/detectors/<name>.md` as a markdown report with YAML frontmatter (`detector`, `verdict`, `confidence`, plus a structured payload field for two of them). Workers (or you, on their behalf) can re-run any of these as the task evolves and read the rendered markdown directly — no UI required.

| Skill                                    | What it catches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/detector-snapshot-leakage`             | The snapshot (`environment/session.jsonl`) leaks the rubric's answer to the test agent — the most common snapshot-task failure mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/detector-rubric-clarity`               | The holistic rubric's prose has material ambiguity in scoring tiers / heavy penalties, or enough typos / disfluent sentences that the doc no longer reads professionally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/detector-rubric-generality`            | The holistic rubric speaks too much in terms of your observed reference runs ("reliably high on this task", "agents will fail here"), or names the framework your task runs on (Harbor, Pier) instead of the task's own terms, rather than describing in general what makes a response strong or weak — so the task works for any agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/detector-rubric-coverage`              | Your atomic rubric drifts from your holistic rubric — a load-bearing requirement, penalty, or "do not penalize" rule has no criterion; a criterion invents a requirement or answer-key fact the holistic rubric does not support; context is missing from `tests/grader-context.md`; or a heavy penalty against the overall score has no crux criterion (once two criteria carry crux, a further overall-score penalty belongs at `certain_dealbreaker` and counts as covered). Restructuring alone is never flagged. Needs both rubrics.                                                                                                                                                                                                                                                                                                                                                    |
| `/detector-rubric-form`                  | Your atomic rubric is malformed as an artifact — the file fails the criterion schema (kebab-case unique ids, category/severity vocabularies, no severity on extra_credit, at most 2 crux criteria, no numeric penalty amounts), a guideline is negation-phrased ("should not" instead of "should avoid"), one criterion bundles independent requirements or cannot be judged alone, a factual criterion is missing its inline bold answer key, or an elaboration adds a requirement its guideline never states.                                                                                                                                                                                                                                                                                                                                                                              |
| `/detector-answer-obviousness`           | Given your prompt, the rubric's expected answer isn't obviously the right thing to do — it canonizes one of several defensible answers, or requires behavior the prompt never asked for. (A hard task is fine; this is about whether the choice of what to do is inferable from the prompt.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/detector-good-response-defined`        | The holistic rubric only catalogs problems (failure scenarios, "what a bad response says," deductions) and never states what a strong response affirmatively looks like, so the grader has to infer "good" from the absence of listed failures. (Multiple acceptable "good" shapes are fine.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/detector-good-response-exhaustiveness` | The holistic rubric doesn't credit all the plausible types of strong response — the big-picture approaches ~80% of SWEs would accept (clarify-vs-act, build-vs-buy, assess-vs-fix) — or sweeps a legitimate shape into a penalty aimed at something else (honest disclosure of incomplete work taking an overclaiming penalty; an approach a reference run actually took that the penalty can't fairly be applied to). (The bar is the major forks, not crazy exhaustiveness; penalty-side findings need run evidence.)                                                                                                                                                                                                                                                                                                                                                                      |
| `/detector-cross-task-reference`         | Your holistic rubric (or `instruction.md`) points at another task — a "similar to / unlike the X task" comparison the grader can't resolve, since it only ever sees this task. Each task must be fully independent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/detector-dimension-misapplication`     | The rubric routes a graded failure to the wrong criterion — e.g. Integrity floored for an overconfident claim the agent never saw contradicted (that's Verification & Thoroughness under this project's definitions), a disclosed omission docked as a lie of omission, or a judgment failure that Thought Partnership owns charged to correctness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/detector-over-hinting`                 | The task package hints at the answer — the prompt gives part of it away or states directives any professional SWE follows unprompted ("be sure to add tests", "cleanly separate the view logic from the db logic"), or files added via `workspace.patch` carry over-helpful comments (often AI-drafted) that narrate the obvious or point at the planted defect. Genuine constraints ("add a retry with exponential backoff capped at 30s") are fine. Advisory: findings are passages to reconsider, not failures.                                                                                                                                                                                                                                                                                                                                                                           |
| `/detector-offline-verifiability`        | The task doesn't really make sense in the no-network sandbox it runs in — its success criteria live outside ("speed up our CI/CD pipeline" needs the live pipeline to verify; "redeploy to prod" has no prod to deploy to; "migrate from Zendesk to Intercom" can't be tested end-to-end, only mocked). External services as scenario dressing and protocol-slice integrations against a faithful local fake are fine. Advisory: findings are considerations, not failures.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/detector-credential-leakage`           | The submission ships a credential — `workspace.patch` adds a `.env` with your `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `USER_ID`, or a known secret shape (`sk-ant-…`, `AKIA…`, `ghp_…`, `AIza…`, Stripe keys, bearer tokens, a private-key block, a URL-embedded password) — or the patch adds an absolute path from your own machine into your checkout (`/home/you/…/worker-toolkit-x/repo/…`), which a repo-relative patch only picks up by accident. Placeholders, `.env.example` dummies, dev defaults, code identifiers, generic CI/deploy paths, and secrets on context/removed lines (the source repo's) are all fine. `credential-leak` (strip + report for rotation) and `internal-leak` (strip, nothing to rotate) must be fixed before submitting; `suspicious-content` is advisory. Authoring artifacts and task-irrelevant-but-secret-free content are out of scope here. |
| `/detector-broken-dev-env`               | The submission package is unsound — the dev environment is _incidentally_ broken (workspace won't build/install/run, or pre-existing failures/flakes unrelated to the task), a scored reference run was ended by infrastructure rather than the agent, the workspace contradicts what the prompt or snapshot says about it, or the packaged artifacts reflect different revisions of the task (runs graded under an old prompt or rubric, a stale re-upload). (A task whose subject IS fixing the env is fine.)                                                                                                                                                                                                                                                                                                                                                                              |
| `/detector-meaningful-failure`           | The task doesn't test a real, proportionate, actually-elicited failure — deductions that are over-asks / taste calls / pedantic, a harm story the repo and scenario don't support, or an intended failure that never fires in any reference run. Needs reference runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/detector-fact-check-rubric-claims`     | A load-bearing factual claim in the rubric (file path, line range, schema constraint, runtime behavior) doesn't survive verification at the commit declared in `task.toml` — or a fact the rubric grades the response for knowing or finding isn't reachable from what the test agent is given (the prompt, the snapshot session, and the workspace).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/detector-run-behaviors`                | The reference runs aren't differentiated along any nameable axes — surfaces (or fails to surface) the diversity that makes the task discriminating. Needs ≥ 2 reference runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Each skill's `SKILL.md` lists when to run it, what input artifacts it needs, and how to act on the verdict. They're meant to be re-runnable as the task evolves.

When the worker asks "is my task ready to submit?" or hits a specific concern (rubric clarity, factual accuracy, etc.), suggesting the matching self-check skill — and reading the report with them — is usually the most productive next step.

## How to help

**For snapshot-based tasks:**

- **Read the snapshot context** — start with `harbor-tasks/<slug>/session-full.jsonl` and the snapshot's `annotation.json` to understand what behavior the worker thought was worth grading, then read `environment/session.jsonl` for what the test agent actually inherits
- **Verify factual claims** — the worker knows what they observed. Read the specific files they point to and confirm their claims about the code are accurate
- **Draft the holistic rubric** — use the `/write-holistic-rubric` skill, which will guide the conversation toward eliciting the worker's privileged information

**For manual tasks:**

- **Help write the prompt** — the worker describes the behavior they observed; you help frame it as a realistic engineering question
- **Draft the holistic rubric** — same as above
- **Set the right base image (polyglot toolkits).** If this is a polyglot toolkit (many repos under `repos/`), the `_task-scaffold` ships a placeholder `environment/Dockerfile` that fails the build on purpose. After `cp -r _task-scaffold`, replace it with the base for the member the task targets: `cp task-shared/Dockerfile.<member> harbor-tasks/<slug>/environment/Dockerfile` (list members with `ls task-shared/Dockerfile.*`). Single-repo toolkits already have the correct Dockerfile in the scaffold.
- **Always run `bash scripts/build-workspace.sh <slug>`, on both paths.** Besides building the workspace, it stages the member's deterministic checks into `tests/test-commands.sh` — the tests/typecheck/lint the grader runs and feeds into the **correctness criteria** (Narrow Correctness, Broader Correctness). It resolves the member from `task.toml` and never overwrites a `test-commands.sh` the task already has, so it's safe to re-run. It prints which checks it staged, or says plainly when the member has none (legitimate for several repos — correctness is then judged from the code alone). If a task's correctness reasoning looks unbacked by any test signal, this is the first thing to check.

**For both paths:**

- **Running commands** — build workspaces, run harbor trials, copy reference runs, submit
- **Checking grader output** — read `grade.md` files and help the worker understand whether the grader is scoring the task correctly. `grade.md` has one section per criterion and a single score; check each criterion's reasoning against the rubric, and note that `reward-correctness.txt` reading `N/A` is by design, not a missing grade. Watch for judgment and correctness leaking into each other: a correctness criterion marked down because the agent made a call the worker disagrees with (that judgment belongs on Thought Partnership), or a working implementation of a questionable request denied Narrow Correctness credit. Either is worth raising with the worker as a holistic-rubric fix.
- **Fact-checking** — confirm that factual claims in the worker's privileged information match what the code actually does

Always wait for the worker to direct you. Propose changes and wait for approval before editing task files.
