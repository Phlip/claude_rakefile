/**
 * check-task-infra.ts — report edits to toolkit-managed files.
 *
 * Called by `scripts/harbor-run` before a trial and by `scripts/submit-task.ts`
 * before packaging, so an accidental edit to the trial Dockerfile, the grader
 * orchestration, or the grader system prompt surfaces at the moment it matters
 * rather than after a submission is reviewed.
 *
 * Covers two sets: the task's own managed files (environment/Dockerfile,
 * tests/test.sh, the grader system prompts) and the toolkit's `scripts/` tree,
 * which is checked once per invocation regardless of which task was named.
 *
 * Always exits 0. Both checks are advisory — see the notes on IntegrityStatus
 * and formatIntegrityReport.
 *
 * Usage:
 *   npx tsx scripts/check-task-infra.ts <task-slug-or-dir>
 *   npx tsx scripts/check-task-infra.ts my-task --json
 */

import { existsSync } from 'fs';
import { basename, isAbsolute, join, resolve } from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  bannerize,
  checkTaskInfraIntegrity,
  formatIntegrityReport,
  writeManagedStamp,
} from './lib/task-infra-integrity.js';
import {
  checkToolkitScriptIntegrity,
  scriptIntegrityNotice,
} from './lib/toolkit-script-integrity.js';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <task> [options]')
  .positional('task', { type: 'string', describe: 'Task slug, or a path to harbor-tasks/<slug>' })
  .option('json', {
    type: 'boolean',
    describe: 'Output structured JSON logs',
    default: false,
  })
  .option('stamp', {
    type: 'boolean',
    default: false,
    describe:
      'Record the managed files as created, so later edits are detectable. No-op if already stamped.',
  })
  .demandCommand(1, 'Provide a task slug or directory')
  .help()
  .parseSync();

const log = pino(
  { name: 'check-task-infra', level: 'info' },
  argv.json
    ? process.stdout
    : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' })
);

const arg = String(argv._[0]);
const toolkitRoot = process.cwd();
// Accept both a bare slug and a path, since harbor-run is invoked with a path
// (`scripts/harbor-run harbor-tasks/<slug>`) and submit-task with a slug.
const taskDir = isAbsolute(arg)
  ? arg
  : existsSync(resolve(toolkitRoot, arg))
    ? resolve(toolkitRoot, arg)
    : join(toolkitRoot, 'harbor-tasks', arg);

if (!existsSync(taskDir)) {
  log.fatal({ taskDir }, 'Task directory not found');
  process.exit(1);
}

const slug = basename(taskDir);
// --stamp records a task's baseline. Runs at task creation; never overwrites.
if (argv.stamp) {
  if (!existsSync(join(toolkitRoot, 'task-shared'))) {
    log.debug('Not a worker toolkit (no task-shared/); nothing to stamp');
    process.exit(0);
  }
  const wrote = writeManagedStamp(taskDir, toolkitRoot);
  log.debug({ slug, wrote }, wrote ? 'Stamped toolkit-managed files' : 'Already stamped');
  process.exit(0);
}

// Toolkit scripts, not this task's files: checked here because this is already the
// preflight both `harbor-run` and `submit-task.ts` reach. An edited script ships no
// trace of itself, only its output — see toolkit-script-integrity.ts.
const scripts = checkToolkitScriptIntegrity(toolkitRoot);
if (scripts.checked) {
  const notice = scriptIntegrityNotice(scripts);
  if (notice) {
    log.warn(
      {
        edited: scripts.modified.map((f) => f.path),
        missing: scripts.missing.map((f) => f.path),
      },
      'Toolkit scripts need a look'
    );
    process.stderr.write(`\n${notice}\n\n`);
  } else {
    log.info({ files: scripts.files.length }, 'Toolkit scripts are unmodified');
  }
}

const report = checkTaskInfraIntegrity(taskDir, toolkitRoot);

if (!report.checked) {
  log.debug(
    'Managed-file check skipped: no task-shared/ here, or the task was authored on a different toolkit generation (its tests/ assets are its own)'
  );
  process.exit(0);
}

const message = formatIntegrityReport(report);

if (!message) {
  log.info({ files: report.files.length }, 'Toolkit-managed files are unmodified');
  process.exit(0);
}

// Advisory, always. Exiting non-zero here is what used to let a false positive stop
// an author's trial with no way out; the report is the whole product.
log.warn(
  {
    edited: report.modified.map((f) => f.taskPath),
    outdated: report.outdated.map((f) => f.taskPath),
    unverifiable: report.unverifiable.map((f) => f.taskPath),
  },
  'Toolkit-managed files need a look'
);
process.stderr.write(`\n${bannerize(message, report)}\n\n`);
process.exit(0);
