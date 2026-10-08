/**
 * input-checksums.ts — capture and compare sha256 checksums of the task inputs
 * that reference runs and detector reports depend on.
 *
 * A reference run is only meaningful for the task inputs it actually ran
 * against: the prompt (instruction.md), the snapshot session
 * (environment/session.jsonl), the workspace patch
 * (environment/workspace.patch), and the gitref the workspace is built from
 * (task.toml `[metadata].commit`). Detector reports likewise assess a specific
 * revision of instruction.md + the task's holistic rubric
 * (tests/holistic-rubric.md on current tasks; tests/grader-guidance-consolidated.md
 * on tasks created before the rename) — and, for the rubric detectors, the
 * task's atomic rubric (tests/atomic-rubric.yaml; tests/rubrics.yaml on tasks
 * converted before the rename) and tests/grader-context.md. When any of those
 * change after the artifact was produced, the artifact is stale — it describes
 * an older revision of the task than the one being packaged.
 *
 * This module is the single source of truth for WHAT gets checksummed and how
 * captures are compared. Capture sites (copy-reference-run.ts,
 * record-detector-inputs.ts) write a {@link TaskInputChecksums} record next to
 * the artifact; submit-task.ts re-captures at packaging time and diffs.
 * Content hashes rather than mtimes: a re-clone / whole-tree touch can fake or
 * mask an mtime, but can't change a sha256.
 *
 * Lives in the worker toolkit's shipped file set (static/scripts/lib/), so in
 * a packed toolkit it sits at scripts/lib/ next to both consumers. Repo-side
 * callers go through the scripts/lib/input-checksums.ts re-export shim, which
 * occupies the same relative path there (mirroring the check-devcontainer
 * pattern).
 *
 * Related but deliberately separate: `computeDeliveryHash` (repo-side
 * delivery script — grep the internal repo for it; not shipped with the
 * toolkit) hashes an overlapping input set for delivery idempotency. It is
 * NOT built on this module because its hash format is load-bearing (a
 * changed hash re-delivers every task); if you change WHAT counts as a task
 * input here, check whether the delivery hash needs the same change.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bump when the record shape changes incompatibly. */
export const INPUT_CHECKSUMS_VERSION = 1;

/** Filename of the record inside a reference-run directory. */
export const INPUT_CHECKSUMS_FILENAME = 'input-checksums.json';

/**
 * Where in the artifact lifecycle a capture happened. The moment matters for
 * how much a "fresh" verdict can be trusted:
 *
 *   - 'run'    — at trial launch (scripts/harbor-run stamps the trial dir).
 *                The strongest evidence: the record is what the agent ran
 *                against, whatever got edited afterwards.
 *   - 'copy'   — at copy-reference-run time, the fallback when a trial carries
 *                no run-time stamp. An input edited between harbor-run and the
 *                copy is recorded at its post-edit state, so a stale run can
 *                read fresh.
 *   - 'stamp'  — right after a detector report is written
 *                (record-detector-inputs.ts in a worker checkout; the
 *                internal repo's detector save path stamps the same way).
 *   - 'mirror' — retired: written by the repo-side flow that re-materialized
 *                canonical detector reports to disk back when reports had a
 *                remote canonical store. Reports are local-only now, so no
 *                current code writes it; the member stays so old stamps keep
 *                their recorded method when read.
 *   - 'regrade' — a re-grade of an existing run. Present on records already on
 *                 disk; no current code path writes it.
 *
 * Absent on records written before this field existed.
 */
export type TaskInputCaptureMethod = 'run' | 'copy' | 'stamp' | 'mirror' | 'regrade';

/** Runtime mirror of {@link TaskInputCaptureMethod}, for validating a record read from disk. */
export const TASK_INPUT_CAPTURE_METHODS = Object.freeze([
  'run',
  'copy',
  'stamp',
  'mirror',
  'regrade',
] as const satisfies readonly TaskInputCaptureMethod[]);

/**
 * The checksums of a task's inputs as they stood at capture time. Every hash
 * field is a sha256 hex digest, or `null` when the file didn't exist (a null
 * that later becomes a hash — or vice versa — is a change like any other).
 * `gitref` is the raw `[metadata].commit` string, recorded verbatim rather
 * than hashed so a mismatch message can show it.
 */
export interface TaskInputChecksums {
  readonly version: number;
  /** ISO-8601 timestamp of the capture. */
  readonly capturedAt: string;
  /** Lifecycle point of the capture ({@link TaskInputCaptureMethod}). */
  readonly capturedBy?: TaskInputCaptureMethod;
  /**
   * The task slug the capture was taken from (harbor-tasks/<slug>). Written
   * by launch-time captures so stamping can be scoped to the right task's
   * trial dirs when several harbor-runs share a cwd — and so a mis-routed
   * stamp is detectable after the fact.
   */
  readonly taskSlug?: string;
  /**
   * Set when the finalize flow re-stamped the prompt/graderGuidance hashes
   * after the harbor-path scrub deliberately rewrote those docs
   * (scripts/restamp-task-inputs.ts) — the run/report still reflects the
   * task; only the doc bytes were normalized.
   */
  readonly restampedAt?: string;
  readonly inputs: {
    readonly prompt: string | null;
    readonly graderGuidance: string | null;
    readonly sessionJsonl: string | null;
    readonly workspacePatch: string | null;
    readonly gitref: string | null;
    /**
     * tests/grader-guidance-consolidated.md — the holistic rubric under its
     * pre-rename filename, which every task created before the rename keeps;
     * hashed when present, null otherwise. Absent (undefined) on records
     * captured before the field existed; comparisons skip a field the record
     * predates, so old captures stay fresh until they are re-stamped.
     */
    readonly graderGuidanceConsolidated?: string | null;
    /**
     * tests/holistic-rubric.md — the holistic rubric under its current
     * filename (each task carries exactly one of this and the pre-rename
     * name above). Hashed when present, null otherwise. Absent (undefined)
     * on records captured before the field existed; comparisons skip a
     * field the record predates. The task-checksum digest serializes fields
     * in this order and appends new fields at the end (see
     * scripts/lib/grader-run-checksums.ts).
     */
    readonly holisticRubric?: string | null;
    /**
     * tests/atomic-rubric.yaml — the task's atomic rubric under its current
     * filename. Hashed when present, null otherwise. Absent (undefined) on
     * records captured before the field existed; comparisons skip a field
     * the record predates.
     */
    readonly atomicRubric?: string | null;
    /**
     * tests/rubrics.yaml — the atomic rubric under its pre-rename filename,
     * which tasks converted before the rename keep. Hashed when present,
     * null otherwise; absent (undefined) on records captured before the
     * field existed.
     */
    readonly rubricsYaml?: string | null;
    /**
     * tests/grader-context.md — the context document the rubric grader modes
     * read beside the atomic rubric. Hashed when present, null otherwise;
     * absent (undefined) on records captured before the field existed. Last
     * in field order per the append-at-the-end digest rule above.
     */
    readonly graderContext?: string | null;
  };
}

export type TaskInputName = keyof TaskInputChecksums['inputs'];

/** Human-readable component names, used verbatim in staleness warnings. Frozen:
 *  its key set is the runtime source of truth for the task-input axes. */
export const INPUT_LABELS = Object.freeze({
  prompt: 'prompt (instruction.md)',
  graderGuidance: 'legacy-era grader guidance (tests/grader-guidance.md)',
  graderGuidanceConsolidated: 'holistic rubric (tests/grader-guidance-consolidated.md)',
  sessionJsonl: 'session snapshot (environment/session.jsonl)',
  workspacePatch: 'workspace patch (environment/workspace.patch)',
  gitref: 'gitref (task.toml commit)',
  holisticRubric: 'holistic rubric (tests/holistic-rubric.md)',
  atomicRubric: 'atomic rubric (tests/atomic-rubric.yaml)',
  rubricsYaml: 'atomic rubric (tests/rubrics.yaml)',
  graderContext: 'grader context (tests/grader-context.md)',
} as const satisfies Record<TaskInputName, string>);

/**
 * The inputs that shape what the AGENT saw and did. Changing any of them means
 * a captured reference run no longer reflects the task being packaged, and
 * only re-running the agent can fix that. The holistic-rubric files are
 * deliberately NOT in this set: editing the rubric stales the run's GRADE,
 * not the run itself, and `scripts/harbor-regrade` re-derives grades without
 * re-running the agent.
 */
export const REFERENCE_RUN_INPUTS = Object.freeze([
  'prompt',
  'sessionJsonl',
  'workspacePatch',
  'gitref',
] as const satisfies readonly TaskInputName[]);

/**
 * The inputs a detector report assesses — instruction.md plus whichever
 * holistic-rubric files the task directory carries (tests/holistic-rubric.md
 * on current tasks, tests/grader-guidance-consolidated.md on tasks created
 * before the rename, plus the legacy-era plain-named file when a task
 * authored on an earlier generation carries one). An absent file hashes to
 * null on both sides and never diffs. Compared by content.
 *
 * The atomic-rubric files are deliberately NOT in this set: fifteen of the
 * seventeen detectors never open them, so writing an atomic rubric after
 * running the detectors would stale every one of those reports over files
 * they never read. The two that do read them use
 * {@link RUBRIC_DETECTOR_REPORT_INPUTS}.
 */
export const DETECTOR_REPORT_INPUTS = Object.freeze([
  'prompt',
  'graderGuidance',
  'graderGuidanceConsolidated',
  'holisticRubric',
] as const satisfies readonly TaskInputName[]);

/**
 * The inputs the two rubric detectors assess: {@link DETECTOR_REPORT_INPUTS}
 * plus the atomic-rubric package (tests/atomic-rubric.yaml, the pre-rename
 * tests/rubrics.yaml, and tests/grader-context.md), which they compare
 * against the holistic rubric.
 */
export const RUBRIC_DETECTOR_REPORT_INPUTS = Object.freeze([
  ...DETECTOR_REPORT_INPUTS,
  'atomicRubric',
  'rubricsYaml',
  'graderContext',
] as const satisfies readonly TaskInputName[]);

/** Detectors that read the atomic-rubric package, and so are staled by it. */
export const ATOMIC_RUBRIC_DETECTORS: readonly string[] = Object.freeze([
  'detector-rubric-coverage',
  'detector-rubric-form',
]);

/** The input set a named detector's report is judged against. */
export function detectorReportInputs(detectorName: string): readonly TaskInputName[] {
  return ATOMIC_RUBRIC_DETECTORS.includes(detectorName)
    ? RUBRIC_DETECTOR_REPORT_INPUTS
    : DETECTOR_REPORT_INPUTS;
}

/** sha256 hex digest of a file's bytes, or null when it doesn't exist. */
function sha256File(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * The gitref (`[metadata].commit`) from a task.toml, or null when the file is
 * missing, unreadable, or has no commit line — a read failure downgrades to
 * "absent" rather than crashing a capture or a validation sweep.
 *
 * Deliberately a regex, not a TOML parser: this module ships in the worker
 * toolkit, where a new runtime dep would break packaging for every worker
 * whose container predates the dep (npm install runs only on container
 * create, and containers survive toolkit upgrades). build-workspace.sh reads
 * the same key with the same grep-a-`commit`-line approach. The one `commit`
 * key in a task.toml is `[metadata].commit`, so anchoring to the first
 * `commit = "…"` line is exact in practice.
 */
function readGitref(taskDir: string): string | null {
  const tomlPath = join(taskDir, 'task.toml');
  if (!existsSync(tomlPath)) return null;
  try {
    const match = /^\s*commit\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*(?:#.*)?$/m.exec(
      readFileSync(tomlPath, 'utf-8')
    );
    const commit = match?.[1] ?? match?.[2];
    return commit && commit.length > 0 ? commit : null;
  } catch {
    return null;
  }
}

/** Checksum the task inputs as they stand right now under `taskDir`. */
export function captureTaskInputs(
  taskDir: string,
  capturedBy?: TaskInputCaptureMethod
): TaskInputChecksums {
  return Object.freeze({
    version: INPUT_CHECKSUMS_VERSION,
    capturedAt: new Date().toISOString(),
    ...(capturedBy ? { capturedBy } : {}),
    inputs: Object.freeze({
      prompt: sha256File(join(taskDir, 'instruction.md')),
      graderGuidance: sha256File(join(taskDir, 'tests', 'grader-guidance.md')),
      sessionJsonl: sha256File(join(taskDir, 'environment', 'session.jsonl')),
      workspacePatch: sha256File(join(taskDir, 'environment', 'workspace.patch')),
      gitref: readGitref(taskDir),
      graderGuidanceConsolidated: sha256File(
        join(taskDir, 'tests', 'grader-guidance-consolidated.md')
      ),
      holisticRubric: sha256File(join(taskDir, 'tests', 'holistic-rubric.md')),
      atomicRubric: sha256File(join(taskDir, 'tests', 'atomic-rubric.yaml')),
      rubricsYaml: sha256File(join(taskDir, 'tests', 'rubrics.yaml')),
      graderContext: sha256File(join(taskDir, 'tests', 'grader-context.md')),
    }),
  });
}

/**
 * Read a previously captured record. Returns null when the file is missing or
 * doesn't look like a capture (pre-tracking artifact, hand-edited JSON, a
 * future incompatible version) — callers treat null as "staleness unknowable",
 * never as an error. No zod here: this module ships in the worker toolkit,
 * whose dependency set stays minimal, so the guard is manual.
 */
export function readTaskInputChecksums(filePath: string): TaskInputChecksums | null {
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as TaskInputChecksums;
  if (record.version !== INPUT_CHECKSUMS_VERSION) return null;
  if (typeof record.inputs !== 'object' || record.inputs === null) return null;
  for (const name of Object.keys(INPUT_LABELS) as TaskInputName[]) {
    const value = record.inputs[name];
    // undefined = the record predates this input field; still a valid capture.
    if (value !== undefined && value !== null && typeof value !== 'string') return null;
  }
  // An unrecognized capture method is dropped, not rejected: the field is
  // provenance colour, and rejecting would flip the whole run to "unknowable".
  const method: unknown = record.capturedBy;
  const isKnown = TASK_INPUT_CAPTURE_METHODS.includes(method as TaskInputCaptureMethod);
  if (method !== undefined && !isKnown) {
    const { capturedBy: _dropped, ...rest } = record;
    return rest;
  }
  return record;
}

/**
 * Which of `names` changed between a recorded capture and the current state?
 * Returns the human-readable labels ({@link INPUT_LABELS}) of every component
 * whose value differs — including absent→present and present→absent flips. A
 * field the recorded capture predates (the key is not in the record at all)
 * is skipped: freshness on that axis is unknowable, and flagging every old
 * record the moment a new axis ships would drown the real signal. (The
 * task-checksum fold folds absence as 'null' instead — it only ever reads a
 * fresh capture, which is total, so the two never disagree in practice.)
 */
export function diffTaskInputs(
  recorded: TaskInputChecksums,
  current: TaskInputChecksums,
  names: readonly TaskInputName[]
): string[] {
  return names
    .filter((name) => name in recorded.inputs)
    .filter((name) => recorded.inputs[name] !== current.inputs[name])
    .map((name) => INPUT_LABELS[name]);
}
