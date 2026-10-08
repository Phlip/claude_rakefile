/**
 * submit-task.ts — Validate and package a task directory for submission.
 *
 * Usage:
 *   npx tsx scripts/submit-task.ts <task-slug>
 *   npx tsx scripts/submit-task.ts my-cool-task --json
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  INPUT_CHECKSUMS_FILENAME,
  REFERENCE_RUN_INPUTS,
  captureTaskInputs,
  detectorReportInputs,
  diffTaskInputs,
  readTaskInputChecksums,
} from './lib/input-checksums';
import {
  bannerize,
  checkTaskInfraIntegrity,
  formatIntegrityReport,
  isTaskFromThisToolkitGeneration,
} from './lib/task-infra-integrity.js';
import {
  checkToolkitScriptIntegrity,
  scriptIntegrityNotice,
} from './lib/toolkit-script-integrity.js';
import { didRepair, manualRepairHint, normalizeTreePermissions } from './lib/tree-permissions';

/** Written to harbor-tasks/<slug>/staleness.json by {@link validateTask}. */
export const STALENESS_REPORT_FILENAME = 'staleness.json';

/**
 * Written to harbor-tasks/<slug>/toolkit-files.json by {@link validateTask}: the
 * per-file verdict on the toolkit-managed files. Shipped in the package because the
 * check needs the toolkit's `task-shared/` and so cannot be recomputed downstream.
 */
export const INFRA_REPORT_FILENAME = 'toolkit-files.json';

/**
 * Staleness of one reference run against the task inputs being packaged.
 * `unknown` = the run predates input-checksum tracking (no recorded
 * checksums), so freshness can't be verified either way.
 */
export interface ReferenceRunStaleness {
  runId: string;
  status: 'fresh' | 'stale' | 'unknown';
  /** Human-readable labels of the inputs that changed since capture. */
  changed: string[];
  /** When the run's checksums were captured (recorded runs only). */
  capturedAt?: string;
  /**
   * Lifecycle point of the capture (recorded runs only): 'run' = stamped at
   * trial launch by harbor-run (strongest — immune to edits made between the
   * run and the copy); 'copy' = captured at copy-reference-run time (an input
   * edited between harbor-run and the copy is recorded post-edit). Absent on
   * records that predate the field.
   */
  capturedBy?: string;
}

/**
 * Staleness of one detector report. `mtime` = legacy unstamped report; the
 * mtime heuristic can prove a report is OLDER than the docs but never that it
 * matched their content, so an mtime record is `stale` or `unknown` — only a
 * checksum stamp can say `fresh`.
 */
export interface DetectorReportStaleness {
  report: string;
  status: 'fresh' | 'stale' | 'unknown';
  method: 'checksums' | 'mtime';
  changed: string[];
  capturedAt?: string;
  /** Lifecycle point of the stamp's capture (checksum records only). */
  capturedBy?: string;
}

/**
 * The machine-readable staleness record shipped inside the tarball (and
 * refreshed whenever validateTask runs), so a review — on any pipeline — can
 * display exactly which runs/reports predate which input edits even if the
 * worker packaged past the warnings.
 */
export interface TaskStalenessReport {
  version: number;
  generatedAt: string;
  referenceRuns: ReferenceRunStaleness[];
  detectors: DetectorReportStaleness[];
}

export interface ValidationResult {
  hasErrors: boolean;
  /** Hard-failure messages — each one means the package violates a submission guarantee. */
  errors: string[];
  /** Advisory messages — the package is submittable but could be improved. */
  warnings: string[];
  refCount: number;
  /** Reward scores (reward.txt) across the reference runs. */
  scores: number[];
  /** Correctness scores (reward-correctness.txt), excluding `N/A` runs. */
  correctnessScores: number[];
  workspaceFiles: number;
  /** Per-run / per-report staleness (also written to staleness.json). */
  staleness: TaskStalenessReport;
  /** Loud notice about toolkit-managed files, re-printed last by the CLI. */
  infraNotice?: string;
  scriptNotice?: string;
}

/**
 * First interpreter that can `import tomllib`, or null. `python3` is not always new
 * enough (3.11+), and a resolver run under an old one fails in a way that looks like a
 * malformed task.toml. Twin of `_raccoon_python` in scripts/lib/harness-credentials.sh
 * and the search in snapshot-to-task.ts — kept separate because those live in trees that
 * cannot import each other.
 */
function pythonWithTomllib(): string | null {
  for (const candidate of [
    process.env.RACCOON_PYTHON,
    'python3',
    'python3.13',
    'python3.12',
    'python3.11',
  ]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['-c', 'import tomllib'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Validate a task package against the submission guarantees. This is the SINGLE
 * source of truth for "what a well-formed tarball looks like": workers run it
 * via `submit-task` before packaging, and the review pipeline runs the exact
 * same function on its side after unpacking, so a package that wouldn't pass
 * here is cleanly flagged rather than crashing a detector or being half-reviewed.
 *
 * Returns structured `errors` / `warnings` (in addition to logging them) so a
 * caller can record WHY a package was rejected, not just that it was.
 */

/**
 * One harness per task: every reference run must have been produced by the harness
 * the task declares.
 *
 * Why it's a hard error rather than a warning. A task's reference runs ARE its
 * calibration — detectors and reviewers reason over them, and the benchmark groups by
 * (harness, model). If the runs came from a harness other than the declared one, every
 * one of those readings is attributed to the wrong agent, and nothing downstream can
 * detect it: the scores look perfectly ordinary. The fix is also cheap (correct the
 * declaration, or re-run), which is what makes refusing reasonable.
 *
 * Resolution goes through `resolve_harness.py` rather than string-comparing identities,
 * for two reasons. Raw identities under-report agreement — `SnapshotClaudeCode` and
 * `PreinstalledClaudeCode` are both `claude-code`, and a task whose runs straddle the
 * multi-turn-detection change legitimately has both. And the toolkit has no TOML parser
 * for TS, so the declared harness must be read by something that actually parses
 * task.toml; a regex would match a commented line or the wrong table.
 *
 * Replays (`harbor-regrade`) are not a harness: they report `replay_agent:ReplayAgent`
 * with no model, because no model ran. Their harness is the SOURCE run's, carried on
 * `kwargs.source_agent_import_path`. Older replays predate that field, and a replay
 * captured before harbor-regrade chained provenance names ANOTHER replay as its source;
 * both are simply unattributable — skipped, not failed, because refusing them would
 * reject every task with a regraded reference run.
 */
function checkHarnessConsistency(
  taskDir: string,
  runDirs: string[],
  cwd: string,
  logger: pino.Logger
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolver = join(cwd, 'scripts', 'resolve_harness.py');
  if (!existsSync(resolver) || runDirs.length === 0) return { errors, warnings };

  const python = pythonWithTomllib();

  /**
   * Ask the resolver something.
   *
   * A refusal and a failure to run are different answers and must not be conflated: the
   * resolver refusing means the task really is malformed, while a missing interpreter or
   * a broken import means we learned nothing and have no business blocking a submission
   * over it. `resolve_harness.py` prefixes every deliberate refusal with
   * `resolve-harness: ERROR:`, which is the only reliable discriminator — a crash also
   * exits 1.
   */
  type ResolverAnswer =
    | { ok: true; stdout: string }
    | { ok: false; refused: boolean; detail: string };

  const askResolver = (args: string[]): ResolverAnswer => {
    if (!python) {
      return { ok: false, refused: false, detail: 'no python3.11+ with tomllib on PATH' };
    }
    try {
      return {
        ok: true,
        stdout: execFileSync(python, [resolver, ...args], {
          cwd,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = String(e.stderr ?? '');
      return {
        ok: false,
        refused: stderr.includes('resolve-harness: ERROR:'),
        detail: (stderr || e.message || 'unknown failure').trim().split('\n').slice(-3).join(' '),
      };
    }
  };

  const declaredAnswer = askResolver(['--declared-harness', '--task-dir', taskDir]);
  if (!declaredAnswer.ok && declaredAnswer.refused) {
    logger.error(
      { file: 'task.toml', detail: declaredAnswer.detail },
      'Could not read [agent] harness from task.toml. The likely cause is a SECOND [agent] table — tasks already carry [agent] timeout_sec, so a harness line must go inside that table, not start a new one. TOML rejects a duplicate table, which makes the whole file unreadable.'
    );
    errors.push('task.toml could not be parsed for [agent] harness');
    return { errors, warnings };
  }
  if (!declaredAnswer.ok) {
    logger.warn(
      { detail: declaredAnswer.detail },
      'Skipping the harness-consistency check: could not run scripts/resolve_harness.py. Your task is not affected — this check only compares the harness your reference runs came from against task.toml.'
    );
    warnings.push('harness-consistency check skipped (resolver could not run)');
    return { errors, warnings };
  }
  const declared = declaredAnswer.stdout.trim();

  // Each run's effective identity: its own agent, or for a replay the source it
  // replayed. Undefined when unattributable.
  const identityByRun = new Map<string, string>();
  for (const runId of runDirs) {
    const resultPath = join(taskDir, 'reference-runs', runId, 'result.json');
    if (!existsSync(resultPath)) continue;
    let agent: { import_path?: unknown; name?: unknown; kwargs?: unknown } | undefined;
    try {
      agent = JSON.parse(readFileSync(resultPath, 'utf-8'))?.config?.agent;
    } catch {
      continue;
    }
    const own = [agent?.import_path, agent?.name].find(
      (v): v is string => typeof v === 'string' && v.length > 0
    );
    if (!own) continue;
    const source = (agent?.kwargs as { source_agent_import_path?: unknown } | undefined)
      ?.source_agent_import_path;
    const effective =
      own === 'replay_agent:ReplayAgent'
        ? typeof source === 'string' && source.length > 0
          ? source
          : undefined
        : own;
    if (effective) identityByRun.set(runId, effective);
  }
  if (identityByRun.size === 0) return { errors, warnings };

  const distinct = [...new Set(identityByRun.values())];
  const resolvedAnswer = askResolver(distinct.flatMap((i) => ['--resolve-identity', i]));
  // Nothing to compare against if this can't run; the declared harness was already read.
  if (!resolvedAnswer.ok) return { errors, warnings };
  const harnessByIdentity = new Map(
    resolvedAnswer.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string])
  );

  const harnessByRun = new Map<string, string>();
  for (const [runId, identity] of identityByRun) {
    const harness = harnessByIdentity.get(identity)?.trim();
    // Skip silently: an identity the registry doesn't know is a gap on OUR side, not a
    // mismatch, and nothing an author can act on. The runs that do resolve still check.
    if (!harness) continue;
    harnessByRun.set(runId, harness);
  }
  const present = [...new Set(harnessByRun.values())].sort();
  if (present.length === 0) return { errors, warnings };

  if (present.length > 1) {
    const breakdown = [...harnessByRun.entries()].map(([runId, h]) => `${runId} → ${h}`).join(', ');
    logger.error(
      { harnesses: present },
      `Reference runs came from MORE THAN ONE harness (${present.join(', ')}). A task is calibrated against one harness — mixed runs make the reference set unreadable, because detectors and reviewers can't tell which agent's behaviour they're looking at. Re-run the trials with a single harness: ${breakdown}`
    );
    errors.push(`reference runs span multiple harnesses (${present.join(', ')})`);
    return { errors, warnings };
  }

  const actual = present[0];
  if (!declared) {
    logger.warn(
      { harness: actual },
      `task.toml declares no [agent] harness, but the reference runs were produced by "${actual}". Add it inside the existing [agent] table so the trial and every downstream consumer know what this task is calibrated against:\n    [agent]\n    harness = "${actual}"`
    );
    warnings.push(`task.toml declares no [agent] harness (reference runs used ${actual})`);
  } else if (declared !== actual) {
    logger.error(
      { declared, actual },
      `task.toml declares harness "${declared}" but the reference runs were produced by "${actual}". One of the two is wrong, and downstream can't tell which: the runs would be attributed to "${declared}" and scored as if that agent produced them. Either correct the declaration or re-run the trials with "${declared}".`
    );
    errors.push(`declared harness "${declared}" does not match reference runs ("${actual}")`);
  }

  return { errors, warnings };
}

/** One reference run whose trial did not reach the natural end of the agent's turn. */
export interface AbortedRun {
  runId: string;
  /** result.json's `exception_info.exception_type`, or `unknown` when unnamed. */
  exceptionType: string;
}

/**
 * Exceptions raised after the agent's turn already ended and the grade was
 * written (verifier-phase timeouts) — the run itself is still readable.
 */
const POST_AGENT_EXCEPTION_RE = /^Verifier/;

/**
 * Reference runs that ended in an error instead of the agent finishing its turn
 * — an API error, a non-zero agent exit, an agent timeout. A run with no
 * result.json predates this record and counts as complete rather than guessed at.
 */
export function findAbortedRuns(taskDir: string, runDirs: readonly string[]): AbortedRun[] {
  const aborted: AbortedRun[] = [];
  for (const runId of runDirs) {
    const resultPath = join(taskDir, 'reference-runs', runId, 'result.json');
    if (!existsSync(resultPath)) continue;
    let info: { exception_type?: unknown } | null | undefined;
    try {
      info = (
        JSON.parse(readFileSync(resultPath, 'utf-8')) as {
          exception_info?: { exception_type?: unknown } | null;
        }
      ).exception_info;
    } catch {
      continue;
    }
    if (!info) continue;
    const exceptionType =
      typeof info.exception_type === 'string' && info.exception_type.length > 0
        ? info.exception_type
        : 'unknown';
    if (POST_AGENT_EXCEPTION_RE.test(exceptionType)) continue;
    aborted.push({ runId, exceptionType });
  }
  return aborted;
}

export function validateTask(
  slug: string,
  logger: pino.Logger,
  opts: { cwd?: string } = {}
): ValidationResult {
  const cwd = opts.cwd ?? process.cwd();
  const taskDir = join(cwd, 'harbor-tasks', slug);
  const errors: string[] = [];
  const warnings: string[] = [];
  const staleness: TaskStalenessReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    referenceRuns: [],
    detectors: [],
  };

  if (!existsSync(taskDir)) {
    logger.fatal({ taskDir }, 'Task directory not found');
    errors.push(`task directory not found: harbor-tasks/${slug}`);
    return {
      hasErrors: true,
      errors,
      warnings,
      refCount: 0,
      scores: [],
      correctnessScores: [],
      workspaceFiles: 0,
      staleness,
    };
  }

  // The task inputs as they stand right now — the baseline every recorded
  // capture (reference runs, detector-report stamps) is compared against.
  const currentInputs = captureTaskInputs(taskDir);

  logger.info({ slug }, 'Validating task');

  interface Check {
    path: string;
    label: string;
    required: boolean;
  }

  const checks: Check[] = [
    { path: 'instruction.md', label: 'Task prompt', required: true },
    { path: 'task.toml', label: 'Task config', required: true },
    { path: 'tests/test.sh', label: 'Grader orchestration', required: true },
    { path: 'environment/Dockerfile', label: 'Dockerfile', required: true },
  ];

  for (const check of checks) {
    const fullPath = join(taskDir, check.path);
    if (existsSync(fullPath)) {
      logger.debug({ file: check.path }, `${check.label}: found`);
    } else if (check.required) {
      logger.error({ file: check.path }, `${check.label}: MISSING`);
      errors.push(`missing required file: ${check.path} (${check.label})`);
    } else {
      logger.warn({ file: check.path }, `${check.label}: not found (optional)`);
      warnings.push(`optional file not found: ${check.path}`);
    }
  }

  // Grader assets are era-specific: a task created on this toolkit generation
  // carries tests/holistic-rubric.md (tasks created just before the rename
  // carry the same document as tests/grader-guidance-consolidated.md); a
  // prior-era task keeps the assets its own kit shipped, under any earlier
  // naming generation (the review pipeline validates every generation with
  // this one function).
  const currentGeneration = isTaskFromThisToolkitGeneration(taskDir);
  const graderAssets: Array<{ label: string; paths: string[] }> = [
    {
      label: 'Grader system prompt',
      paths: currentGeneration
        ? ['tests/grader-system-prompt-consolidated.md']
        : ['tests/grader-system-prompt-consolidated.md', 'tests/grader-system-prompt.md'],
    },
    {
      label: 'Holistic rubric',
      paths: currentGeneration
        ? ['tests/holistic-rubric.md', 'tests/grader-guidance-consolidated.md']
        : [
            'tests/holistic-rubric.md',
            'tests/grader-guidance-consolidated.md',
            'tests/grader-guidance.md',
          ],
    },
  ];
  const presentGuidance: string[] = [];
  for (const asset of graderAssets) {
    const present = asset.paths.filter((p) => existsSync(join(taskDir, p)));
    if (present.length === 0) {
      logger.error({ file: asset.paths.join(' or ') }, `${asset.label}: MISSING`);
      errors.push(`missing required file: ${asset.paths.join(' or ')} (${asset.label})`);
    } else {
      for (const p of present) logger.debug({ file: p }, `${asset.label}: found`);
    }
    if (asset.label === 'Holistic rubric') presentGuidance.push(...present);
  }

  // Placeholder detection
  const placeholderFiles = ['instruction.md', ...presentGuidance];
  for (const file of placeholderFiles) {
    const fullPath = join(taskDir, file);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      if (content.includes('Replace this with')) {
        logger.warn({ file }, 'Still contains scaffold placeholder text');
        errors.push(`scaffold placeholder text not replaced in ${file}`);
      }
    }
  }

  // Deterministic checks: available for this member but not staged?
  //
  // tests/test-commands.sh is optional-by-absence — tests/test.sh just skips the
  // deterministic signals when it isn't there, and correctness gets judged from the
  // code alone. That makes a forgotten copy look exactly like a member that
  // legitimately has no runnable checks, which is the whole problem: silence means
  // two different things. Resolving the member against task-shared/ tells them
  // apart, so warn ONLY when checks exist and weren't staged.
  if (!existsSync(join(taskDir, 'tests', 'test-commands.sh'))) {
    const taskToml = join(taskDir, 'task.toml');
    const member = existsSync(taskToml)
      ? /^repo\s*=\s*"?([^"\n]+)"?/m.exec(readFileSync(taskToml, 'utf-8'))?.[1]?.trim()
      : undefined;
    const sharedDir = join(cwd, 'task-shared');
    const candidates = [
      ...(member ? [join(sharedDir, `test-commands.${member.toLowerCase()}.sh`)] : []),
      join(sharedDir, 'test-commands.sh'),
    ];
    const available = candidates.find((p) => existsSync(p));
    if (available) {
      logger.warn(
        { member, available: available.replace(`${cwd}/`, '') },
        `This repo has deterministic checks (tests/typecheck/lint) but tests/test-commands.sh isn't in the task, so the grader had no test signal behind the correctness score. Stage it and re-run your trials:`
      );
      logger.warn(`  bash scripts/build-workspace.sh ${slug}`);
      warnings.push(
        `tests/test-commands.sh missing though checks exist for ${member ?? 'this repo'} — ` +
          'correctness was not signal-backed; run `bash scripts/build-workspace.sh <slug>` and re-run trials'
      );
    }
  }

  // Detector self-check reports. The toolkit ships one skill per worker-runnable
  // detector, each writing harbor-tasks/<slug>/detectors/<name>.md. The expected
  // set is enumerated from the WORKER-SHIPPED skills directory rather than
  // hardcoded, so it tracks detector additions and retirements — and the
  // resolution order is load-bearing: validateTask also runs repo-side
  // (fetch-submission and the review pipeline both pass the repo root as cwd),
  // where .claude/skills additionally holds pipeline-only detectors that
  // workers cannot run and must never be warned about.
  // raccoon-worker-toolkit/static/.claude/skills is therefore preferred;
  // in a packed toolkit only .claude/skills exists, and it IS the shipped set.
  // Missing reports stay a warning, not an error: the package is reviewable
  // without them, but a reviewer has to regenerate the set by hand, which stalls
  // the queue. A zero-byte report counts as missing — a stub carries no verdict.
  const detectorSkillsDir = [
    join(cwd, 'raccoon-worker-toolkit', 'static', '.claude', 'skills'),
    join(cwd, '.claude', 'skills'),
  ].find((p) => existsSync(p));
  const expectedDetectors = detectorSkillsDir
    ? readdirSync(detectorSkillsDir).filter(
        (d) => d.startsWith('detector-') && statSync(join(detectorSkillsDir, d)).isDirectory()
      )
    : [];
  const detectorsDir = join(taskDir, 'detectors');
  if (expectedDetectors.length > 0) {
    const missing = expectedDetectors.filter((name) => {
      const report = join(detectorsDir, `${name}.md`);
      return !existsSync(report) || statSync(report).size === 0;
    });
    if (missing.length > 0) {
      logger.warn(
        { missing, expected: expectedDetectors.length },
        `${missing.length} of ${expectedDetectors.length} detector reports are missing from detectors/. Reviewers expect the full self-check set — regenerating it during review is the most common avoidable review-queue delay. Run each missing detector (e.g. /${missing[0]}) and re-package.`
      );
      warnings.push(
        `missing ${missing.length} of ${expectedDetectors.length} detector reports: ${missing.join(', ')} — ` +
          'run the detector skills and re-package'
      );
    }
  }

  // Stale detector reports. A report written before the current instruction.md or
  // holistic rubric assessed an earlier revision of the task, and nothing
  // on the review page reveals that. Two generations of evidence:
  //
  //   1. Input checksums (durable). Detector skills stamp each report with a
  //      capture of the task inputs it assessed (detectors/<name>.inputs.json,
  //      written by scripts/record-detector-inputs.ts). Content hashes can't be
  //      faked or masked by whole-tree touches (re-clone, checkout), which is
  //      exactly where mtimes lie. A stamped report is judged by its stamp —
  //      including a fresh verdict when its mtime happens to look old.
  //   2. mtime (legacy fallback). Unstamped reports predate stamping; for them
  //      the original comparison against the newest source doc still applies —
  //      mtimes are meaningful on both sides of the pipeline (the worker
  //      authored these files in place, and tar preserves timestamps through
  //      pack/unpack). Equal timestamps don't warn (same-operation touches).
  if (existsSync(detectorsDir)) {
    const reports = readdirSync(detectorsDir).filter((f) => f.endsWith('.md'));
    const unstamped: string[] = [];
    const staleStamped: Array<{ report: string; changed: string[] }> = [];
    for (const report of reports) {
      const stamp = readTaskInputChecksums(
        join(detectorsDir, report.replace(/\.md$/, '.inputs.json'))
      );
      if (!stamp) {
        unstamped.push(report);
        continue;
      }
      const detectorName = report.replace(/\.md$/, '');
      const changed = diffTaskInputs(stamp, currentInputs, detectorReportInputs(detectorName));
      staleness.detectors.push({
        report,
        status: changed.length > 0 ? 'stale' : 'fresh',
        method: 'checksums',
        changed,
        capturedAt: stamp.capturedAt,
        ...(stamp.capturedBy ? { capturedBy: stamp.capturedBy } : {}),
      });
      if (changed.length > 0) staleStamped.push({ report, changed });
    }
    if (staleStamped.length > 0) {
      // Grouped by cause, not unioned across reports: a report is only ever
      // stale on the inputs its own detector reads.
      const byCause = new Map<string, string[]>();
      for (const { report, changed } of staleStamped) {
        const cause = changed.join(' and ');
        byCause.set(cause, [...(byCause.get(cause) ?? []), report]);
      }
      const causes = [...byCause].map(([cause, reports]) => `${cause} → ${reports.join(', ')}`);
      const staleNames = staleStamped.map((s) => s.report);
      logger.warn(
        { stale: staleStamped },
        `These detector reports assessed an older revision of this task — you modified an input each one reads after it was written: ${causes.join('; ')}. Re-run those detectors (e.g. /${staleNames[0].replace(/\.md$/, '')}) and re-package.`
      );
      warnings.push(
        `${staleStamped.length} stale detector report(s) — ${causes.join('; ')} — ` +
          're-run them against the current task'
      );
    }

    const newestSource = ['instruction.md', ...presentGuidance]
      .map((rel) => ({ rel, full: join(taskDir, rel) }))
      .filter(({ full }) => existsSync(full))
      .reduce(
        (acc, doc) => {
          const mtimeMs = statSync(doc.full).mtimeMs;
          return mtimeMs > acc.mtimeMs ? { rel: doc.rel, mtimeMs } : acc;
        },
        { rel: '', mtimeMs: -Infinity }
      );
    const stale = unstamped.filter(
      (f) => statSync(join(detectorsDir, f)).mtimeMs < newestSource.mtimeMs
    );
    // Unstamped reports carry no durable evidence either way, so the mtime
    // heuristic never asserts freshness: it can escalate to `stale` (the
    // report provably predates a source doc) but otherwise the record says
    // `unknown` — same standard as a reference run with no recorded
    // checksums. `changed` stays empty on mtime records: the newest source
    // doc is what the report predates, not a diff of what changed (only a
    // checksum comparison can name that), so it goes in the log line below
    // rather than masquerading as per-component precision in staleness.json.
    for (const report of unstamped) {
      staleness.detectors.push({
        report,
        status: stale.includes(report) ? 'stale' : 'unknown',
        method: 'mtime',
        changed: [],
      });
    }
    if (unstamped.length > 0) {
      // Adoption visibility: stamping is agentic (detector skills follow
      // _detector-worker-shell.md), so non-adoption would otherwise be
      // silent — an unstamped report just quietly falls back to the weaker
      // mtime heuristic. Say so, so gaps are observable (and so we know when
      // the mtime branch can be deleted). Advisory log only — deliberately
      // not pushed onto `warnings`, so every pre-stamping report doesn't add
      // a packaging warning to every in-flight submission.
      logger.warn(
        { reports: unstamped },
        `${unstamped.length} detector report(s) have no input stamp (detectors/<name>.inputs.json), so staleness is judged by file mtime only. Reports written by a current toolkit are stamped automatically when the detector skill runs record-detector-inputs.ts.`
      );
    }
    if (stale.length > 0) {
      logger.warn(
        { stale, newerSource: newestSource.rel },
        `${stale.length} detector report(s) predate ${newestSource.rel} — they assessed an older revision of this task than the one being packaged. Re-run those detectors so the reports match what ships.`
      );
      warnings.push(
        `${stale.length} detector report(s) older than ${newestSource.rel}: ${stale.join(', ')} — ` +
          're-run them against the current task'
      );
    }
  }

  // Toolkit scripts. Edits here don't ship — but what the scripts write does, and
  // a task built by an altered build-workspace.sh looks normal from the outside.
  // Skipped silently when the toolkit ships no manifest (see toolkit-script-integrity.ts).
  const scriptIntegrity = checkToolkitScriptIntegrity(cwd);
  let scriptNotice: string | undefined;
  if (scriptIntegrity.checked) {
    const notice = scriptIntegrityNotice(scriptIntegrity);
    if (notice) {
      scriptNotice = notice;
      logger.warn(
        {
          edited: scriptIntegrity.modified.map((f) => f.path),
          missing: scriptIntegrity.missing.map((f) => f.path),
        },
        'Toolkit scripts need a look — full notice at the end of this run'
      );
      for (const f of scriptIntegrity.modified) {
        warnings.push(`toolkit script looks edited: ${f.path} — re-extract the toolkit zip`);
      }
      for (const f of scriptIntegrity.missing) {
        warnings.push(`toolkit script is missing: ${f.path} — re-extract the toolkit zip`);
      }
    }
  }

  // Toolkit-managed files. environment/Dockerfile, tests/test.sh and
  // tests/grader-system-prompt-consolidated.md ship from task-shared/ and are not the author's to
  // change: they decide how the trial runs and how the grade is produced, so an edit
  // makes the packaged reference runs mean something different from every other task's.
  // Skipped silently when the toolkit ships no baselines (see task-infra-integrity.ts).
  let infraNotice: string | undefined;
  const integrity = checkTaskInfraIntegrity(taskDir, cwd);
  if (integrity.checked) {
    const message = formatIntegrityReport(integrity);
    if (message) {
      infraNotice = bannerize(message, integrity);
      // Warnings, never errors. An author who edited one of these did it to get
      // unstuck, not knowing we'd rather hear about the problem — refusing to
      // package their finished work over that is the wrong trade. The verdict is
      // written into the package instead (below), so a reviewer sees it even
      // though nothing stopped the submission.
      logger.warn(
        {
          edited: integrity.modified.map((f) => f.taskPath),
          outdated: integrity.outdated.map((f) => f.taskPath),
          unverifiable: integrity.unverifiable.map((f) => f.taskPath),
        },
        'Toolkit-managed files need a look — full notice at the end of this run'
      );
      for (const f of integrity.modified) {
        warnings.push(
          `toolkit-managed file looks edited: ${f.taskPath} — restore the shipped copy`
        );
      }
      for (const f of integrity.outdated) {
        warnings.push(
          `toolkit-managed file is from an older release: ${f.taskPath} — scores not directly comparable`
        );
      }
      for (const f of integrity.unverifiable) {
        warnings.push(
          `toolkit-managed file matches no shipped copy: ${f.taskPath} — either an older release or an edit`
        );
      }
    }

    // Ship the verdict with the task. Nothing blocks any more, and the check can't
    // run on the far side (it needs the toolkit's task-shared/), so persisting it
    // here is the only way the signal survives packaging.
    writeFileSync(
      join(taskDir, INFRA_REPORT_FILENAME),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          files: integrity.files,
          scripts: scriptIntegrity.checked ? scriptIntegrity.files : undefined,
        },
        null,
        2
      )}\n`
    );
  }

  // Session JSONL: check for leaked snapshot commands
  const sessionJsonl = join(taskDir, 'environment', 'session.jsonl');
  if (existsSync(sessionJsonl)) {
    const sessionLines = readFileSync(sessionJsonl, 'utf-8').trimEnd().split('\n');
    const hasSnapshotCommand = sessionLines.some((line) => {
      try {
        const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
        return (
          entry.type === 'user' &&
          typeof entry.message?.content === 'string' &&
          entry.message.content.includes('create-snapshot:snapshot')
        );
      } catch {
        return false;
      }
    });
    if (hasSnapshotCommand) {
      logger.error(
        { file: 'environment/session.jsonl' },
        `The session history contains /create-snapshot commands. We don't want this, because snapshot creation is an artifact of our observation, and it wouldn't exist in the real world.

1. Long-term fix: next time you're creating multiple snapshots from a conversation, remember to /rewind after taking a snapshot so future convo steps don't have previous snapshots in the history.

2. Immediate fix: manually edit environment/session.jsonl to remove the snapshot command lines. Then you'll need to revalidate the task to make sure that the agent still repros the mistake.`
      );
      errors.push(
        'environment/session.jsonl contains a /create-snapshot command (observation artifact)'
      );
    }
  }

  // Reference runs. Zero is a hard error, not a warning: detector-run-behaviors and
  // detector-meaningful-failure reason OVER the reference runs, so with none there's no
  // signal to extract and the task can't be fully reviewed. (1-3 is allowed but
  // thin — a warning.)
  // Any subdirectory counts as a run — naming varies across toolkit versions
  // (reward-<r>-<id> today, other shapes in older tarballs), so nothing below
  // keys off the dir-name format.
  const refDir = join(taskDir, 'reference-runs');
  const runDirs = existsSync(refDir)
    ? readdirSync(refDir).filter((d) => statSync(join(refDir, d)).isDirectory())
    : [];
  const refCount = runDirs.length;

  const scores: number[] = [];
  const correctnessScores: number[] = [];
  const RECOMMENDED_REF_COUNT = 4;
  if (refCount === 0) {
    logger.error('No reference runs found. Run the task first:');
    logger.error(`  scripts/harbor-run harbor-tasks/${slug} -k 4`);
    errors.push(
      'no reference runs — detector-run-behaviors and detector-meaningful-failure cannot be assessed; ' +
        'run `scripts/harbor-run harbor-tasks/<slug> -k 4` and include reference-runs/'
    );
  } else {
    // A run killed mid-turn shows an agent that never got to finish, so its
    // transcript and score are not what it would have done. Below
    // RECOMMENDED_REF_COUNT total the count itself is only a warning, so an
    // errored run there stays a warning too — nothing to hold the package to.
    const aborted = findAbortedRuns(taskDir, runDirs);
    const validRefCount = refCount - aborted.length;
    const abortedDetail = aborted.map((a) => `${a.runId}: ${a.exceptionType}`).join(', ');
    const abortedBlocks =
      refCount >= RECOMMENDED_REF_COUNT && validRefCount < RECOMMENDED_REF_COUNT;
    if (abortedBlocks) {
      logger.error(
        { total: refCount, valid: validRefCount, aborted },
        `${aborted.length} of your ${refCount} reference runs ended in an error rather than the agent finishing its turn (${abortedDetail}), leaving only ${validRefCount} usable. Reviewers and detectors read over the reference runs, so ${RECOMMENDED_REF_COUNT} runs that finished cleanly are required. Re-run the failed trials and replace those run directories:`
      );
      logger.error(`  scripts/harbor-run harbor-tasks/${slug} -k ${aborted.length}`);
      errors.push(
        `only ${validRefCount} of ${refCount} reference runs finished cleanly (${abortedDetail}); ` +
          `${RECOMMENDED_REF_COUNT} runs that end with the agent finishing its turn are required — ` +
          're-run the failed trials and replace those run directories'
      );
    } else if (refCount < RECOMMENDED_REF_COUNT) {
      logger.warn(
        { count: refCount, recommended: RECOMMENDED_REF_COUNT },
        `Only ${refCount} reference run(s) found; ${RECOMMENDED_REF_COUNT}+ are recommended for finalized submissions to capture score variance. Continuing — but consider running more trials before finalizing:`
      );
      logger.warn(`  scripts/harbor-run harbor-tasks/${slug} -k 4`);
      warnings.push(
        `only ${refCount} reference run(s); ${RECOMMENDED_REF_COUNT}+ recommended for score variance`
      );
    }
    if (aborted.length > 0 && !abortedBlocks) {
      logger.warn(
        { aborted, valid: validRefCount },
        `${aborted.length} reference run(s) ended in an error rather than the agent finishing its turn (${abortedDetail}). This is not blocking — but consider re-running or dropping them, since a run killed mid-turn does not show what the agent would have done.`
      );
      warnings.push(
        `${aborted.length} reference run(s) ended in an error (${abortedDetail}); ${validRefCount} finished cleanly`
      );
    }
    logger.info({ count: refCount, valid: validRefCount }, 'Reference runs found');

    // The grader writes one reward per run (reward.txt); correctness lives
    // inside the graded criteria, and the companion reward-correctness.txt
    // reads the literal `N/A` by design. Report both files as found so the
    // pre-submission summary reflects exactly what each run directory carries.
    let correctnessNA = 0;
    for (const run of runDirs) {
      const rewardFile = join(refDir, run, 'reward.txt');
      if (existsSync(rewardFile)) {
        const score = parseFloat(readFileSync(rewardFile, 'utf-8').trim());
        if (!isNaN(score)) scores.push(score);
      }
      const correctnessFile = join(refDir, run, 'reward-correctness.txt');
      if (existsSync(correctnessFile)) {
        const raw = readFileSync(correctnessFile, 'utf-8').trim();
        if (/^n\/?a$/i.test(raw)) {
          correctnessNA++;
        } else {
          const score = parseFloat(raw);
          if (!isNaN(score)) correctnessScores.push(score);
        }
      }
    }
    if (scores.length > 0) {
      scores.sort((a, b) => a - b);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      logger.info(
        { scores: scores.map((s) => s.toFixed(2)), mean: mean.toFixed(2) },
        'Score distribution'
      );
    }
    if (correctnessScores.length > 0) {
      correctnessScores.sort((a, b) => a - b);
      const mean = correctnessScores.reduce((a, b) => a + b, 0) / correctnessScores.length;
      logger.info(
        {
          scores: correctnessScores.map((s) => s.toFixed(2)),
          mean: mean.toFixed(2),
          na: correctnessNA,
        },
        'Correctness score distribution'
      );
    }
  }

  // One harness per task — see checkHarnessConsistency above.
  {
    const harnessCheck = checkHarnessConsistency(taskDir, runDirs, cwd, logger);
    errors.push(...harnessCheck.errors);
    warnings.push(...harnessCheck.warnings);
  }

  // Stale reference runs. Each run records the checksums of the task inputs
  // it was generated against (input-checksums.json, written by
  // copy-reference-run.ts): the prompt, the session snapshot, the workspace
  // patch, and the gitref. If any of those changed since, the run shows an
  // agent doing a DIFFERENT task than the one being packaged — the most common
  // way this happens is a worker editing their prompt after their trials and
  // forgetting to redo them. Holistic-rubric edits are deliberately not in
  // this set (they stale the grade, not the run — that's a regrade, not a
  // rerun). Runs with no recorded checksums predate this tracking; their
  // staleness is unknowable, which gets said once rather than presumed either
  // way.
  const staleRunGroups = new Map<string, { changed: string[]; runIds: string[] }>();
  const unverifiableRuns: string[] = [];
  for (const run of runDirs) {
    const recorded = readTaskInputChecksums(join(refDir, run, INPUT_CHECKSUMS_FILENAME));
    if (!recorded) {
      unverifiableRuns.push(run);
      staleness.referenceRuns.push({ runId: run, status: 'unknown', changed: [] });
      continue;
    }
    const changed = diffTaskInputs(recorded, currentInputs, REFERENCE_RUN_INPUTS);
    staleness.referenceRuns.push({
      runId: run,
      status: changed.length > 0 ? 'stale' : 'fresh',
      changed,
      capturedAt: recorded.capturedAt,
      ...(recorded.capturedBy ? { capturedBy: recorded.capturedBy } : {}),
    });
    if (changed.length > 0) {
      const key = changed.join('|');
      const group = staleRunGroups.get(key) ?? { changed, runIds: [] };
      group.runIds.push(run);
      staleRunGroups.set(key, group);
    }
  }
  for (const { changed, runIds } of staleRunGroups.values()) {
    logger.warn(
      { runs: runIds, changed },
      `You modified your ${changed.join(' and ')} after these reference runs were captured, so they are stale: ${runIds.join(', ')}. Re-run the task and re-copy the runs:`
    );
    logger.warn(`  scripts/harbor-run harbor-tasks/${slug} -k 4`);
    warnings.push(
      `${runIds.length} stale reference run(s) — ${changed.join(', ')} changed since they were captured: ${runIds.join(', ')} — ` +
        're-run the task and re-copy the runs'
    );
  }
  if (unverifiableRuns.length > 0) {
    logger.warn(
      { runs: unverifiableRuns },
      // The last sentence is transitional: it exists because every run captured
      // before checksum tracking shipped triggers this warning, so everyone's
      // first submission after the toolkit update shows it. Remove that sentence
      // in the next toolkit release once the skew clears (around 2026-08-05) —
      // tracked in the source repo's issue #748. (Issue number, not URL: this
      // file ships in the worker toolkit, which stays free of internal-infra
      // references.)
      `${unverifiableRuns.length} reference run(s) predate input-checksum tracking, so staleness can't be verified for them. If you've edited your prompt, session snapshot, workspace patch, or gitref since these runs were captured, re-run the task and re-copy the runs. If this is your first submission since updating the toolkit, this warning is expected — runs captured before the update have no recorded checksums; re-copying the reference runs will record them.`
    );
    warnings.push(
      `${unverifiableRuns.length} reference run(s) have no recorded input checksums (captured with an older toolkit) — ` +
        `staleness unverifiable: ${unverifiableRuns.join(', ')}`
    );
  }

  // Workspace
  const workspaceDir = join(taskDir, 'environment', 'workspace');
  let workspaceFiles = 0;
  if (existsSync(workspaceDir)) {
    const wsFiles = execSync(`find "${workspaceDir}" -type f | wc -l`, {
      encoding: 'utf-8',
    }).trim();
    workspaceFiles = parseInt(wsFiles, 10);
    logger.info({ files: workspaceFiles }, 'Workspace included');
  } else {
    logger.warn('No workspace directory — task will need workspace built before running');
    warnings.push('no environment/workspace directory (workspace must be built before running)');
  }

  // Persist the staleness record inside the task dir so it ships in the
  // tarball. Warnings are easy to package past; this file is the durable
  // copy a reviewer sees — and since the review pipeline runs validateTask
  // again after unpacking, the record is refreshed there too, so a review can
  // rely on it no matter which pipeline (or toolkit version) produced the
  // tarball. A write failure downgrades to a warning: the record is advisory
  // and must never block validation itself.
  try {
    writeFileSync(
      join(taskDir, STALENESS_REPORT_FILENAME),
      JSON.stringify(staleness, null, 2) + '\n'
    );
  } catch (err) {
    logger.warn({ err }, `Could not write ${STALENESS_REPORT_FILENAME}`);
  }

  return {
    hasErrors: errors.length > 0,
    infraNotice,
    scriptNotice,
    errors,
    warnings,
    refCount,
    scores,
    correctnessScores,
    workspaceFiles,
    staleness,
  };
}

// --- CLI entrypoint ---
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = yargs(hideBin(process.argv))
    .usage('$0 <slug>', 'Validate and package a task for submission', (y) =>
      y.positional('slug', { type: 'string', demandOption: true, describe: 'Task slug' })
    )
    .option('json', {
      type: 'boolean',
      describe: 'Output structured JSON logs',
      default: false,
    })
    .help()
    .parseSync();

  const slug = argv.slug as string;

  const log = pino(
    { name: 'submit-task', level: 'info' },
    argv.json
      ? process.stdout
      : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' })
  );

  const result = validateTask(slug, log);

  if (result.hasErrors) {
    log.fatal('Validation failed. Fix the issues above before submitting.');
    process.exit(1);
  }

  // Enumerate, don't just count: a check that pushes a warning without logging one
  // otherwise leaves a total the worker cannot account for.
  if (result.warnings.length > 0) {
    log.warn(
      { count: result.warnings.length },
      `Packaging with ${result.warnings.length} warning(s) — reviewers run these same checks and will see them too. Fixing them before submitting saves a review round-trip.\n${result.warnings
        .map((w, i) => `  ${i + 1}. ${w}`)
        .join('\n')}`
    );
  }

  // Create tarball. Exclude environment/corpus/ — it's a large, regenerable build artifact
  // (staged by build-workspace when a task references the reference-data corpus); shipping it
  // would bloat the upload by gigabytes. It's re-materialized at build time from the toolkit's
  // own copy, so the deliverable only needs the Dockerfile's reference to it.
  const tarball = `${slug}.tar.gz`;
  const tarCmd = `tar czf "${tarball}" --exclude="${slug}/environment/corpus" -C harbor-tasks "${slug}"`;
  const runTar = (): void => {
    execSync(tarCmd, { stdio: 'pipe' });
  };

  const taskDir = join('harbor-tasks', slug);

  // tar records each file's mode as-is, and this container runs as root — so a
  // write-only file (Claude Code writes subagent session records --w-------) is
  // archived, not refused, and every later extraction of it is unreadable.
  // Normalize before packing; the catch below still repairs what only tar can see.
  try {
    const pre = normalizeTreePermissions(taskDir);
    if (didRepair(pre)) {
      log.info(
        { ownerFixed: pre.ownerFixed.length, modeFixed: pre.modeFixed.length },
        'Normalized workspace permissions before packaging'
      );
    }
    if (pre.failures.length > 0) {
      log.warn(
        { count: pre.failures.length, paths: pre.failures.slice(0, 5).map((f) => f.path) },
        `Could not normalize some paths. If the tarball has unreadable files, run:\n  ${manualRepairHint(taskDir)}`
      );
    }
  } catch (repairErr) {
    log.warn(
      { err: repairErr },
      `Permission normalization failed — packaging anyway. If the tarball has unreadable files, run:\n  ${manualRepairHint(taskDir)}`
    );
  }

  try {
    runTar();
  } catch (err) {
    // Usually a permissions problem: something under harbor-tasks/<slug> isn't
    // readable by you, so tar can't walk it. Say which paths, repair, retry once.
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    const denied = [...stderr.matchAll(/^tar: (.+?): Cannot (?:stat|open)/gm)].map((m) => m[1]);
    if (denied.length === 0) throw err;

    log.warn(
      { paths: denied.slice(0, 5), total: denied.length },
      'Packaging hit a permissions error — attempting to repair ownership and modes'
    );
    for (const rel of denied.slice(0, 5)) {
      const abs = join('harbor-tasks', rel);
      try {
        const st = statSync(abs);
        log.warn(
          { path: rel, uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) },
          'offending path'
        );
      } catch {
        // Can't even stat it from here — the repair below is the only recourse.
      }
    }

    // Guarded so a failed repair can't mask the real packaging error.
    let perms;
    try {
      perms = normalizeTreePermissions(taskDir);
    } catch (repairErr) {
      log.error({ err: repairErr }, 'Permission repair failed unexpectedly');
      log.fatal(
        `Could not repair automatically. Run this on the host and try again:\n` +
          `  ${manualRepairHint(taskDir)}`
      );
      throw err;
    }
    if (!didRepair(perms)) {
      log.fatal(
        `Nothing could be repaired automatically. Run this on the host and try again:\n` +
          `  ${manualRepairHint(taskDir)}`
      );
      throw err;
    }
    log.info(
      { ownerFixed: perms.ownerFixed.length, modeFixed: perms.modeFixed.length },
      'Repaired workspace permissions — retrying'
    );
    try {
      runTar();
    } catch (retryErr) {
      log.fatal(
        `Still failing after repair. Run this on the host and try again:\n` +
          `  ${manualRepairHint(taskDir)}`
      );
      throw retryErr;
    }
  }

  const tarSize = statSync(tarball).size;
  const tarSizeMB = (tarSize / 1024 / 1024).toFixed(1);

  log.info(
    { tarball, sizeMB: tarSizeMB, referenceRuns: result.refCount },
    'Task packaged — upload the tarball to the project'
  );

  // Last word, deliberately: nothing about the managed files stops the package, so a
  // notice printed before the packaging summary is one the author has already
  // scrolled past by the time they read "Task packaged".
  //
  // Emitted through the logger rather than written to a stream directly. pino-pretty's
  // destination is async, so a synchronous process.stdout/stderr write races ahead of
  // pino's queued lines and lands near the TOP of a piped log — which is exactly the
  // "nobody reads it" problem this placement exists to solve.
  if (result.scriptNotice) {
    log.warn(`\n\n${result.scriptNotice}`);
  }

  if (result.infraNotice) {
    log.warn(`\n\n${result.infraNotice}`);
  }
}
