/**
 * record-detector-inputs.ts — stamp detector report(s) with the checksums of
 * the task inputs they assessed.
 *
 * Run this right after a detector skill writes (or rewrites)
 * harbor-tasks/<slug>/detectors/<detector-name>.md. It records a sha256
 * capture of the task inputs next to the report, as
 * detectors/<detector-name>.inputs.json, so submit-task.ts can tell by
 * content — not by file timestamp — whether the report still matches the
 * task being packaged.
 *
 * Usage:
 *   npx tsx scripts/record-detector-inputs.ts <task-slug> <detector-name> [detector-name...]
 *   npx tsx scripts/record-detector-inputs.ts my-cool-task detector-rubric-clarity
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { captureTaskInputs } from './lib/input-checksums';

const argv = yargs(hideBin(process.argv))
  .usage(
    '$0 <slug> <detectors...>',
    'Record the task-input checksums a detector report assessed',
    (y) =>
      y
        .positional('slug', { type: 'string', demandOption: true, describe: 'Task slug' })
        .positional('detectors', {
          type: 'string',
          array: true,
          demandOption: true,
          describe: 'Detector name(s), e.g. detector-rubric-clarity',
        })
  )
  .option('json', {
    type: 'boolean',
    describe: 'Output structured JSON logs',
    default: false,
  })
  .help()
  .parseSync();

const log = pino(
  { name: 'record-detector-inputs', level: 'info' },
  argv.json
    ? process.stdout
    : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' })
);

const slug = argv.slug as string;
const detectors = argv.detectors as string[];

const taskDir = join(process.cwd(), 'harbor-tasks', slug);
if (!existsSync(taskDir)) {
  log.fatal({ taskDir }, 'Task directory not found');
  process.exit(1);
}

// One capture serves every report stamped in this invocation — they all
// assessed the same on-disk revision of the task.
const capture = captureTaskInputs(taskDir, 'stamp');
const detectorsDir = join(taskDir, 'detectors');
mkdirSync(detectorsDir, { recursive: true });

for (const name of detectors) {
  const report = join(detectorsDir, `${name}.md`);
  if (!existsSync(report)) {
    // Stamp anyway — skills sometimes stamp before the final write lands —
    // but say so, since a stamp with no report usually means a typo'd name.
    log.warn({ report: `detectors/${name}.md` }, 'No report found for this detector name');
  }
  const stampPath = join(detectorsDir, `${name}.inputs.json`);
  writeFileSync(stampPath, JSON.stringify(capture, null, 2) + '\n');
  log.info({ stamp: `detectors/${name}.inputs.json` }, 'Recorded task-input checksums');
}
