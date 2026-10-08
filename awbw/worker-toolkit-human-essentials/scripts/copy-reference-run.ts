/**
 * copy-reference-run.ts - Copy Harbor job trials into a task's reference-runs directory.
 *
 * Usage:
 *   npx tsx scripts/copy-reference-run.ts <trial-path> [trial-path...]
 *   npx tsx scripts/copy-reference-run.ts --rubric-regrade <trial-path>
 *   npx tsx scripts/copy-reference-run.ts --supersede <old-run-dir> <trial-path>
 *
 * Examples:
 *   # Copy a single trial
 *   npx tsx scripts/copy-reference-run.ts harbor-jobs/2026-04-02__11-43-55/my-task-slug__3Df3Bjr
 *
 *   # Copy all trials from a job
 *   npx tsx scripts/copy-reference-run.ts harbor-jobs/2026-04-02__11-43-55/my-task-slug__*
 *
 * What gets copied:
 *   - verifier/agent-output/ (answer.md, etc.)
 *   - verifier/reward.txt (the run's reward) + reward-correctness.txt (reads
 *     N/A by design — correctness lives inside the graded criteria)
 *   - verifier/reward.json (the machine-readable reward record)
 *   - verifier/signals-status.txt (whether every deterministic check actually ran,
 *     i.e. whether the signals the grader was fed are complete)
 *   - verifier/grade.md + every grade-<N>.md grader sample
 *   - verifier/grader-result(-<N>).json, grader-stderr(-<N>).log, grader-samples.txt
 *   - verifier/grader-regime.json (the grading regime this grade actually ran
 *     under — unrecoverable after the fact, so it must travel with the grade)
 *   - agent/claude-code.txt or agent/codex.txt (the harness's own log), agent/trajectory.json
 *   - session.jsonl — the resumable session log, hoisted to the top of the run dir so
 *     `view-harbor-session.ts <run-dir>/session.jsonl` can load it without further
 *     indirection. Its location is per harness: Claude Code writes
 *     `agent/sessions/projects/-workspace/<id>.jsonl` with the id printed in
 *     `agent/claude-code.txt`; codex writes `agent/sessions/<Y>/<M>/<D>/rollout-*.jsonl`.
 *   - verifier/test-stdout.txt (the verifier's console output, where the reward is printed)
 *   - verifier/deterministic-signals.txt, verifier/rubric-grade(-<N>).json
 *   - config.json, result.json, trial.log
 *   - input-checksums.json — sha256 checksums of the task inputs the run was
 *     generated against (prompt, session snapshot, workspace patch, gitref),
 *     so submit-task.ts can warn when the run goes stale. Copied from the
 *     trial dir when harbor-run stamped one at launch time (capturedBy:
 *     'run' — immune to edits made between the run and this copy);
 *     otherwise captured here at copy time as a fallback (capturedBy:
 *     'copy').
 *
 * --rubric-regrade files an atomic-rubric regrade into rubric-regrades/<run>/
 * instead: a second grade of a run that keeps its own, under the name the trial
 * itself records for the run it graded. The trial is copied verbatim — verifier/
 * and all — so a stored grade has the same shape whoever stored it.
 *
 * --supersede is the other direction: a holistic regrade replaces a run's grade,
 * and the new copy lands under a name minted from the NEW reward and trial id, so
 * adopting it means removing the directory it supersedes. Deleting is deliberate
 * over merging into the old directory: a regrade grades a different number of
 * samples than the run often did, so a merge would leave grade-2.md/grade-3.md
 * from the previous grade beside the new grade-1.md with nothing marking the
 * generation. A swapped directory holds exactly one grade by construction. The
 * cost is the old run's session.jsonl, which a replay cannot reproduce; the
 * trajectory it would be needed to rebuild travels with the replay itself.
 *
 * What is NOT copied:
 *   - agent/sessions/, agent/setup/ (workspace data — the resumable JSONL
 *     is hoisted out as `session.jsonl` above; everything else here is
 *     untyped workspace state)
 *   - artifacts/
 */

import './lib/check-devcontainer';

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, join, resolve } from 'path';

// This script must not call cpSync — it fails EACCES on a macOS docker bind mount.
import { copyPath, copyTree } from './lib/copy-tree';
import {
  captureTaskInputs,
  INPUT_CHECKSUMS_FILENAME,
  readTaskInputChecksums,
} from './lib/input-checksums';
import { manualRepairHint, normalizeTreePermissions } from './lib/tree-permissions';
import { readSessionId } from './session-id';

const HARBOR_TASKS_DIR = 'harbor-tasks';

function findTaskDir(trialPrefix: string): string | null {
  if (!existsSync(HARBOR_TASKS_DIR)) return null;
  const entries = readdirSync(HARBOR_TASKS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(trialPrefix)) {
      return join(HARBOR_TASKS_DIR, entry.name);
    }
  }
  return null;
}

/** Newest `rollout-*.jsonl` anywhere under a codex `sessions/` tree, or null. */
function newestRollout(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) return null;
  const found: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        found.push({ path: full, mtime: statSync(full).mtimeMs });
      }
    }
  };
  walk(sessionsDir);
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].path;
}

/** What a replay trial records about itself: the run it graded, and whether the
 *  grade came from a rubric grader mode rather than the holistic one. */
function readReplayProvenance(trialPath: string): {
  sourceRun: string | null;
  rubricMode: boolean;
} {
  let config: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(trialPath, 'result.json'), 'utf-8')) as {
      config?: Record<string, unknown>;
    };
    config = parsed.config;
  } catch {
    config = undefined;
  }
  const agent = (config?.agent ?? {}) as { kwargs?: { reference_run_dir?: unknown } };
  const src = agent.kwargs?.reference_run_dir;
  const verifier = (config?.verifier ?? {}) as { env?: Record<string, unknown> };
  const graderMode = verifier.env?.GRADER_MODE;
  // Either marker is enough: the env records the mode harbor was handed, the
  // rubric-grade file records what the grader actually produced.
  const rubricMode =
    (typeof graderMode === 'string' && graderMode.startsWith('rubric-')) ||
    existsSync(join(trialPath, 'verifier', 'rubric-grade.json'));
  return {
    sourceRun: typeof src === 'string' && src.length > 0 ? basename(src.replace(/\/+$/, '')) : null,
    rubricMode,
  };
}

/**
 * Resolve the task dir from the trial's result.json `task_name` — the FULL,
 * unambiguous slug. Harbor TRUNCATES long task names in the trial DIRNAME, so two
 * distinct tasks sharing a truncated prefix (e.g. `foo--hash` and `foo--hash-2`,
 * both truncating to `foo--ha`) collide: a dirname-prefix scan returns whichever
 * sorts first and misroutes the other's trials (observed in the wild as base +
 * `-2` reference-runs sharing trial IDs). result.json is written per-trial with
 * the real task_name, so it disambiguates exactly. Returns null when result.json
 * is absent/unparseable or names a task dir that doesn't exist (caller then falls
 * back to the prefix scan).
 */
function findTaskDirByResultJson(trialPath: string): string | null {
  const resultPath = join(trialPath, 'result.json');
  if (!existsSync(resultPath)) return null;
  let taskName: unknown;
  try {
    taskName = (JSON.parse(readFileSync(resultPath, 'utf-8')) as { task_name?: unknown }).task_name;
  } catch {
    return null;
  }
  if (typeof taskName !== 'string' || taskName.length === 0) return null;
  // Hub-published task_names are org-prefixed (`<org>/<slug>`); the dir is bare.
  // Inlined (not the shared bareSlug helper) because this script ships in the
  // worker toolkit and must not import outside its shipped file set.
  const dir = join(HARBOR_TASKS_DIR, taskName.replace(/^[^/]+\//, ''));
  return existsSync(dir) ? dir : null;
}

function copyTrial(
  trialPath: string,
  opts: { destName?: string; rubricRegrade?: boolean; supersede?: string } = {}
) {
  const { destName, rubricRegrade = false, supersede } = opts;
  trialPath = trialPath.replace(/\/$/, '');

  if (!existsSync(trialPath)) {
    console.error(`Error: ${trialPath} does not exist`);
    process.exit(1);
  }

  // Repair the SOURCE before reading a byte of it. A trial can leave files
  // write-only, which locks out their own owner: everything below — reading
  // reward.txt, copying agent-output — fails on them, and any that do get
  // through land in the task dir, where harbor hashes every file on every
  // later trial and one unreadable path aborts the run.
  let sourcePerms = null;
  try {
    sourcePerms = normalizeTreePermissions(trialPath);
  } catch (err) {
    console.warn(`Warning: could not normalize permissions on ${trialPath}: ${String(err)}`);
    console.warn(`         If the copy below fails on permissions:`);
    console.warn(`           ${manualRepairHint(trialPath)}`);
  }
  if (sourcePerms && sourcePerms.failures.length > 0) {
    console.warn(
      `Warning: could not normalize permissions on ${sourcePerms.failures.length} path(s) under ${trialPath}.`
    );
    console.warn(`         If the copy below fails on permissions, run:`);
    console.warn(`           ${manualRepairHint(trialPath)}`);
  }

  const rewardPath = join(trialPath, 'verifier', 'reward.txt');
  if (!existsSync(rewardPath)) {
    console.error(`Error: No reward.txt found in ${trialPath}/verifier/`);
    process.exit(1);
  }

  const reward = readFileSync(rewardPath, 'utf-8').trim();
  const trialDir = basename(trialPath);

  // Trial dir format: <task-slug-truncated>__<trialId>
  const separatorIndex = trialDir.lastIndexOf('__');
  if (separatorIndex === -1) {
    console.error(
      `Error: Trial directory '${trialDir}' does not match expected format <slug>__<trialId>`
    );
    process.exit(1);
  }

  const trialPrefix = trialDir.substring(0, separatorIndex);
  const trialId = trialDir.substring(separatorIndex + 2);

  // Prefer the exact task_name from result.json (handles truncated-prefix
  // collisions like `foo--hash` vs `foo--hash-2`); fall back to the dirname
  // prefix scan only when result.json can't resolve it.
  const taskDir = findTaskDirByResultJson(trialPath) ?? findTaskDir(trialPrefix);
  if (!taskDir) {
    console.error(
      `Error: Could not find task directory matching prefix '${trialPrefix}' in ${HARBOR_TASKS_DIR}/`
    );
    console.error('Available tasks:');
    readdirSync(HARBOR_TASKS_DIR).forEach((d) => console.error(`  ${d}`));
    process.exit(1);
  }

  // destName (--dest-name) makes a RECORDED rollout id authoritative: the run
  // is copied to exactly that name instead of the minted reward-<r>-<id> —
  // used by the SxS pipeline so task.toml preference_rollouts, this dir, and
  // the publish-manifest run_id stay byte-identical by construction.
  let dest = join(taskDir, 'reference-runs', destName ?? `reward-${reward}-${trialId}`);
  const prov = readReplayProvenance(trialPath);
  // An atomic grade in reference-runs/ would overwrite the holistic grade it exists
  // to be compared against, and the two are not interchangeable.
  if (!rubricRegrade && prov.rubricMode) {
    console.error(
      `Error: ${trialPath} is an atomic-rubric regrade, which does not belong in ` +
        `reference-runs/. File it beside the run it graded:\n` +
        `  npx tsx scripts/copy-reference-run.ts --rubric-regrade ${trialPath}`
    );
    process.exit(1);
  }
  if (rubricRegrade) {
    if (!prov.rubricMode) {
      console.error(
        `Error: ${trialPath} is not an atomic-rubric regrade (no rubric grader mode ` +
          `in result.json, no verifier/rubric-grade.json). A holistic regrade replaces ` +
          `the run's own grade — copy it without --rubric-regrade.`
      );
      process.exit(1);
    }
    if (!prov.sourceRun) {
      console.error(
        `Error: ${trialPath}/result.json records no reference_run_dir, so there is no ` +
          `run to file this regrade under. Copy it by hand into ` +
          `${join(taskDir, 'rubric-regrades')}/<run-id>/.`
      );
      process.exit(1);
    }
    dest = join(taskDir, 'rubric-regrades', prov.sourceRun);
  }

  // Build in a sibling directory and swap at the end. A grade costs 15-30 minutes and
  // cannot be reproduced exactly, so an interrupted copy must leave the stored one intact.
  const staged = `${dest}.staging-${process.pid}`;
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });

  // A stored atomic grade is the trial verbatim. Matching that shape exactly matters
  // more than trimming it: grades stored by hand have it, and a reviewer opening one
  // should not have to work out which way it was written.
  if (rubricRegrade) {
    copyTree(trialPath, staged);
  } else {
    // Copy verifier outputs. The grader writes one reward (reward.txt) with its
    // companion reward-correctness.txt (N/A by design) and the machine-readable
    // reward.json, plus signals-status.txt, its aggregate reasoning (grade.md)
    // PLUS one grade-<N>.md per grader sample, the structured grade(-<N>).json
    // (the source of truth grade.md/reward.txt are rendered from), the
    // machine-readable grader-result(-<N>).json, the grader-stderr(-<N>).log,
    // render-stderr(-<N>).log, and grader-samples.txt.
    // Copy the whole set — glob so it stays agnostic to the sample count. (Earlier
    // this took only reward.txt/grade.md/grader-stderr.log and silently dropped
    // every per-sample record.)
    //
    // signals-status.txt qualifies the deterministic signals the grader was fed:
    // it records whether every deterministic check actually produced a verdict
    // ("ok") or one or more was killed before finishing ("degraded" — the grade
    // is then NOT fully signal-backed). Without it a copied run is
    // indistinguishable from a run whose checks all passed, so it must travel
    // with the reward files.
    const verifierDir = join(trialPath, 'verifier');
    if (existsSync(verifierDir)) {
      for (const entry of readdirSync(verifierDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const f = entry.name;
        if (
          f === 'reward.json' ||
          f === 'signals-status.txt' ||
          f === 'grader-samples.txt' ||
          f === 'grader-regime.json' ||
          f === 'test-stdout.txt' ||
          f === 'deterministic-signals.txt' ||
          /^reward(-\d+)?\.txt$/.test(f) ||
          /^reward-correctness(-\d+)?\.txt$/.test(f) ||
          /^grade(-\d+)?\.md$/.test(f) ||
          /^grade(-\d+)?\.json$/.test(f) ||
          /^rubric-grade(-\d+)?\.json$/.test(f) ||
          /^grader-result(-\d+)?\.json$/.test(f) ||
          /^grader-stderr(-\d+)?\.log$/.test(f) ||
          // The renderer retries, so the real name is render-stderr-<sample>-attempt<n>.log.
          /^render-stderr(-\d+)?(-attempt\d+)?\.log$/.test(f)
        ) {
          copyPath(join(verifierDir, f), join(staged, f));
        }
      }
    }

    // A rubric regrade re-grades a run that already ships its own agent-output,
    // trajectory and session; a second copy would only double the tarball.
    const agentOutputDir = join(verifierDir, 'agent-output');
    if (!rubricRegrade && existsSync(agentOutputDir)) {
      copyTree(agentOutputDir, join(staged, 'agent-output'));
    }

    // Copy agent session log and trajectory (not workspace)
    const agentDir = join(trialPath, 'agent');
    if (!rubricRegrade && existsSync(agentDir)) {
      mkdirSync(join(staged, 'agent'), { recursive: true });
      // The agent's own log is named per harness (claude-code.txt / codex.txt); copying only
      // the Claude one left codex reference runs with nothing but the trajectory.
      for (const file of ['claude-code.txt', 'codex.txt', 'trajectory.json']) {
        const src = join(agentDir, file);
        if (existsSync(src)) copyPath(src, join(staged, 'agent', file));
      }
      // The grader (and downstream worldbench export / replay) reads
      // agent/trajectory.json. If it's missing, scream so we don't silently
      // ship a reference run that's only half-useful.
      if (!existsSync(join(agentDir, 'trajectory.json'))) {
        console.warn(
          `WARNING: ${trialPath}/agent/trajectory.json is missing. ` +
            `Harbor's adapter for this harness failed to write it (typically because ` +
            `the converter choked on the session log). Downstream consumers ` +
            `(grader replay, worldbench export) need this file — investigate ` +
            `before relying on this reference run.`
        );
      }
      // Hoist the resumable session JSONL to <run-dir>/session.jsonl. The id
      // gets embedded in claude-code.txt's first non-empty line; we use it to
      // locate the sibling JSONL Claude Code wrote in the same trial.
      // Layout is per harness, so each needs a case here — the same reason
      // harness-session.mjs has one finder per CLI. A harness with no case gets no hoisted
      // session, which is what codex got before this: nothing at all.
      // Silent when there is nothing to hoist: no shipped tool reads this file and nothing
      // validates it, so its absence is not worth a line of output.
      const claudeCodeTxt = join(agentDir, 'claude-code.txt');
      if (existsSync(claudeCodeTxt)) {
        // Claude Code: the id is in claude-code.txt, the JSONL is its sibling.
        const sessionId = readSessionId(claudeCodeTxt);
        if (sessionId) {
          const jsonl = join(agentDir, 'sessions', 'projects', '-workspace', `${sessionId}.jsonl`);
          if (existsSync(jsonl)) copyPath(jsonl, join(staged, 'session.jsonl'));
        }
      } else {
        // codex: sessions/<Y>/<M>/<D>/rollout-<ts>-<id>.jsonl, newest wins.
        const rollout = newestRollout(join(agentDir, 'sessions'));
        if (rollout) copyPath(rollout, join(staged, 'session.jsonl'));
      }
    }

    // Copy top-level metadata. result.json is what makes a regrade self-describing
    // (which run it graded, under which grader mode), so it travels either way.
    for (const file of rubricRegrade
      ? ['result.json']
      : ['config.json', 'result.json', 'trial.log']) {
      const src = join(trialPath, file);
      if (existsSync(src)) copyPath(src, join(staged, file));
    }

    // Not for a rubric regrade: this input set is what stales a RUN (prompt, snapshot,
    // patch, gitref), and the run it re-graded already carries its own stamp.
    if (!rubricRegrade) {
      // Record the checksums of the task inputs this run was generated against
      // (prompt, session snapshot, workspace patch, gitref, holistic rubric).
      // submit-task.ts re-captures at packaging time and warns when any of them
      // changed — the run then describes an older revision of the task than the
      // one being shipped. Preferred source: the launch-time stamp harbor-run
      // wrote into the trial dir (scripts/stamp-trial-inputs.ts, capturedBy:
      // 'run') — it records the inputs the agent actually ran against, so an
      // input edited BETWEEN harbor-run and this copy is still caught. Fallback
      // (trials from an older harbor-run, or a failed stamp): capture here at
      // copy time, marked capturedBy: 'copy' so staleness.json is honest about
      // the weaker evidence.
      const trialStampPath = join(trialPath, INPUT_CHECKSUMS_FILENAME);
      const trialStamp = readTaskInputChecksums(trialStampPath);
      // A stamp that names a DIFFERENT task got mis-routed (e.g. concurrent
      // harbor-runs sharing a cwd) — its hashes describe some other task's
      // inputs, so treat it as absent rather than importing false evidence.
      const stampSlug = trialStamp?.taskSlug;
      const stampMisrouted = typeof stampSlug === 'string' && stampSlug !== basename(taskDir);
      if (trialStamp && !stampMisrouted) {
        copyPath(trialStampPath, join(staged, INPUT_CHECKSUMS_FILENAME));
      } else {
        if (stampMisrouted) {
          console.warn(
            `Warning: ${trialStampPath} was captured for task '${stampSlug}', not ` +
              `'${basename(taskDir)}' — ignoring it and capturing at copy time instead`
          );
        }
        writeFileSync(
          join(staged, INPUT_CHECKSUMS_FILENAME),
          JSON.stringify(captureTaskInputs(taskDir, 'copy'), null, 2) + '\n'
        );
      }
    }
  }

  // Files captured from a run can land unreadable to you, which makes packaging
  // fail later. Fix that now. Guarded so it can never fail a copy that worked.
  let perms = null;
  try {
    perms = normalizeTreePermissions(staged);
  } catch (err) {
    console.warn(`Warning: could not normalize permissions on ${dest}: ${String(err)}`);
    console.warn(`         The run copied fine. If packaging later fails on permissions:`);
    console.warn(`           ${manualRepairHint(dest)}`);
  }
  if (perms && perms.failures.length > 0) {
    console.warn(
      `Warning: could not normalize permissions on ${perms.failures.length} path(s) under ${dest}.`
    );
    console.warn(
      `         If packaging later fails with 'Cannot stat: Permission denied', run:\n` +
        `           ${manualRepairHint(dest)}`
    );
  }

  if (existsSync(dest)) {
    console.warn(`Warning: ${dest} already exists, overwriting`);
    rmSync(dest, { recursive: true });
  }
  renameSync(staged, dest);

  // Remove what this copy supersedes, now that the copy is on disk. Skipped when the
  // minted name landed on the superseded directory itself — that is the copy, not a
  // leftover.
  if (supersede) {
    const old = resolve(supersede);
    if (!existsSync(old)) {
      console.warn(`Warning: nothing to supersede at ${supersede} — it is already gone`);
    } else if (old === resolve(dest)) {
      console.log(`Superseded ${supersede} in place (same name)`);
    } else {
      // A stored atomic grade is keyed on the run's folder name, and superseding
      // changes that name. Move it with the run — it grades the same behaviour — or
      // it is left pointing at a run that no longer exists.
      const storedGrade = join(taskDir, 'rubric-regrades', basename(old));
      const movedGrade = join(taskDir, 'rubric-regrades', basename(dest));
      if (existsSync(storedGrade) && existsSync(movedGrade)) {
        console.warn(
          `Warning: ${storedGrade} names the superseded run, but ${movedGrade} already ` +
            `exists. Leaving both — remove whichever is obsolete.`
        );
      } else if (existsSync(storedGrade)) {
        renameSync(storedGrade, movedGrade);
        console.log(`Moved the stored atomic grade to ${movedGrade}`);
        console.log('  It grades the same run. Grade it again under the atomic rubric');
        console.log('  if the rubric changed since it was stored.');
      }
      rmSync(old, { recursive: true });
      console.log(`Superseded ${supersede} (removed)`);
    }
  }

  console.log(`Copied to ${dest}`);
  console.log(`  reward: ${reward}`);
  console.log(`  task:   ${taskDir}`);
  console.log(`  trial:  ${trialId}`);
  const ownerFixed = (sourcePerms?.ownerFixed.length ?? 0) + (perms?.ownerFixed.length ?? 0);
  const modeFixed = (sourcePerms?.modeFixed.length ?? 0) + (perms?.modeFixed.length ?? 0);
  if (ownerFixed > 0 || modeFixed > 0) {
    console.log(`  perms:  normalized ${ownerFixed} owner / ${modeFixed} mode`);
  }
}

// Main
const rawArgs = process.argv.slice(2);
let destName: string | undefined;
let rubricRegrade = false;
let supersede: string | undefined;
const args: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--rubric-regrade') {
    rubricRegrade = true;
  } else if (rawArgs[i] === '--supersede') {
    supersede = rawArgs[++i];
    if (!supersede) {
      console.error('Error: --supersede requires the run directory being replaced');
      process.exit(1);
    }
  } else if (rawArgs[i] === '--dest-name') {
    destName = rawArgs[++i];
    if (!destName) {
      console.error('Error: --dest-name requires a value');
      process.exit(1);
    }
  } else {
    args.push(rawArgs[i]);
  }
}

if (args.length === 0) {
  console.error(
    'Usage: npx tsx scripts/copy-reference-run.ts [--dest-name <run-id>] <trial-path> [trial-path...]\n' +
      '       npx tsx scripts/copy-reference-run.ts --rubric-regrade <trial-path>\n' +
      '       npx tsx scripts/copy-reference-run.ts --supersede <old-run-dir> <trial-path>'
  );
  process.exit(1);
}
if (destName && args.length !== 1) {
  console.error('Error: --dest-name applies to exactly one trial path');
  process.exit(1);
}
if (supersede && args.length !== 1) {
  console.error('Error: --supersede applies to exactly one trial path');
  process.exit(1);
}
if (supersede && rubricRegrade) {
  console.error('Error: --rubric-regrade adds a grade beside a run; there is nothing to supersede');
  process.exit(1);
}
if (destName && rubricRegrade) {
  console.error(
    'Error: --rubric-regrade takes its name from the trial, so --dest-name cannot apply'
  );
  process.exit(1);
}

for (const trialPath of args) {
  copyTrial(trialPath, { destName, rubricRegrade, supersede });
}
