/**
 * task-infra-integrity.ts — detect edits to toolkit-managed task files.
 *
 * `environment/Dockerfile`, `tests/test.sh`, and
 * `tests/grader-system-prompt-consolidated.md` come from `task-shared/` and
 * are the same in every task: they decide how the
 * trial runs and how the grade is produced. An edit makes a task's reference
 * runs incomparable to every other task's, and the scores still look normal,
 * so nothing downstream notices.
 *
 * A task is compared against itself as created. {@link writeManagedStamp} records
 * a sha256 of each managed file into `<task>/.toolkit-managed.json` at task
 * creation, so a later mismatch is an edit made since. Tasks created before
 * stamping have no record and fall back to matching the copies this toolkit
 * ships — see {@link IntegrityStatus}.
 *
 * The toolkit appends to a task's Dockerfile itself (session staging, the
 * reference-data corpus). Those blocks are wrapped in
 * `# >>> toolkit-managed: <name> >>>` sentinels and stripped before hashing or
 * comparing, so they never read as edits.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import { banner } from './notice-banner.js';

/**
 * Every status is advisory. Nothing here stops a trial or a submission: an author
 * who changed one of these files did it because they didn't know we'd rather they
 * didn't, and refusing to package their work punishes a misunderstanding. The job
 * is to say so clearly, and to record it so a reviewer sees it too.
 *
 * `ok`           — identical to a copy this toolkit ships, or unchanged since the
 *                  task was created.
 * `outdated`     — unchanged since creation, but the toolkit has shipped a newer
 *                  copy since. Nobody's mistake; it does mean this task's runs
 *                  aren't directly comparable to one built today.
 * `modified`     — matches neither its baseline nor anything shipped: an edit.
 * `unverifiable` — no recorded baseline and matches nothing shipped, so an edit
 *                  and an older release are indistinguishable.
 * `missing`      — the task doesn't have the file.
 * `placeholder`  — still the polyglot scaffold placeholder, so no base image has
 *                  been selected yet.
 */
export type IntegrityStatus =
  | 'ok'
  | 'outdated'
  | 'modified'
  | 'unverifiable'
  | 'missing'
  | 'placeholder';

export interface FileVerdict {
  /** Task-relative path, e.g. `environment/Dockerfile`. */
  taskPath: string;
  status: IntegrityStatus;
  /** Command that restores the managed version, on `modified` / `unverifiable`. */
  restore?: string;
}

export interface IntegrityReport {
  /**
   * False when this isn't a worker toolkit, or when the task was authored on
   * a different toolkit generation (see {@link isTaskFromThisToolkitGeneration})
   * — callers should skip silently.
   */
  checked: boolean;
  files: FileVerdict[];
  /** Looks like an edit: matches neither a baseline nor anything shipped. */
  modified: FileVerdict[];
  /** Can't be told apart from an older release. */
  unverifiable: FileVerdict[];
  /** Unchanged, but a newer copy has shipped since. */
  outdated: FileVerdict[];
}

interface ManagedFile {
  taskPath: string;
  /** Matches the candidate pristine filenames under `task-shared/`. */
  baselinePattern: RegExp;
}

/** The Dockerfile pattern accepts `Dockerfile` and every `Dockerfile.<member>`. */
const MANAGED_FILES: ManagedFile[] = [
  { taskPath: 'environment/Dockerfile', baselinePattern: /^Dockerfile(\.[\w.-]+)?$/ },
  { taskPath: 'tests/test.sh', baselinePattern: /^test\.sh$/ },
  {
    taskPath: 'tests/grader-system-prompt-consolidated.md',
    baselinePattern: /^grader-system-prompt-consolidated\.md$/,
  },
];

const SENTINEL_OPEN = /^#\s*>>>\s*toolkit-managed:.*>>>\s*$/;
const SENTINEL_CLOSE = /^#\s*<<<\s*toolkit-managed\s*<<<\s*$/;

/**
 * Line shapes from toolkit releases that predate the sentinels. Deliberately
 * narrow: each is a literal line the toolkit wrote, not a general "ignore COPY
 * lines" rule an edit could hide behind.
 */
const LEGACY_MANAGED_LINES: RegExp[] = [
  /^# Stage session files for the snapshot agent adapter to install at runtime\.$/,
  /^COPY session\.jsonl \/tmp\/snapshot-session\/session\.jsonl$/,
  /^COPY session\/ \/tmp\/snapshot-session\/session\/$/,
  /^RUN echo '[0-9a-fA-F-]+' > \/tmp\/snapshot-session\/uuid\.txt$/,
  /^# Reference-data corpus at \/data\/zeta-corpus \(staged by build-workspace\)\.$/,
  /^COPY corpus\/ \/data\/zeta-corpus\/$/,
];

/** Marker identifying the polyglot scaffold's deliberately-failing placeholder. */
const PLACEHOLDER_MARKER = 'POLYGLOT TOOLKIT';

/** Per-task stamp of the managed files as created. Lives in the task directory. */
export const STAMP_FILENAME = '.toolkit-managed.json';

interface ManagedStamp {
  version: number;
  stampedAt: string;
  /** taskPath → sha256 of the stripped content. */
  files: Record<string, string>;
}

/**
 * Remove toolkit-appended content so only author-authored differences remain.
 * Trailing blank lines go too — an editor adding or trimming a final newline is
 * not something to fail a trial over.
 */
export function stripManagedBlocks(content: string): string {
  const out: string[] = [];
  let inBlock = false;

  // Normalize CRLF before anything else: a Windows editor or a checkout with
  // core.autocrlf rewrites every line ending, and that must not read as an edit.
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    if (!inBlock && SENTINEL_OPEN.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (SENTINEL_CLOSE.test(line)) inBlock = false;
      continue;
    }
    if (LEGACY_MANAGED_LINES.some((re) => re.test(line))) continue;
    out.push(line);
  }

  return out.join('\n').replace(/\s+$/, '');
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Pristine `task-shared/` filenames matching a managed file's baseline pattern. */
function baselineCandidates(sharedDir: string, pattern: RegExp): string[] {
  if (!existsSync(sharedDir)) return [];
  return readdirSync(sharedDir)
    .filter((f) => pattern.test(f))
    .sort();
}

/**
 * Record the managed files, so later edits are detectable. Call at task creation
 * and after a managed file is first put in place.
 *
 * A file earns a baseline only by matching a copy this toolkit ships, and an
 * entry already recorded is never rewritten. Together those mean a stamp can
 * only ever describe a pristine file: re-running this can't turn an author's
 * edit into the new baseline, and a file dropped in later (the polyglot
 * Dockerfile, which is the scaffold's placeholder at first stamp) still gets a
 * baseline once it's in place.
 *
 * Returns true if anything was recorded.
 */
export function writeManagedStamp(taskDir: string, toolkitRoot: string): boolean {
  const sharedDir = join(toolkitRoot, 'task-shared');
  const existing = readStamp(taskDir);
  const files: Record<string, string> = { ...(existing?.files ?? {}) };
  let added = false;

  for (const managed of MANAGED_FILES) {
    if (files[managed.taskPath]) continue;
    const p = join(taskDir, managed.taskPath);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, 'utf-8');
    // Not a baseline: the author still has to drop in their member's base image.
    if (raw.includes(PLACEHOLDER_MARKER)) continue;
    const stripped = stripManagedBlocks(raw);
    if (!matchesShipped(sharedDir, managed, stripped)) continue;
    files[managed.taskPath] = sha256(stripped);
    added = true;
  }

  if (!added) return false;

  const stamp: ManagedStamp = {
    version: 1,
    stampedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(join(taskDir, STAMP_FILENAME), `${JSON.stringify(stamp, null, 2)}\n`);
  return true;
}

function readStamp(taskDir: string): ManagedStamp | null {
  const stampPath = join(taskDir, STAMP_FILENAME);
  if (!existsSync(stampPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stampPath, 'utf-8')) as ManagedStamp;
    return parsed?.files && typeof parsed.files === 'object' ? parsed : null;
  } catch {
    // Treat a corrupt stamp as no stamp rather than blocking a trial over it.
    return null;
  }
}

/**
 * How to restore a managed file, or undefined when this toolkit ships no copy to
 * restore from. Only the Dockerfile can have several candidates (one per member).
 */
function restoreCommand(taskPath: string, candidates: string[], slug: string): string | undefined {
  const dest = `harbor-tasks/${slug}/${taskPath}`;
  if (candidates.length === 1) return `cp task-shared/${candidates[0]} ${dest}`;
  if (candidates.length > 1) {
    return `cp task-shared/Dockerfile.<your-member> ${dest}   (list them: ls task-shared/Dockerfile.*)`;
  }
  // Never guess. Emitting the multi-candidate Dockerfile line here would tell an
  // author to copy a Dockerfile over their grader prompt.
  return undefined;
}

/** Render a restore line, saying so plainly when there is nothing to restore from. */
function restoreLine(f: FileVerdict): string {
  return f.restore
    ? `  ${f.restore}`
    : `  (no copy of ${f.taskPath} ships in task-shared/ — re-extract the toolkit zip)`;
}

/** Does this content match a pristine copy the toolkit ships? */
function matchesShipped(sharedDir: string, managed: ManagedFile, stripped: string): boolean {
  return baselineCandidates(sharedDir, managed.baselinePattern).some(
    (c) => stripManagedBlocks(readFileSync(join(sharedDir, c), 'utf-8')) === stripped
  );
}

/**
 * Was this task created by this toolkit generation? Task creation (the packed
 * scaffold's task.toml and snapshot-to-task) writes `[metadata].toolkit_version`;
 * a task directory without the key was authored on a different toolkit
 * generation and grades with the assets frozen in its own tests/ directory, so
 * comparing those against this toolkit's copies would report drift that is not
 * an edit. Presence-based on purpose: wall-clock stamps cannot separate the
 * generations, because tasks from an earlier generation are completed after
 * later kits ship.
 *
 * A regex rather than a TOML parser, for the same shipped-dependency reason as
 * input-checksums.ts readGitref: the one `toolkit_version` key in a task.toml
 * is `[metadata].toolkit_version`.
 */
export function isTaskFromThisToolkitGeneration(taskDir: string): boolean {
  const tomlPath = join(taskDir, 'task.toml');
  if (!existsSync(tomlPath)) return false;
  try {
    return /^\s*toolkit_version\s*=/m.test(readFileSync(tomlPath, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Compare a task's managed files against its creation-time stamp.
 *
 * @param taskDir     Absolute path to `harbor-tasks/<slug>`.
 * @param toolkitRoot Absolute path to the toolkit root (holds `task-shared/`).
 */
export function checkTaskInfraIntegrity(taskDir: string, toolkitRoot: string): IntegrityReport {
  const sharedDir = join(toolkitRoot, 'task-shared');

  // Without task-shared/ there is nothing to compare against; report "not
  // checked" so callers no-op rather than reporting three phantom failures.
  if (!existsSync(sharedDir)) {
    return { checked: false, files: [], modified: [], unverifiable: [], outdated: [] };
  }

  // A task authored on a different toolkit generation grades with the assets
  // frozen in its own tests/ directory. Comparing those against this toolkit's
  // copies would report drift that is not an edit — and the printed remedy
  // (restore the current copy) would change how that task grades. Skip it.
  if (!isTaskFromThisToolkitGeneration(taskDir)) {
    return { checked: false, files: [], modified: [], unverifiable: [], outdated: [] };
  }

  const slug = basename(taskDir);
  const stamp = readStamp(taskDir);
  const files: FileVerdict[] = [];

  for (const managed of MANAGED_FILES) {
    const taskFile = join(taskDir, managed.taskPath);
    if (!existsSync(taskFile)) {
      files.push({ taskPath: managed.taskPath, status: 'missing' });
      continue;
    }

    const raw = readFileSync(taskFile, 'utf-8');
    const candidates = baselineCandidates(sharedDir, managed.baselinePattern);
    const restore = restoreCommand(managed.taskPath, candidates, slug);
    const stripped = stripManagedBlocks(raw);

    // FIRST: is this byte-for-byte something the toolkit ships right now? If so it
    // cannot be an author edit, whatever the stamp says — and asking the stamp first
    // is what used to make restoring the current copy (which is exactly what we tell
    // authors to do) look like an edit, with no way out.
    if (matchesShipped(sharedDir, managed, stripped)) {
      files.push({ taskPath: managed.taskPath, status: 'ok' });
      continue;
    }

    const expected = stamp?.files[managed.taskPath];
    if (expected) {
      // Matches its baseline but nothing shipped: untouched by the author, and the
      // toolkit has moved on since. Worth saying, nobody's fault.
      const status = sha256(stripped) === expected ? 'outdated' : 'modified';
      files.push({ taskPath: managed.taskPath, status, restore });
      continue;
    }

    // Checked after the stamp so that adding this marker to a file that HAS a
    // baseline can't exempt it from the comparison.
    if (raw.includes(PLACEHOLDER_MARKER)) {
      files.push({ taskPath: managed.taskPath, status: 'placeholder' });
      continue;
    }

    files.push({ taskPath: managed.taskPath, status: 'unverifiable', restore });
  }

  return {
    checked: true,
    files,
    modified: files.filter((f) => f.status === 'modified'),
    unverifiable: files.filter((f) => f.status === 'unverifiable'),
    outdated: files.filter((f) => f.status === 'outdated'),
  };
}

/**
 * Human-readable report. Returns '' when there is nothing worth saying, so callers
 * can `if (msg) print(msg)`.
 *
 * Deliberately not phrased as a refusal. An author who changed one of these files
 * almost always did it to get unstuck, not knowing we'd rather they told us — so
 * this explains what it means for their task and what restoring would do, and then
 * lets them get on with it.
 */
export function formatIntegrityReport(report: IntegrityReport): string {
  const sections: string[] = [];

  if (report.modified.length > 0) {
    sections.push(
      [
        'These files look edited since this task was created, and the toolkit manages',
        'them — they set up how the trial runs and how the grade is produced, so they',
        "have to be identical across every task. Yours aren't, which makes this task's",
        "runs hard to compare with everyone else's:",
        '',
        ...report.modified.map((f) => `  ${f.taskPath}`),
        '',
        'Restoring the shipped version puts that right:',
        ...report.modified.map(restoreLine),
        '',
        'If you changed one to work around a problem — a missing package, a grader that',
        "wouldn't run — please tell us about the problem instead. It almost certainly",
        'affects other authors too, and the fix belongs in the toolkit, not in one task.',
        'Nothing here stops you running trials or submitting.',
      ].join('\n')
    );
  }

  if (report.outdated.length > 0) {
    sections.push(
      [
        'These files are unchanged, but the toolkit has shipped newer copies since this',
        'task was created:',
        '',
        ...report.outdated.map((f) => `  ${f.taskPath}`),
        '',
        "You haven't done anything wrong. It does mean this task was run and graded with",
        "older versions than a task built today, so its scores aren't directly",
        'comparable. To line them up, restore the current copies and re-run your trials:',
        ...report.outdated.map(restoreLine),
      ].join('\n')
    );
  }

  if (report.unverifiable.length > 0) {
    sections.push(
      [
        "These files don't match the copies this toolkit ships, and this task has no",
        'record of what they looked like when it was created:',
        '',
        ...report.unverifiable.map((f) => `  ${f.taskPath}`),
        '',
        'Two things look like this and we cannot tell them apart: a task created on an',
        'earlier toolkit release (nothing to fix, though its scores are not directly',
        'comparable to a task built today), or a file that was edited. Either way,',
        'restoring the current copy and re-running your trials is what makes this task',
        "comparable to everyone else's:",
        ...report.unverifiable.map(restoreLine),
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

/**
 * Wrap a report in a banner loud enough to survive a scrollback.
 *
 * Nothing blocks any more, so this notice is the entire mechanism — and an
 * unframed paragraph among build output is one a reasonable person scrolls past.
 */
export function bannerize(message: string, report: IntegrityReport): string {
  return banner(
    message,
    report.modified.length > 0
      ? '!!  TOOLKIT-MANAGED FILES LOOK EDITED  —  PLEASE READ  !!'
      : '!!  TOOLKIT-MANAGED FILES NEED A LOOK  —  PLEASE READ  !!'
  );
}
