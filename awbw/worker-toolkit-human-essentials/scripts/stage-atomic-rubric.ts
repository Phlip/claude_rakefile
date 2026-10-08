/**
 * stage-atomic-rubric.ts — stage a task's atomic rubric into the grading
 * copies the rubric grader modes read, so
 * `HARBOR_GRADER_MODE=rubric-trinary scripts/harbor-regrade …` can run inside
 * this toolkit.
 *
 * Source of truth: the task's own atomic rubric —
 * `tests/atomic-rubric.yaml` (the current name), or `tests/rubrics.yaml` on a
 * task converted before the rename. A task carrying BOTH names with different
 * content is a hard error: silently preferring either file could stage a
 * rubric that is not the one just edited, and the grader would grade the
 * wrong criteria with no signal.
 *
 * Staged into `harbor-tasks/<slug>/tests/`:
 *   - `rubric-criteria.md`   — the criteria text shown to the grader: one
 *     "### Criterion: <id>" section per criterion, guideline and elaboration
 *     only. Category, severity, and dimensions are stripped, so the grader
 *     stays severity-blind.
 *   - `rubric-criteria.json` — {task, criteria: [{id, category, severity,
 *     dimensions}]} for `render-rubric-grade.py` (criterion-id validation and
 *     severity-weighted aggregation). The grader never sees this file.
 *   - `render-rubric-grade.py` — synced from `task-shared/` when the task's
 *     copy is missing or differs from the shared source.
 *
 * `tests/grader-context.md` is part of the task's own package — this script
 * checks that it exists and never writes it. Write it alongside the rubric;
 * the `/write-atomic-rubric` skill covers both files.
 *
 * Staged files are derived from the rubric. Re-run this script after every
 * rubric edit, and run `--restore` to remove the staged copies. This script
 * validates structure only (readable YAML, unique criterion ids, at most two
 * Crux criteria); the `/detector-rubric-coverage` and `/detector-rubric-form`
 * skills are the content review.
 *
 * Usage:
 *   npx tsx scripts/stage-atomic-rubric.ts <task-slug>
 *   npx tsx scripts/stage-atomic-rubric.ts <task-slug> --restore
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLKIT_ROOT = resolve(__dirname, '..');
const SHARED_DIR = join(TOOLKIT_ROOT, 'task-shared');

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <task> [options]')
  .positional('task', { type: 'string', describe: 'Task slug, or a path to harbor-tasks/<slug>' })
  .option('restore', {
    type: 'boolean',
    default: false,
    describe: 'Remove the files a previous staging created',
  })
  .option('json', { type: 'boolean', default: false, describe: 'Structured JSON logs' })
  .demandCommand(1, 'Name the task to stage: npx tsx scripts/stage-atomic-rubric.ts <task-slug>')
  .strict()
  .help()
  .parseSync();

const log = pino(
  { name: 'stage-atomic-rubric', level: 'info' },
  argv.json
    ? process.stdout
    : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' })
);

/** The atomic-rubric filenames, current name first. */
const RUBRIC_NAMES = ['atomic-rubric.yaml', 'rubrics.yaml'] as const;

/** Record of exactly what staging created, so --restore removes only that. */
const STAGE_MANIFEST = '.rubric-staged.json';

/** The rubric shape this script needs. Validation is structural only — the
 *  rubric detectors and the repo-side validator own the content rules. */
interface RubricCriterion {
  readonly id: string;
  readonly category: string;
  readonly severity?: string | null;
  readonly guideline: string;
  readonly elaboration?: string | null;
  readonly dimensions?: readonly string[];
}

interface RubricsDoc {
  readonly task: string;
  readonly criteria: readonly RubricCriterion[];
}

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

/** harbor-tasks/<slug> from a slug or a path, mirroring check-task-infra.ts. */
function resolveTaskDir(task: string): string {
  const candidate = isAbsolute(task) ? task : resolve(process.cwd(), task);
  if (existsSync(join(candidate, 'task.toml'))) return candidate;
  const bySlug = join(TOOLKIT_ROOT, 'harbor-tasks', task);
  if (existsSync(join(bySlug, 'task.toml'))) return bySlug;
  return fail(`No task found at ${task} or harbor-tasks/${task} (expected a task.toml inside).`);
}

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The task's rubric file — current name first, pre-rename name honored, both
 *  present with different content refused. */
function resolveRubricPath(testsDir: string): string {
  const present = RUBRIC_NAMES.map((name) => join(testsDir, name)).filter((p) => existsSync(p));
  if (present.length === 0) {
    return fail(
      `No atomic rubric found: expected tests/atomic-rubric.yaml ` +
        `(or tests/rubrics.yaml on a task converted before the rename). ` +
        `Write it with the /write-atomic-rubric skill first.`
    );
  }
  if (present.length > 1 && new Set(present.map(sha256)).size > 1) {
    return fail(
      `Both tests/atomic-rubric.yaml and tests/rubrics.yaml exist with different content. ` +
        `Keep exactly one; tests/atomic-rubric.yaml is the current name.`
    );
  }
  return present[0];
}

/** Structural gate: the properties the staged outputs are built from. */
function toRubricsDoc(raw: unknown, sourceName: string): RubricsDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail(`${sourceName} is not a YAML mapping with task and criteria keys.`);
  }
  const doc = raw as { task?: unknown; criteria?: unknown };
  if (typeof doc.task !== 'string' || doc.task.length === 0) {
    return fail(`${sourceName} is missing the top-level task key.`);
  }
  if (!Array.isArray(doc.criteria) || doc.criteria.length === 0) {
    return fail(`${sourceName} has no criteria list.`);
  }
  const seen = new Set<string>();
  let cruxCount = 0;
  for (const [index, entry] of doc.criteria.entries()) {
    const criterion = entry as Partial<RubricCriterion> | null;
    if (typeof criterion !== 'object' || criterion === null) {
      return fail(`${sourceName} criteria[${index}] is not a mapping.`);
    }
    if (typeof criterion.id !== 'string' || criterion.id.length === 0) {
      return fail(`${sourceName} criteria[${index}] has no id.`);
    }
    if (seen.has(criterion.id)) {
      return fail(`${sourceName} has a duplicate criterion id: ${criterion.id}.`);
    }
    seen.add(criterion.id);
    if (typeof criterion.guideline !== 'string' || criterion.guideline.trim().length === 0) {
      return fail(`${sourceName} criterion ${criterion.id} has no guideline.`);
    }
    if (typeof criterion.category !== 'string' || criterion.category.length === 0) {
      return fail(`${sourceName} criterion ${criterion.id} has no category.`);
    }
    if (criterion.severity === 'crux') cruxCount += 1;
  }
  if (cruxCount > 2) {
    return fail(`${sourceName} designates ${cruxCount} Crux criteria; the cap is two.`);
  }
  return doc as RubricsDoc;
}

/** Grader-facing view: guideline and elaboration only, severity-blind. */
function renderCriteriaMarkdown(doc: RubricsDoc): string {
  const sections = doc.criteria.map((criterion) => {
    const parts = [`### Criterion: ${criterion.id}`, criterion.guideline.trim()];
    if (criterion.elaboration?.trim()) parts.push(criterion.elaboration.trim());
    return parts.join('\n\n');
  });
  return sections.join('\n\n') + '\n';
}

function stage(taskDir: string): void {
  const testsDir = join(taskDir, 'tests');
  if (!existsSync(testsDir)) {
    return fail(`${relative(TOOLKIT_ROOT, taskDir)} has no tests/ directory.`);
  }
  const rubricPath = resolveRubricPath(testsDir);
  const sourceName = `tests/${basename(rubricPath)}`;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(rubricPath, 'utf8'));
  } catch (error) {
    return fail(`${sourceName} is not readable YAML: ${(error as Error).message}`);
  }
  const doc = toRubricsDoc(parsed, sourceName);

  const created: string[] = [];
  const writeStaged = (name: string, content: string, mode?: number): void => {
    writeFileSync(join(testsDir, name), content, mode ? { mode } : undefined);
    created.push(name);
  };

  writeStaged('rubric-criteria.md', renderCriteriaMarkdown(doc));
  writeStaged(
    'rubric-criteria.json',
    JSON.stringify(
      {
        task: doc.task,
        // severity feeds render-rubric-grade.py's severity-weighted
        // aggregation; dimensions ride along for offline slicing. The grader
        // never sees this file — severity-blindness lives in
        // rubric-criteria.md.
        criteria: doc.criteria.map((criterion) => ({
          id: criterion.id,
          category: criterion.category,
          severity: criterion.severity ?? null,
          dimensions: criterion.dimensions ?? [],
        })),
      },
      null,
      2
    ) + '\n'
  );

  // The renderer is a shared asset. Sync it so the regrade runs the current
  // weights; scripts/harbor-regrade performs the same self-heal.
  const rendererSource = join(SHARED_DIR, 'render-rubric-grade.py');
  const rendererDest = join(testsDir, 'render-rubric-grade.py');
  if (!existsSync(rendererSource)) {
    return fail('task-shared/render-rubric-grade.py is missing from this toolkit.');
  }
  if (!existsSync(rendererDest) || sha256(rendererDest) !== sha256(rendererSource)) {
    copyFileSync(rendererSource, rendererDest);
    created.push('render-rubric-grade.py');
  }

  writeFileSync(join(testsDir, STAGE_MANIFEST), JSON.stringify({ created }, null, 2) + '\n');

  if (!existsSync(join(testsDir, 'grader-context.md'))) {
    log.warn(
      'tests/grader-context.md is missing. The rubric grader modes read it beside the ' +
        'criteria; write it before running a rubric-mode regrade or packaging the task.'
    );
  }
  log.info(
    { source: sourceName, criteria: doc.criteria.length, staged: created },
    'Staged the atomic-rubric grading copies.'
  );
}

function restore(taskDir: string): void {
  const testsDir = join(taskDir, 'tests');
  const manifestPath = join(testsDir, STAGE_MANIFEST);
  if (!existsSync(manifestPath)) {
    log.warn('No staging manifest found; nothing to restore.');
    return;
  }
  let names: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { created?: unknown };
    if (Array.isArray(manifest.created)) {
      names = manifest.created.filter((n): n is string => typeof n === 'string');
    }
  } catch {
    return fail(`${STAGE_MANIFEST} is unreadable; remove the staged files by hand.`);
  }
  for (const name of names) {
    // Only ever files this script wrote into tests/ — refuse anything else.
    if (name.includes('/') || name.includes('..')) continue;
    const filePath = join(testsDir, name);
    if (existsSync(filePath)) rmSync(filePath);
  }
  rmSync(manifestPath);
  log.info({ removed: names }, 'Removed the staged grading copies.');
}

// The yaml package reaches containers created after it joined package.json;
// a container created earlier has every other dependency but not this one,
// so resolve it at run time and say what to do instead of crashing.
let parseYaml: (src: string) => unknown;
try {
  const requireFromHere = createRequire(fileURLToPath(import.meta.url));
  ({ parse: parseYaml } = requireFromHere('yaml') as { parse: (src: string) => unknown });
} catch {
  fail(
    'The yaml package is not installed in this container. Rebuild the Authoring ' +
      'container ("Dev Containers: Rebuild Container"), or run npm install in the toolkit root.'
  );
}

const taskDir = resolveTaskDir(String(argv._[0]));
if (argv.restore) restore(taskDir);
else stage(taskDir);
