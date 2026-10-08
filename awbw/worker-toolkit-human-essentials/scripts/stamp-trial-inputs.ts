/**
 * stamp-trial-inputs.ts — record, at trial LAUNCH time, the checksums of the
 * task inputs a harbor run is about to execute against, and stamp them into
 * the trial directories the run produces.
 *
 * Why launch time: copy-reference-run.ts used to capture checksums at COPY
 * time, which misses the headline staleness ordering — run trials, edit the
 * prompt, then copy the runs — and records the post-edit hashes (a genuinely
 * stale run then reads `fresh`). Harbor creates trial dirs itself (and, on
 * the daytona backend, populates them only at download after the trial), so
 * the earliest host-side point to capture is the moment `scripts/harbor-run`
 * launches: `capture` snapshots the inputs to a temp file before harbor
 * starts, and `apply` copies that snapshot into each trial dir once the job
 * directory exists. copy-reference-run.ts then prefers this run-time record
 * over its own capture-at-copy fallback.
 *
 * Usage (normally invoked by scripts/harbor-run, not by hand):
 *   npx tsx scripts/stamp-trial-inputs.ts capture <task-dir> --out <file>
 *   npx tsx scripts/stamp-trial-inputs.ts apply <capture-file> <job-dir> [job-dir...]
 *
 * Ships in the worker toolkit (see raccoon-worker-toolkit/package-worker-toolkit.ts),
 * so it must only import from its shipped file set — same constraint as
 * copy-reference-run.ts.
 */

import './lib/check-devcontainer';

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'path';

import {
  INPUT_CHECKSUMS_FILENAME,
  captureTaskInputs,
  readTaskInputChecksums,
} from './lib/input-checksums';

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/stamp-trial-inputs.ts capture <task-dir> --out <file>',
      '  npx tsx scripts/stamp-trial-inputs.ts apply <capture-file> <job-dir> [job-dir...]',
    ].join('\n')
  );
  process.exit(1);
}

/** Snapshot the task inputs as they stand at launch; write the record to `outFile`. */
export function captureCommand(taskDir: string, outFile: string): void {
  if (!existsSync(taskDir)) {
    console.error(`Error: task dir ${taskDir} does not exist`);
    process.exit(1);
  }
  // taskSlug scopes `apply` to this task's trial dirs (concurrent harbor-runs
  // share harbor-jobs/) and makes any mis-routed stamp diagnosable later.
  const record = { ...captureTaskInputs(taskDir, 'run'), taskSlug: basename(resolve(taskDir)) };
  writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
}

/**
 * Does this trial dir belong to the task the capture was taken from? Two
 * signals, strongest first:
 *
 *   1. result.json `task_name` — written per-trial by harbor with the FULL,
 *      unambiguous slug (org-prefixed for hub-published tasks). Authoritative
 *      when readable, exactly as copy-reference-run.ts resolves trials.
 *   2. The trial DIRNAME's `<prefix>__<trialId>` prefix — harbor TRUNCATES
 *      long slugs here, so the test is "the prefix is a truncation of the
 *      slug", not equality. (Two tasks sharing a truncated prefix are told
 *      apart by signal 1; the dirname alone can't distinguish them.)
 */
function trialBelongsToTask(trialDir: string, entry: string, slug: string): boolean {
  const sep = entry.lastIndexOf('__');
  if (sep === -1) return false;
  const resultPath = join(trialDir, 'result.json');
  if (existsSync(resultPath)) {
    try {
      const taskName = (JSON.parse(readFileSync(resultPath, 'utf-8')) as { task_name?: unknown })
        .task_name;
      if (typeof taskName === 'string' && taskName.length > 0) {
        return taskName.replace(/^[^/]+\//, '') === slug;
      }
    } catch {
      // Unparseable result.json — fall through to the dirname prefix.
    }
  }
  const prefix = entry.substring(0, sep);
  return prefix === slug || slug.startsWith(prefix);
}

/**
 * Copy a launch-time capture into the capture's OWN task's trial dirs under
 * the given harbor job dir(s). Trial dirs are the `<slug>__<trialId>`
 * subdirectories harbor creates; anything else (stray files, harbor's own
 * metadata) is skipped — and so is any trial belonging to a DIFFERENT task:
 * several harbor-run invocations can share a cwd, and stamping another
 * task's trials with this capture's hashes would fabricate `capturedBy:
 * 'run'` evidence for inputs that task never ran against. An existing record
 * is left alone — it can only be from an earlier stamp of the same trial.
 */
export function applyCommand(captureFile: string, jobDirs: string[]): number {
  const record = readTaskInputChecksums(captureFile);
  if (!record || typeof record.taskSlug !== 'string' || record.taskSlug.length === 0) {
    console.error(
      `Error: ${captureFile} is not a readable input-checksums capture with a taskSlug`
    );
    process.exit(1);
  }
  const slug = record.taskSlug;
  const raw = readFileSync(captureFile, 'utf-8');
  let stamped = 0;
  for (const jobDir of jobDirs) {
    if (!existsSync(jobDir)) continue;
    for (const entry of readdirSync(jobDir)) {
      const trialDir = join(jobDir, entry);
      if (!entry.includes('__') || !statSync(trialDir).isDirectory()) continue;
      if (!trialBelongsToTask(trialDir, entry, slug)) continue;
      const dest = join(trialDir, INPUT_CHECKSUMS_FILENAME);
      if (existsSync(dest)) continue;
      writeFileSync(dest, raw);
      stamped++;
      console.log(`Stamped ${dest}`);
    }
  }
  return stamped;
}

// Main. Guarded so the test file can import the commands without running them.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'capture') {
    const outIdx = rest.indexOf('--out');
    const taskDir = rest.filter((a, i) => i !== outIdx && i !== outIdx + 1)[0];
    const outFile = outIdx !== -1 ? rest[outIdx + 1] : undefined;
    if (!taskDir || !outFile) usage();
    captureCommand(taskDir, outFile);
  } else if (command === 'apply') {
    const [captureFile, ...jobDirs] = rest;
    if (!captureFile || jobDirs.length === 0) usage();
    const stamped = applyCommand(captureFile, jobDirs);
    console.log(`Stamped ${stamped} trial dir(s) with launch-time input checksums`);
  } else {
    usage();
  }
}
