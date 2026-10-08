/**
 * toolkit-script-integrity.ts — detect edits to the toolkit's own scripts.
 *
 * Sibling of task-infra-integrity.ts, which covers a task's managed files. This
 * covers `scripts/`. The scripts never ship with a task, so an edit can't reach
 * the delivered workspace — but their OUTPUT does: `build-workspace.sh` alone
 * stages `tests/test-commands.sh` (the deterministic checks behind the
 * correctness score), writes the Dockerfile's toolkit-managed blocks, and
 * records the managed stamp and input checksums. Nothing downstream re-derives
 * those, and the reference runs can't be re-derived at all.
 *
 * The baseline is a manifest written at package time ({@link writeScriptManifest}),
 * so it ships in the same zip as the scripts it describes. That removes the
 * ambiguity a task's managed files have: there is no "created on an older
 * release" case to tell apart, so a hash mismatch is an edit. Files absent from
 * the manifest are ignored, which keeps a worker's own helper script — or a
 * `__pycache__` left by a harbor run — from ever being reported.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

import { banner } from './notice-banner.js';

/** Manifest of the shipped `scripts/` tree. Lives at the toolkit root. */
export const SCRIPT_MANIFEST_FILENAME = '.toolkit-scripts.json';

const MANIFEST_VERSION = 1;

/** Runtime droppings, never part of the shipped tree. */
const IGNORED_DIRS = new Set(['__pycache__', 'node_modules', '.git']);
const IGNORED_FILES = /\.(pyc|pyo)$/;

/**
 * `modified` — content differs from what shipped: an edit.
 * `missing`  — shipped, but no longer on disk.
 * `ok`       — unchanged.
 */
export type ScriptStatus = 'ok' | 'modified' | 'missing';

export interface ScriptVerdict {
  /** Toolkit-relative path, e.g. `scripts/build-workspace.sh`. */
  path: string;
  status: ScriptStatus;
}

export interface ScriptIntegrityReport {
  /** False when no manifest ships — callers should skip silently. */
  checked: boolean;
  files: ScriptVerdict[];
  modified: ScriptVerdict[];
  missing: ScriptVerdict[];
}

interface ScriptManifest {
  version: number;
  generatedAt: string;
  /** Toolkit-relative path → sha256 of the normalized content. */
  files: Record<string, string>;
}

/**
 * Line endings and trailing whitespace are normalized away: a Windows editor, a
 * checkout with core.autocrlf, or a formatter trimming a final newline must not
 * read as an edit.
 */
function hashContent(content: string): string {
  return createHash('sha256')
    .update(content.replace(/\r\n/g, '\n').replace(/\s+$/, ''))
    .digest('hex');
}

/** Every shipped file under `scripts/`, as toolkit-relative paths. */
function walkScripts(dir: string, toolkitRoot: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...walkScripts(abs, toolkitRoot));
      continue;
    }
    if (!entry.isFile() || IGNORED_FILES.test(entry.name)) continue;
    out.push(relative(toolkitRoot, abs));
  }

  return out;
}

/**
 * Record the shipped `scripts/` tree. Call at package time, once the tree is
 * fully staged — anything written to `scripts/` afterwards reads as an edit.
 *
 * Returns the number of files recorded.
 */
export function writeScriptManifest(toolkitRoot: string): number {
  const files: Record<string, string> = {};

  for (const rel of walkScripts(join(toolkitRoot, 'scripts'), toolkitRoot)) {
    files[rel] = hashContent(readFileSync(join(toolkitRoot, rel), 'utf-8'));
  }

  const manifest: ScriptManifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(
    join(toolkitRoot, SCRIPT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return Object.keys(files).length;
}

function readManifest(toolkitRoot: string): ScriptManifest | null {
  const p = join(toolkitRoot, SCRIPT_MANIFEST_FILENAME);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as ScriptManifest;
    if (parsed?.version !== MANIFEST_VERSION) return null;
    return parsed?.files && typeof parsed.files === 'object' ? parsed : null;
  } catch {
    // A corrupt manifest is treated as no manifest rather than blocking a trial.
    return null;
  }
}

/**
 * Compare the toolkit's `scripts/` tree against the manifest it shipped with.
 *
 * @param toolkitRoot Absolute path to the toolkit root (holds `scripts/`).
 */
export function checkToolkitScriptIntegrity(toolkitRoot: string): ScriptIntegrityReport {
  const manifest = readManifest(toolkitRoot);
  if (!manifest) return { checked: false, files: [], modified: [], missing: [] };

  const files: ScriptVerdict[] = Object.entries(manifest.files).map(([path, expected]) => {
    const abs = join(toolkitRoot, path);
    if (!existsSync(abs)) return { path, status: 'missing' as const };
    const status = hashContent(readFileSync(abs, 'utf-8')) === expected ? 'ok' : 'modified';
    return { path, status };
  });

  return {
    checked: true,
    files,
    modified: files.filter((f) => f.status === 'modified'),
    missing: files.filter((f) => f.status === 'missing'),
  };
}

/**
 * Human-readable report. Returns '' when there is nothing worth saying, so callers
 * can `if (msg) print(msg)`.
 *
 * Deliberately not phrased as a refusal, for the same reason the managed-file
 * notice isn't: an author who changed one of these did it to get unstuck, and the
 * fix they needed almost certainly belongs in the toolkit rather than in their copy.
 */
export function formatScriptIntegrityReport(report: ScriptIntegrityReport): string {
  const sections: string[] = [];

  if (report.modified.length > 0) {
    sections.push(
      [
        'These toolkit scripts look edited:',
        '',
        ...report.modified.map((f) => `  ${f.path}`),
        '',
        "They aren't part of any task, so an edit is easy to miss — but what they write",
        'is. Building a task stages its deterministic checks, fills in parts of its',
        'Dockerfile, and records the checksums a reviewer reads; a script that does any of',
        'that differently produces a task that looks normal and behaves differently from',
        'every other one.',
        '',
        'Re-extracting the toolkit zip over your copy restores them. Your tasks, snapshots',
        'and reference runs are untouched by that.',
        '',
        'If you changed one to work around a problem — a build that would not run, a',
        'missing dependency — please tell us about the problem instead. It almost',
        'certainly affects other authors too, and the fix belongs in the toolkit.',
        'Nothing here stops you running trials or submitting.',
      ].join('\n')
    );
  }

  if (report.missing.length > 0) {
    sections.push(
      [
        'These toolkit scripts shipped with this release but are no longer here:',
        '',
        ...report.missing.map((f) => `  ${f.path}`),
        '',
        'Something that depends on one will fail partway through rather than up front.',
        'Re-extract the toolkit zip over your copy to put them back.',
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

/** The full notice, bannered and ready to write to stderr, or '' if all is well. */
export function scriptIntegrityNotice(report: ScriptIntegrityReport): string {
  const message = formatScriptIntegrityReport(report);
  if (!message) return '';

  const headline =
    report.modified.length > 0
      ? '!!  TOOLKIT SCRIPTS LOOK EDITED  —  PLEASE READ  !!'
      : '!!  TOOLKIT SCRIPTS ARE MISSING  —  PLEASE READ  !!';
  return banner(message, headline);
}
