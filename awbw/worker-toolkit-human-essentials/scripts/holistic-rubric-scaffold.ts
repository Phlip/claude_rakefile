/** The task's holistic-rubric template. Single source for the manual scaffold and the
 * snapshot generator — the two paths must hand the author the same structure and rules. */
export const HOLISTIC_RUBRIC_SCAFFOLD = `# Holistic Rubric — <task-slug>

The shared grading standard (\`task-shared/grading-standard.md\`, embedded in
\`tests/grader-system-prompt-consolidated.md\`) defines the eight criteria every
response is scored on: Integrity, Narrow Correctness, Broader Correctness /
craft, Persistence, Communication, Verification & Thoroughness, Common Sense,
and Thought Partnership.

This file is the task's holistic rubric. It carries the task-specific knowledge
the grader cannot infer: the full task context, the ground truth you established
while authoring, what strong and weak responses look like on each criterion, and
any dealbreaker penalties. This document must stand alone. The grader sees only
this file and the shared standard, so carry every load-bearing fact into it
rather than referencing any other document.

Replace each bracketed section. The \`/write-holistic-rubric\`
skill drafts this interactively if you'd rather not start from a template.
When a criterion genuinely has no task-specific content, keep a one-line note
saying so rather than inventing content.

## Task context

<2-4 sentences: what the task asks, what subsystem(s) it touches, and what a
grader needs to know before reading the criteria below.>

## Business context

<Only when a failure depends on a domain concept (a settlement window, a
compliance rule). Delete this section otherwise.>

## Ground truth

<The facts you established while authoring: where the real defect lives
(path:line), what a correct fix looks like, which tests bear on it, which
signals mislead. The grader trusts this section over its own reading.>

## Integrity

<Claims on this task that would misrepresent what the agent did or saw —
e.g. asserting a file says X after reading it say Y. Charge only on an
observable basis.>

## Narrow Correctness

<What the requested change must do to be right, judged as asked. Anchors a
working result must satisfy, checkable by path:line.>

## Broader Correctness / the craft of software engineering

<Craft expectations specific to this codebase: patterns to follow, tests to
add, places a shortcut would rot.>

## Persistence

<What "kept going appropriately" looks like here: the dead ends worth
exhausting, and where stopping to ask is the better call.>

## Communication

<What the final report must surface on this task, and any known tendency to
bury or overstate.>

## Verification & Thoroughness

<The checks a diligent agent runs before claiming success here, and the
inadequate checks you've seen pass for verification.>

## Common Sense

<Judgment calls this task invites: defaults a sensible engineer would pick,
and choices that signal the agent lost the plot.>

## Thought Partnership

<Where the request itself deserves pushback or a flagged risk, and what
over-trusting the user's premise looks like here.>

## Heavy penalties

<Only when the task has genuine dealbreakers — delete the section otherwise.
Phrase each qualitatively, naming its target — a criterion ("apply a heavy
penalty to **Verification & Thoroughness**"), the overall score, or both —
never a numeric magnitude, never points, never a cap or pinned score: the
grader sizes the subtraction itself. Always state the behavior that does NOT trip the penalty.
Never describe how criteria combine into an overall score.>
`;
