/**
 * snapshot-to-task: Create a harbor task scaffold from a snapshot.
 *
 * Usage:
 *   npx tsx scripts/snapshot-to-task.ts --snapshot <dir>
 */

import { execFileSync, execSync } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, join, resolve } from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { stripAuthoringScaffolding, truncationIndex, turnsFromLines } from './harness-session.mjs';
// This script must not call cpSync — it fails EACCES on a macOS docker bind mount.
import { HOLISTIC_RUBRIC_SCAFFOLD } from './holistic-rubric-scaffold';
import { copyTree } from './lib/copy-tree';
import { collectCwds, sanitizeSessionJsonl } from './sanitize-session-jsonl';

// --- CLI ---

const argv = yargs(hideBin(process.argv))
  .option('snapshot', {
    type: 'string',
    describe: 'Path to the snapshot directory',
    demandOption: true,
  })
  .option('json', {
    type: 'boolean',
    describe: 'Output structured JSON logs',
    default: false,
  })
  .strict()
  .help()
  .parseSync();

const log = pino(
  { name: 'snapshot-to-task', level: 'info' },
  argv.json
    ? process.stdout
    : pinoPretty({ colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' })
);

// --- Read snapshot data ---

const snapshotDir = argv.snapshot;

if (!existsSync(snapshotDir)) {
  log.fatal(
    { path: snapshotDir },
    'Snapshot directory not found. Check that the path points to a directory inside explore/snapshots/.'
  );
  process.exit(1);
}

interface SnapshotMetadata {
  slug: string;
  session_uuid: string;
  /** Absent on snapshots captured before harness selection existed. */
  harness?: string;
  original_cwd: string;
  commit: string | null;
  branch: string | null;
  remote_url: string | null;
  timestamp: string;
  plugin_version: string;
}

interface Annotation {
  what_trying: string;
  what_hoping: string;
  what_happened: string;
  [key: string]: string;
}

const metadata = JSON.parse(
  readFileSync(join(snapshotDir, 'metadata.json'), 'utf8')
) as SnapshotMetadata;
const annotation = JSON.parse(
  readFileSync(join(snapshotDir, 'annotation.json'), 'utf8')
) as Annotation;

if (!metadata.slug) {
  log.fatal(
    'No slug found in snapshot metadata.json. This snapshot may have been created by an older version of the plugin. Please file a bug.'
  );
  process.exit(1);
}

const slug = metadata.slug;

// --- Locate harbor infrastructure ---

function findRepoRoot(): string | null {
  let dir = process.cwd();
  while (dir !== resolve(dir, '..')) {
    if (existsSync(join(dir, 'harbor-tasks'))) return dir;
    dir = resolve(dir, '..');
  }
  return null;
}

const maybeRepoRoot = findRepoRoot();

if (!maybeRepoRoot) {
  log.fatal(
    "Could not find harbor-tasks/ directory. Make sure you're running this from the toolkit root (the Authoring container). Please file a bug if this persists."
  );
  process.exit(1);
}

const repoRoot: string = maybeRepoRoot;

const harborTasks = join(repoRoot, 'harbor-tasks');
const sharedCandidates = [join(harborTasks, 'raccoon-shared'), join(repoRoot, 'task-shared')];
const sharedDir = sharedCandidates.find((d) => existsSync(d));
const taskDir = join(harborTasks, slug);

if (existsSync(taskDir)) {
  log.fatal(
    { path: taskDir },
    `Task directory already exists. To recreate it, delete it first: rm -rf ${taskDir}`
  );
  process.exit(1);
}

if (!sharedDir) {
  log.fatal(
    'Shared infrastructure (Dockerfile, test.sh, etc.) not found. The toolkit may be corrupted. Please file a bug.'
  );
  process.exit(1);
}

// --- Detect repo name ---

interface ToolkitConfig {
  repo: string;
  defaultCommit: string;
  /** The packed kit's release version (git describe at pack time). */
  version?: string;
}

function readToolkitConfig(): ToolkitConfig | null {
  const configPath = join(repoRoot, 'toolkit.json');
  if (!existsSync(configPath)) return null;
  return JSON.parse(readFileSync(configPath, 'utf8')) as ToolkitConfig;
}

function repoNameFromRemote(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function findSubmoduleDir(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const reposDir = join(repoRoot, 'repos');
  if (!existsSync(reposDir)) return null;

  const normalize = (url: string) =>
    url
      .replace(/\.git$/, '')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .toLowerCase();

  for (const entry of readdirSync(reposDir)) {
    const repoPath = join(reposDir, entry, 'repo');
    if (!existsSync(repoPath)) continue;
    try {
      const remote = execSync('git remote get-url origin', {
        cwd: repoPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (normalize(remote) === normalize(remoteUrl)) return entry;
    } catch {
      continue;
    }
  }
  return null;
}

const toolkitConfig = readToolkitConfig();

// A polyglot toolkit's toolkit.json has repos[] + polyglot:true (no top-level .repo).
// Derive which member this task targets from the snapshot's original_cwd basename,
// validated against the member list.
const polyglotMember = (() => {
  const cfg = toolkitConfig as { polyglot?: boolean; repos?: Array<{ repo: string }> } | null;
  if (!cfg?.polyglot || !Array.isArray(cfg.repos)) return null;
  const base = metadata.original_cwd?.split('/').filter(Boolean).pop() ?? null;
  const members = cfg.repos.map((r) => r.repo);
  return base && members.includes(base) ? base : null;
})();
const repoName =
  polyglotMember ??
  toolkitConfig?.repo ??
  findSubmoduleDir(metadata.remote_url) ??
  repoNameFromRemote(metadata.remote_url);

if (!repoName) {
  log.fatal(
    'Could not determine repo name. The toolkit may be missing toolkit.json. Please file a bug.'
  );
  process.exit(1);
}

const commitShort = metadata.commit ? metadata.commit.slice(0, 9) : 'unknown';
const sessionUuid = metadata.session_uuid;

log.info({ slug, repo: repoName, commit: commitShort }, 'Creating harbor task');

// --- Create task directory structure ---

mkdirSync(join(taskDir, 'environment'), { recursive: true });
mkdirSync(join(taskDir, 'tests'), { recursive: true });
mkdirSync(join(taskDir, 'reference-runs'), { recursive: true });

// --- Copy shared infrastructure ---

// The complete grader asset set test.sh depends on: the grader system prompt
// and the renderer (test.sh exits without the renderer). Sources missing from
// task-shared/ are skipped by the existsSync guard below.
const sharedFiles = [
  { src: 'test.sh', dest: 'tests/test.sh' },
  {
    src: 'grader-system-prompt-consolidated.md',
    dest: 'tests/grader-system-prompt-consolidated.md',
  },
  // test.sh execs this to render the grade; without it the verifier writes no reward
  // file and the trial errors out rather than scoring.
  { src: 'render-grade-consolidated.py', dest: 'tests/render-grade-consolidated.py' },
];

for (const { src, dest } of sharedFiles) {
  const srcPath = join(sharedDir, src);
  const destPath = join(taskDir, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    if (src === 'test.sh') chmodSync(destPath, 0o755);
    log.debug({ src, dest }, 'Copied shared file');
  } else {
    log.warn({ src }, 'Shared file not found');
  }
}

// Deterministic checks (tests/typecheck/lint). test.sh sources these and hands
// their output to the grader as evidence for the CORRECTNESS score, so without
// them a code task's correctness is never signal-backed — the grader falls back
// to reading the diff alone. Same per-member-then-generic resolution as the
// Dockerfile below: a polyglot toolkit ships test-commands.<member>.sh per
// member, a single-repo toolkit ships the lone test-commands.sh.
const perMemberTestCommands = join(sharedDir, `test-commands.${repoName.toLowerCase()}.sh`);
const genericTestCommands = join(sharedDir, 'test-commands.sh');
const testCommandsSrc = existsSync(perMemberTestCommands)
  ? perMemberTestCommands
  : genericTestCommands;
if (existsSync(testCommandsSrc)) {
  const testCommandsDest = join(taskDir, 'tests', 'test-commands.sh');
  copyFileSync(testCommandsSrc, testCommandsDest);
  chmodSync(testCommandsDest, 0o755);
  log.debug({ src: testCommandsSrc }, 'Copied deterministic checks');
} else {
  // Not fatal: the grader still scores correctness by walking the changed code.
  log.info(
    'No test-commands.sh for this repo — expected when it has no runnable suite. The grader scores correctness by reading the changed code instead; say so in your holistic rubric.'
  );
}

// --- Write Dockerfile with session resume support ---
//
// Read the per-repo task-shared/Dockerfile (Ruby/Postgres/Node for ZenBill,
// TS-Node/Postgres/pnpm for Palolo) from the toolkit and append session-
// staging COPY/RUN steps. Session staging happens after the original CMD —
// COPY and RUN are layer ops independent of CMD, so the original
// `CMD ["sleep", "infinity"]` remains active after the appended layers.
//
// Falls back to a bare debian Dockerfile if no task-shared/Dockerfile is
// present (toolkit corruption, or a repo without a per-repo Dockerfile).

// Polyglot toolkits ship a per-member task-shared/Dockerfile.<member>; a graded task
// targets one member, so prefer its Dockerfile. Single-repo toolkits use the lone
// task-shared/Dockerfile. Fall back to the generic one if the per-member file is absent.
const perMemberDockerfile = join(repoRoot, 'task-shared', `Dockerfile.${repoName.toLowerCase()}`);
const taskSharedDockerfile = existsSync(perMemberDockerfile)
  ? perMemberDockerfile
  : join(repoRoot, 'task-shared', 'Dockerfile');
let baseDockerfile: string;
if (existsSync(taskSharedDockerfile)) {
  baseDockerfile = readFileSync(taskSharedDockerfile, 'utf-8');
  log.debug({ dockerfile: taskSharedDockerfile }, 'Loaded base Dockerfile');
} else {
  log.warn(
    'task-shared/Dockerfile not found; falling back to bare debian. The harbor task container will lack any language runtime — agents will not be able to execute code in the repo.'
  );
  baseDockerfile = `FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \\
    git \\
    python3 \\
    curl \\
    jq \\
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally (needed by the grader in test.sh)
RUN curl -fsSL https://claude.ai/install.sh | bash && \\
    cp /root/.claude-code/claude /usr/local/bin/claude 2>/dev/null || \\
    cp /root/.local/bin/claude /usr/local/bin/claude 2>/dev/null || \\
    ln -sf $(find /root -name claude -type f 2>/dev/null | head -1) /usr/local/bin/claude

WORKDIR /workspace
COPY workspace/ .

# Block network tools — agent should only read code and write documents
RUN mkdir -p .claude && \\
    echo '{"permissions":{"deny":["WebFetch","WebSearch"]}}' > .claude/settings.json

RUN git init && \\
    git config user.email "dev@agent" && \\
    git config user.name "Dev" && \\
    git add -A && \\
    git commit -m "initial" --quiet

CMD ["sleep", "infinity"]
`;
}

// Wrapped in toolkit-managed sentinels so check-task-infra reads this as the
// toolkit's own append rather than an edit to the Dockerfile.
// Only Claude Code produces the sibling session/ directory (subagents, tool results).
// A COPY of an empty directory fails the build outright — buildkit does not carry empty
// directories in the context, so the layer errors with `"/session": not found`.
// Read the SNAPSHOT, not the task dir: the Dockerfile is generated before the session
// files are copied into environment/, so the task-side copy is not there yet.
const sessionSiblingDir = join(snapshotDir, 'session');
const hasSessionSibling =
  existsSync(sessionSiblingDir) && readdirSync(sessionSiblingDir).length > 0;

const sessionStaging = `
# >>> toolkit-managed: snapshot-session >>>
# Stage session files for the snapshot agent adapter to install at runtime.
COPY session.jsonl /tmp/snapshot-session/session.jsonl
${hasSessionSibling ? 'COPY session/ /tmp/snapshot-session/session/\n' : ''}RUN echo '${sessionUuid}' > /tmp/snapshot-session/uuid.txt
# <<< toolkit-managed <<<
`;

const dockerfile = baseDockerfile.trimEnd() + '\n' + sessionStaging;

writeFileSync(join(taskDir, 'environment', 'Dockerfile'), dockerfile);
log.debug('Wrote Dockerfile (per-repo base + session staging)');

// --- Copy snapshot.patch as workspace.patch ---

const snapshotPatch = join(snapshotDir, 'snapshot.patch');
if (existsSync(snapshotPatch)) {
  copyFileSync(snapshotPatch, join(taskDir, 'environment', 'workspace.patch'));
  log.debug('Copied snapshot.patch -> workspace.patch');
}

// --- Scrub the worker's filesystem layout out of the session ---
// In Explore the recorded `cwd` is the worker's HOST checkout (explore/repo is an absolute
// symlink); rewriting the repo root to /workspace both drops the leak and matches the trial.

const WORKSPACE_MOUNT = '/workspace';

const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Member names when this toolkit is polyglot; empty means single-repo. */
const MEMBER_NAMES: readonly string[] = (() => {
  const dir = join(repoRoot, 'repos');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
})();

/** The repo root within a cwd — the prefix a trial mounts at /workspace. `/repos/<member>`
 *  anchors only on a polyglot toolkit, so a personal `~/repos/…` above it can't win. */
function repoRootOf(cwd: string): string | null {
  if (MEMBER_NAMES.length > 0) {
    // A real member of THIS toolkit wins; the generic shape covers a member whose
    // directory the toolkit no longer has (an older snapshot, a renamed member).
    for (const name of MEMBER_NAMES) {
      const hit = cwd.match(new RegExp(`^(.*?/repos/${escapeRegExp(name)})(?:/|$)`));
      if (hit) return hit[1];
    }
    const generic = cwd.match(/^(.*?\/repos\/[^/]+)(?:\/|$)/);
    if (generic) return generic[1];
  }
  // `/repo` needs a component boundary, so it never matches inside `/repos/`.
  const m = cwd.match(/^(.*?\/repo)(?:\/|$)/);
  return m ? m[1] : null;
}

/** Rewrite every checkout root to /workspace, and the home dir each sits under to `~`. The
 *  `repo/` anchor needs no host-root list; the home pass still keys off extractHomeDir. */
function scrubWorkerPaths(raw: string): { text: string; roots: string[] } {
  // Each cwd contributes its own root, longest first, so a nested root isn't clobbered
  // and a session spanning two checkouts is scrubbed rather than skipped.
  const roots = [...new Set([...collectCwds(raw)].map(repoRootOf))]
    .filter((r): r is string => r !== null)
    .sort((a, b) => b.length - a.length);
  const { sanitized } = sanitizeSessionJsonl(raw, {
    cwdPrefixes: roots,
    placeholder: WORKSPACE_MOUNT,
  });
  return { text: sanitized, roots };
}

// --- Copy session files for --resume ---
//
// The full session.jsonl (including any post-end_turn entries) goes into the
// task root for reference. A truncated version — keeping everything up to
// and including the last assistant entry with stop_reason="end_turn" — goes
// into environment/ for the container. Stopping on a clean assistant turn
// avoids Claude Code's synthetic "No response requested." injection when
// the session is resumed with --fork-session and a new --print prompt.

const sessionJsonl = join(snapshotDir, 'session.jsonl');
if (existsSync(sessionJsonl)) {
  // Fail-open: a session this can't scrub ships exactly as it was, because a
  // leaked path is a smaller problem than a task that can't be created.
  let sessionText = readFileSync(sessionJsonl, 'utf8');
  try {
    const { text, roots } = scrubWorkerPaths(sessionText);
    if (roots.length > 0) {
      sessionText = text;
      log.info(
        { roots, mountedAt: WORKSPACE_MOUNT },
        'Rewrote the authoring checkout path to the trial mount point'
      );
    } else {
      log.debug('No worker-rooted cwd to rewrite; session used as-is');
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Could not rewrite paths in the session; using it as-is'
    );
  }

  // Full version for reference
  writeFileSync(join(taskDir, 'session-full.jsonl'), sessionText);
  log.debug('Wrote full session.jsonl to task root');

  // Truncated version for the container: strip everything from the last
  // user text turn onwards. This drops the failure-eliciting question
  // (which `--print` will redeliver to the trial agent as the new prompt)
  // AND the failure response itself (so the trial agent doesn't see its
  // previous answer), while preserving conversational context up to the
  // last clean assistant `end_turn`.
  //
  // Algorithm (refined Option B):
  //   1. Find U = index of the last user-text turn that is NOT a slash
  //      command (use the same command-marker filter as
  //      extractLastUserMessage).
  //   2. Walk backwards from U - 1 to find the last `assistant` entry
  //      with stop_reason: "end_turn".
  //   3. Truncate slice(0, lastEndTurnIndex + 1).
  //
  // If U doesn't exist or no end_turn assistant precedes U, write an
  // empty session.jsonl — the snapshot agent adapter detects this and
  // skips --resume entirely, starting fresh from --print.
  const sessionLines = sessionText.trimEnd().split('\n');

  // A non-Claude session is not a Claude transcript, so the scan below finds no
  // `stop_reason: "end_turn"` and would silently write an empty session. Its reader
  // applies the same rule in that harness's own format.
  const harness = metadata.harness ?? 'claude-code';
  const isClaude = harness === 'claude-code';

  let lastUserTextIndex = -1;
  for (let i = 0; i < sessionLines.length; i++) {
    try {
      const entry = JSON.parse(sessionLines[i]) as {
        type?: string;
        isCompactSummary?: boolean;
        message?: { content?: unknown };
      };
      if (entry.type !== 'user' || typeof entry.message?.content !== 'string') continue;
      // Compaction summaries are synthetic user turns whose text often quotes
      // earlier /create-snapshot:snapshot runs — never the command turn itself,
      // so they must not trip the break below.
      if (entry.isCompactSummary) continue;
      const content = entry.message.content;
      // Mirror extractLastUserMessage: skip the snapshot command itself
      // and any slash-command / local-command marker turns.
      if (content.includes('create-snapshot:snapshot')) break;
      if (
        content.includes('<command-name>') ||
        content.includes('<command-message>') ||
        content.includes('<local-command-caveat>')
      ) {
        continue;
      }
      lastUserTextIndex = i;
    } catch {
      continue;
    }
  }

  let lastEndTurnIndex = -1;
  if (lastUserTextIndex > 0) {
    for (let i = lastUserTextIndex - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(sessionLines[i]) as {
          type?: string;
          message?: { stop_reason?: unknown };
        };
        if (entry.type === 'assistant' && entry.message?.stop_reason === 'end_turn') {
          lastEndTurnIndex = i;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  if (!isClaude) {
    const cut = truncationIndex(turnsFromLines(harness, sessionLines));
    const kept = cut >= 0 ? sessionLines.slice(0, cut + 1) : [];
    const truncated = stripAuthoringScaffolding(harness, kept);
    writeFileSync(
      join(taskDir, 'environment', 'session.jsonl'),
      truncated.length ? truncated.join('\n') + '\n' : ''
    );
    log.debug(
      { harness, fullLines: sessionLines.length, truncatedLines: truncated.length },
      'Wrote truncated session.jsonl to environment/ (harness reader)'
    );
  } else if (lastEndTurnIndex >= 0) {
    const truncated = sessionLines.slice(0, lastEndTurnIndex + 1);
    writeFileSync(join(taskDir, 'environment', 'session.jsonl'), truncated.join('\n') + '\n');
    log.debug(
      { fullLines: sessionLines.length, truncatedLines: truncated.length },
      'Wrote truncated session.jsonl to environment/ (strips last user turn + failure response, keeps through last clean assistant end_turn)'
    );
  } else {
    writeFileSync(join(taskDir, 'environment', 'session.jsonl'), '');
    if (lastUserTextIndex < 0) {
      log.warn(
        'No user text turn found in session — wrote empty session.jsonl. The snapshot agent adapter will skip --resume and start fresh.'
      );
    } else {
      log.warn(
        'No assistant entry with stop_reason="end_turn" found before the last user turn (one-shot snapshot) — wrote empty session.jsonl. The snapshot agent adapter will skip --resume and start fresh.'
      );
    }
  }
}
const sessionDir = join(snapshotDir, 'session');
if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
  copyTree(sessionDir, join(taskDir, 'environment', 'session'));
  // Claude Code writes subagent files write-only (--w-------). Fix them so
  // Harbor's dirhash can read them during environment setup.
  execSync(`chmod -R +r "${join(taskDir, 'environment', 'session')}"`, { stdio: 'pipe' });
  log.debug('Copied session/');
} else {
  mkdirSync(join(taskDir, 'environment', 'session'), { recursive: true });
}

// The harness that captured the snapshot; the trial runs this one.
const harness =
  typeof metadata.harness === 'string' && metadata.harness ? metadata.harness : 'claude-code';

/**
 * The model and effort this harness defaulted to when the task was authored, recorded
 * for reference only — nothing reads these back, and a trial still resolves both from
 * the registry at run time. Best-effort: a task is not worth failing over a note.
 */
function authoredDefaults(harnessId: string): { model: string; effort: string } | null {
  try {
    const resolver = join(repoRoot, 'scripts', 'resolve_harness.py');
    // Same interpreter search as `_raccoon_python` in scripts/lib/harness-credentials.sh
    // and `pythonWithTomllib` in submit-task.ts: `python3` is not always 3.11+, and the
    // registry needs tomllib. Best-effort, so a miss just omits the note.
    let python = '';
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
        python = candidate;
        break;
      } catch {
        continue;
      }
    }
    if (!python) return null;
    const rows = execFileSync(python, [resolver, '--defaults'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of rows.split('\n')) {
      const [id, model, effort] = line.split('\t');
      if (id === harnessId && model) return { model, effort: effort ?? '' };
    }
  } catch {
    // registry unreadable here — omit the note
  }
  return null;
}

const authored = authoredDefaults(harness);

// --- Write task.toml ---

// The reference-data corpus is included in every zeta task (build-workspace decides from the repo),
// so there's nothing to set here.
const taskToml = `version = "1.0"

[metadata]
program = "raccoon"
author = "rl-env-coding"
category = "sdlc/technical-writing"
repo = "${repoName}"
commit = "${commitShort}"
# The toolkit release this task was created with. Written by the toolkit —
# leave it in place: task tooling reads it to know which toolkit's assets
# this task grades with.
toolkit_version = "${toolkitConfig?.version ?? 'unknown'}"
snapshot = "${basename(snapshotDir)}"
session_uuid = "${sessionUuid}"
# Set true for a task about a UI: the trial gets Playwright + Chromium (\`pw <script.js>\`),
# and on claude the \`Read\` tool so the agent can view a screenshot it takes.
browser = false
${authored ? `authored_model = "${authored.model}"\nauthored_effort = "${authored.effort}"\n` : ''}

[verifier]
timeout_sec = 7200.0

[agent]
harness = "${harness}"
timeout_sec = 18000.0

[environment]
build_timeout_sec = 6000.0
cpus = 2
memory_mb = 4096
storage_mb = 10240
gpus = 0
allow_internet = true

[verifier.env]
ANTHROPIC_API_KEY = "\${ANTHROPIC_API_KEY}"
ANTHROPIC_BASE_URL = "\${ANTHROPIC_BASE_URL}"

[solution.env]
`;

writeFileSync(join(taskDir, 'task.toml'), taskToml);
log.debug('Wrote task.toml');

// --- Extract instruction from session transcript ---

function extractLastUserMessage(sessionPath: string, harness: string): string | null {
  if (!existsSync(sessionPath)) return null;

  const lines = readFileSync(sessionPath, 'utf8').trimEnd().split('\n');

  // A non-Claude session has no `type: "user"` records, so the scan below finds nothing
  // and the worker silently gets a placeholder instruction. Its reader applies the same
  // rule — last real user turn, ignoring command invocations — in that harness's format.
  if (harness !== 'claude-code') {
    const userTurns = turnsFromLines(harness, lines).filter(
      (t) => t.role === 'user' && !t.isCommand && t.text.trim()
    );
    return userTurns.length ? userTurns[userTurns.length - 1].text : null;
  }

  let lastUserMessage: string | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        isCompactSummary?: boolean;
        message?: { content?: unknown };
      };
      if (entry.type === 'user' && typeof entry.message?.content === 'string') {
        // Synthetic compaction summary — not a real user turn, and its text
        // often quotes earlier /create-snapshot:snapshot runs.
        if (entry.isCompactSummary) continue;
        const content = entry.message.content;
        if (content.includes('create-snapshot:snapshot')) break;
        if (
          content.includes('<command-name>') ||
          content.includes('<command-message>') ||
          content.includes('<local-command-caveat>')
        ) {
          continue;
        }
        lastUserMessage = content;
      }
    } catch {
      continue;
    }
  }
  return lastUserMessage;
}

const lastUserMessage = extractLastUserMessage(
  join(snapshotDir, 'session.jsonl'),
  metadata.harness ?? 'claude-code'
);

const instructionHeader =
  '# Replace this with your refined task instruction\n\n' +
  "<!-- The text below was auto-extracted from your snapshot's last user message.\n" +
  '     Refine, condense, or rewrite to focus on the behavior you want to elicit. -->\n\n';

if (lastUserMessage) {
  writeFileSync(
    join(taskDir, 'instruction.md'),
    instructionHeader + lastUserMessage.trimEnd() + '\n'
  );
  log.info('Wrote instruction.md (from last user message in session)');
} else {
  writeFileSync(
    join(taskDir, 'instruction.md'),
    instructionHeader +
      '<!-- Could not extract user message from session. Write the instruction manually. -->\n'
  );
  log.warn('Could not extract instruction from session — needs manual editing');
}

// --- Scaffold holistic-rubric.md ---

const holisticRubricMd = `<!--
  Snapshot: ${basename(snapshotDir)}
  Session:  ${metadata.session_uuid}
  Repo:     ${metadata.remote_url}
  Commit:   ${metadata.commit}

  What happened in the snapshot conversation

  The worker was trying to: ${annotation.what_trying}
  They hoped Claude would:  ${annotation.what_hoping}
  Instead, Claude:          ${annotation.what_happened}

  Draft this file with /write-holistic-rubric, or point your agent at it,
  session-full.jsonl, and task-shared/grading-standard.md. Delete this comment
  when you are done.
-->

${HOLISTIC_RUBRIC_SCAFFOLD}`;

writeFileSync(join(taskDir, 'tests', 'holistic-rubric.md'), holisticRubricMd);
log.info('Scaffolded tests/holistic-rubric.md (needs manual editing)');

// --- Build workspace ---

const buildScript = join(repoRoot, 'scripts', 'build-workspace.sh');

if (existsSync(buildScript)) {
  log.info({ repo: repoName, commit: commitShort }, 'Building workspace');
  try {
    execSync(`bash "${buildScript}" "${slug}" "${commitShort}"`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      // build-workspace does a bulk-file write burst (git archive|tar of the
      // repo tree + a throwaway git add/commit to apply the patch, and for zeta
      // toolkits a hardlink-stage of the ~126k-file reference-data corpus that
      // falls back to a full copy across filesystems). On a slow bind mount
      // (Docker Desktop non-VirtioFS, or WSL2 with the toolkit on a Windows/9p
      // path) that legitimately runs into minutes, so a tight cap false-fails a
      // working-but-slow build as "not runnable". Keep this generous — it's only
      // a backstop against a true hang; the real Harbor build downstream budgets
      // build_timeout_sec = 6000.
      timeout: 1_200_000,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.fatal({ error: msg }, 'Workspace build failed — task is not runnable');
    log.fatal(`  Retry manually: bash scripts/build-workspace.sh ${slug}`);
    log.fatal(`  Then: scripts/harbor-run harbor-tasks/${slug}`);
    process.exit(1);
  }
} else {
  log.fatal('scripts/build-workspace.sh not found. Please file a bug.');
  process.exit(1);
}

try {
  execSync('bash -ic "_ev task_created 2>/dev/null" 2>/dev/null', {
    stdio: 'ignore',
    timeout: 5000,
  });
} catch {
  // best-effort
}

// --- Done ---

log.info({ taskDir: resolve(taskDir) }, 'Task scaffolded');
log.info('Next steps:');
log.info('  1. Review instruction.md');
log.info('  2. Edit tests/holistic-rubric.md — write the rubric');
log.info('  3. Run calibration trials to validate scoring tiers');
