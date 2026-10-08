/**
 * Strip machine-identifying filesystem paths, and optional keywords, from a session
 * transcript. Pure: raw JSONL in, JSONL out, no I/O.
 */

export const DEFAULT_PLACEHOLDER = '~/repo';
export const HOME_DIR_PLACEHOLDER = '~';
export const REDACTION_PLACEHOLDER = '[redacted]';

export interface SanitizeOptions {
  /** Replacement for the cwd-prefix. Its dash-encoded form is derived from it. */
  placeholder?: string;
  /** Keyword regexes to redact. Empty by default, leaving a pure path-scrubber. */
  forbiddenMarkers?: readonly RegExp[];
  /**
   * Exact prefix to strip. An inferred one is only the repo root when some cwd sat
   * there, so callers that know the root pass it here.
   */
  cwdPrefix?: string;
  /** Several roots at once (a session spanning two checkouts). Wins over `cwdPrefix`. */
  cwdPrefixes?: readonly string[];
  /**
   * Also strip home-rooted paths in the CONTENT: a sandbox-recorded session has a
   * sandbox `cwd`, so the cwd passes never see the local checkout it still mentions.
   */
  scrubEmbeddedHomePaths?: boolean;
}

export interface SanitizeResult {
  sanitized: string;
  prefixStripped: string | null;
  encodedPrefixStripped: string | null;
  homeDirStripped: string | null;
  encodedHomeDirStripped: string | null;
  embeddedPrefixStripped: string | null;
  embeddedHomeDirStripped: string | null;
  /** Replacement count per marker, keyed by the regex's source string. */
  markersScrubbed: Record<string, number>;
}

/** Longest common prefix by path COMPONENT: `/a/bb` and `/a/b` share `/a`, not `/a/b`.
 *  Returns `''` when only the root `/` is common. */
export function findLongestCommonPathPrefix(paths: Iterable<string>): string {
  const arr = Array.from(paths);
  if (arr.length === 0) return '';
  const splits = arr.map((p) => p.split('/'));
  const minLen = Math.min(...splits.map((s) => s.length));
  let lastShared = 0;
  for (let i = 0; i < minLen; i++) {
    const c = splits[0][i];
    if (splits.some((s) => s[i] !== c)) break;
    lastShared = i + 1;
  }
  // Only the leading empty piece matched → just the root, not useful.
  if (lastShared <= 1) return '';
  return splits[0].slice(0, lastShared).join('/');
}

/** The home-dir portion of an absolute path, or `null` for an unrecognized shape —
 *  better to skip the home pass than strip what may be repo content. */
export function extractHomeDir(cwdPrefix: string): string | null {
  if (!cwdPrefix.startsWith('/')) return null;
  // Windows-under-WSL shapes first: the generic drive shape below would stop at the
  // drive letter and leave the account name in. A volume or drive root carries no
  // identity by itself, so those take the directory under it.
  const patterns: RegExp[] = [
    /^\/mnt\/host\/[^/]+\/Users\/[^/]+/,
    /^\/mnt\/[^/]+\/Users\/[^/]+/,
    /^\/Users\/[^/]+/,
    /^\/home\/[^/]+/,
    /^\/Volumes\/[^/]+\/[^/]+/,
    /^\/mnt\/[^/]+\/[^/]+/,
    /^\/var\/root(?=\/|$)/,
    /^\/root(?=\/|$)/,
  ];
  for (const re of patterns) {
    const m = cwdPrefix.match(re);
    if (m) return m[0];
  }
  return null;
}

/** Every distinct `cwd` in the transcript. Read at the top level (Claude Code) and
 *  under `payload` (codex), so both harnesses are covered. Bad lines are skipped. */
export function collectCwds(raw: string): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('/')) out.add(v);
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const rec = parsed as { cwd?: unknown; payload?: unknown };
    add(rec.cwd);
    if (typeof rec.payload === 'object' && rec.payload !== null) {
      add((rec.payload as { cwd?: unknown }).cwd);
    }
  }
  return out;
}

/** One path segment: stops at `/`, whitespace, quotes and JSON punctuation. */
const COMP = String.raw`[^/\s"'\\,:;)\]}<>]+`;
// macOS/Windows display names can contain spaces, but only consume them while
// more path follows, so a bare home-dir mention doesn't swallow trailing prose.
const USER_WITH_SPACES = `${COMP}(?:(?: +${COMP})+(?=/))?`;
const EMBEDDED_HOME_RE = new RegExp(
  '(?:' +
    String.raw`\/home\/${COMP}` +
    '|' +
    String.raw`\/Users\/${USER_WITH_SPACES}` +
    '|' +
    String.raw`\/mnt\/c\/Users\/${USER_WITH_SPACES}` +
    '|' +
    // Component boundary, so these don't match inside `/rootfs` or `/root_ca.pem`.
    String.raw`\/var\/root(?![^/])` +
    '|' +
    String.raw`\/root(?![^/])` +
    ')' +
    String.raw`(?:\/${COMP})*`,
  'g'
);

export function collectEmbeddedHomePaths(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.matchAll(EMBEDDED_HOME_RE)) out.add(m[0]);
  return out;
}

function literalReplaceAll(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

/** Can `ch` continue a path component? A `.` counts only mid-component, so `…/repo.git`
 *  is one component but `…/repo.` ending a sentence is not. */
function continuesComponent(text: string, at: number): boolean {
  const ch = text[at];
  if (ch === undefined) return false;
  if (/[A-Za-z0-9_-]/.test(ch)) return true;
  return ch === '.' && at + 1 < text.length && /[A-Za-z0-9_-]/.test(text[at + 1]);
}

/** Replace `needle` only where it ends at a component boundary, so stripping `…/wt/repo`
 *  can't turn `…/wt/repo-backup` into `<replacement>-backup`. Skipped ones go to the home pass. */
function replacePrefixAtBoundary(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  let out = '';
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return out + haystack.slice(from);
    const end = i + needle.length;
    out += haystack.slice(from, i) + (continuesComponent(haystack, end) ? needle : replacement);
    from = end;
  }
}

/** Replace a prefix and its dash-encoded form (`.claude/projects/<encoded>/`). */
function stripBothForms(haystack: string, needle: string, replacement: string): string {
  const out = literalReplaceAll(haystack, needle, replacement);
  return literalReplaceAll(out, needle.replace(/\//g, '-'), replacement.replace(/\//g, '-'));
}

export function sanitizeSessionJsonl(raw: string, opts: SanitizeOptions = {}): SanitizeResult {
  const placeholder = opts.placeholder ?? DEFAULT_PLACEHOLDER;
  const markers = opts.forbiddenMarkers ?? [];
  const cwds = collectCwds(raw);
  let working = raw;
  let prefixStripped: string | null = null;
  let encodedPrefixStripped: string | null = null;
  let homeDirStripped: string | null = null;
  let encodedHomeDirStripped: string | null = null;
  let embeddedPrefixStripped: string | null = null;
  let embeddedHomeDirStripped: string | null = null;

  const requested = opts.cwdPrefixes?.length
    ? [...opts.cwdPrefixes]
    : opts.cwdPrefix
      ? [opts.cwdPrefix]
      : cwds.size > 0
        ? [findLongestCommonPathPrefix(cwds)]
        : [];
  // Longest first, so a shorter root sharing a prefix can't partly clobber a nested one.
  const prefixes = [...new Set(requested.filter(Boolean))].sort((a, b) => b.length - a.length);

  // EVERY root before ANY home dir: a home pass run between roots would rewrite a
  // sibling root's own prefix, leaving it unmatched when its turn came.
  for (const prefix of prefixes) {
    const encodedPrefix = prefix.replace(/\//g, '-');
    working = replacePrefixAtBoundary(working, prefix, placeholder);
    working = literalReplaceAll(working, encodedPrefix, placeholder.replace(/\//g, '-'));
    prefixStripped ??= prefix;
    encodedPrefixStripped ??= encodedPrefix;
  }
  // Only catches what is left outside the roots, e.g. `/home/<user>/.claude/projects/`.
  const homeDirs = new Set(
    prefixes
      .map((p) => extractHomeDir(p))
      .filter((h): h is string => h !== null && !prefixes.includes(h))
  );
  for (const homeDir of homeDirs) {
    const encodedHomeDir = homeDir.replace(/\//g, '-');
    working = replacePrefixAtBoundary(working, homeDir, HOME_DIR_PLACEHOLDER);
    working = literalReplaceAll(working, encodedHomeDir, HOME_DIR_PLACEHOLDER.replace(/\//g, '-'));
    homeDirStripped ??= homeDir;
    encodedHomeDirStripped ??= encodedHomeDir;
  }

  if (opts.scrubEmbeddedHomePaths) {
    const embedded = collectEmbeddedHomePaths(working);
    if (embedded.size > 0) {
      // Take each path's own shortest `/repo`-terminated prefix rather than a
      // common prefix, which mis-collapses when paths diverge above the root.
      const repoRoots = new Set<string>();
      const homeDirs = new Set<string>();
      for (const p of embedded) {
        const h = extractHomeDir(p);
        if (h) homeDirs.add(h);
        const m = p.match(/^(.*?\/repo)(?:\/|$)/);
        if (m) repoRoots.add(m[1]);
      }
      // Longest first, so a shorter root sharing a prefix can't partly clobber a nested one.
      const sortedRoots = [...repoRoots].sort((a, b) => b.length - a.length);
      for (const root of sortedRoots) working = stripBothForms(working, root, placeholder);
      for (const h of homeDirs) working = stripBothForms(working, h, HOME_DIR_PLACEHOLDER);
      embeddedPrefixStripped = sortedRoots[0] ?? null;
      embeddedHomeDirStripped = [...homeDirs][0] ?? null;
    }
  }

  const markersScrubbed: Record<string, number> = {};
  for (const re of markers) {
    let count = 0;
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const global = new RegExp(re.source, flags);
    working = working.replace(global, () => {
      count++;
      return REDACTION_PLACEHOLDER;
    });
    if (count > 0) markersScrubbed[re.source] = count;
  }

  return {
    sanitized: working,
    prefixStripped,
    encodedPrefixStripped,
    homeDirStripped,
    encodedHomeDirStripped,
    embeddedPrefixStripped,
    embeddedHomeDirStripped,
    markersScrubbed,
  };
}
