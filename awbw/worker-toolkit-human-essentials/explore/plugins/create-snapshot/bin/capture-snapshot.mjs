#!/usr/bin/env node

import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { linearSnapshotLines, readSession } from './harness-session.mjs';

// --- Argument parsing ---

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = val;
        i++;
      }
    }
  }
  return args;
}

// Last-resort data dir. Claude Code's plugin runtime always provides one, so this is
// what makes the start marker and session record work under any other harness.
function defaultDataDir() {
  const home = process.env.HOME || '/root';
  return path.join(home, '.raccoon', 'snapshot-data');
}

const args = parseArgs(process.argv);
const slug = args.slug;
const annotationPath = args.annotation;
const outputDir = args['output-dir'];

if (!args['mark-start'] && (!slug || !annotationPath || !outputDir)) {
  console.error(
    'Usage: capture-snapshot.mjs --slug <slug> --annotation <path> --output-dir <dir> [--plugin-data <path>]\n' +
      '       capture-snapshot.mjs --mark-start [--harness <id>]'
  );
  process.exit(1);
}

// --- Locate session info ---

// --harness wins over the launcher's RACCOON_HARNESS so a caller that knows which
// conversation it is capturing can say so; the default keeps Claude Code's plugin
// working unchanged. Claude Code has an exact cut point (the snapshot slash command)
// and a message tree to prune, so it keeps the bespoke path below; other harnesses go
// through the shared reader.
const HARNESS = args.harness || process.env.RACCOON_HARNESS || 'claude-code';
const IS_CLAUDE = HARNESS === 'claude-code';
// The generated restore.sh writes one of exactly two session layouts, and everything
// below branches on IS_CLAUDE — so a third harness would silently be handed codex's
// $CODEX_HOME/sessions paths. Refuse instead; adding a harness means adding a layout.
if (!IS_CLAUDE && HARNESS !== 'codex') {
  console.error(
    `capture-snapshot: no session-restore layout for harness "${HARNESS}". ` +
      'Add one to capture-snapshot.mjs (and harness-session.mjs) before capturing with it.'
  );
  process.exit(1);
}

// Try multiple strategies to find the current session transcript:
// 1. Plugin data dir (from SessionStart hook)
// 2. Scan ~/.claude/projects/ for the most recently modified JSONL

let session_id = null;
let transcript_path = null;

const dataDir =
  args['plugin-data'] ||
  process.env.RACCOON_SNAPSHOT_DATA ||
  process.env.CLAUDE_PLUGIN_DATA ||
  (process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, '.data')) ||
  defaultDataDir();

// The SessionStart hook records the live session for every harness, so prefer it over
// guessing. `readSession` falls back to the newest file on disk when it is absent.
let recordedSession = null;
if (dataDir) {
  const sessionInfoPath = path.join(dataDir, 'current-session.json');
  if (fs.existsSync(sessionInfoPath)) {
    try {
      recordedSession = JSON.parse(fs.readFileSync(sessionInfoPath, 'utf8'));
    } catch {
      recordedSession = null;
    }
  }
}

const startMarkerPath = dataDir ? path.join(dataDir, 'snapshot-start.json') : null;

// `--mark-start` runs BEFORE the annotation Q&A and records how long the conversation
// was at that moment. It is the linear-harness stand-in for Claude Code's slash-command
// line: without it, capture would stage the snapshot's own Q&A as conversation.
if (args['mark-start']) {
  const session = readSession(HARNESS);
  if (!session) {
    console.error(`No ${HARNESS} session found to mark.`);
    process.exit(1);
  }
  if (!startMarkerPath) {
    console.error('No data dir available to record the snapshot start marker.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(startMarkerPath), { recursive: true });
  fs.writeFileSync(
    startMarkerPath,
    JSON.stringify(
      { harness: HARNESS, transcript_path: session.rawPath, line_count: session.lines.length },
      null,
      2
    ) + '\n'
  );
  console.log(`Snapshot start marked at ${session.lines.length} records.`);
  process.exit(0);
}

let harnessSession = null;
if (!IS_CLAUDE) {
  harnessSession = readSession(HARNESS, recordedSession?.transcript_path);
  if (!harnessSession) {
    console.error(
      `Could not find a ${HARNESS} session to capture. Capture has to run from inside the ${HARNESS} conversation you want to snapshot.`
    );
    process.exit(1);
  }
  transcript_path = harnessSession.rawPath;
  // Fall back to a fresh id only if the harness records none — restore.sh names the
  // installed session by it, so it has to match what `resume` will look up.
  session_id = recordedSession?.session_id || harnessSession.sessionId || crypto.randomUUID();
} else if (recordedSession) {
  session_id = recordedSession.session_id;
  transcript_path = recordedSession.transcript_path;
}

// Fallback: find the most recently modified JSONL in ~/.claude/projects/
if (!transcript_path) {
  const homeDir = process.env.HOME || '/root';
  const projectsDir = path.join(homeDir, '.claude', 'projects');
  if (fs.existsSync(projectsDir)) {
    let newest = null;
    let newestMtime = 0;
    for (const projEntry of fs.readdirSync(projectsDir)) {
      const projDir = path.join(projectsDir, projEntry);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const file of fs.readdirSync(projDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(projDir, file);
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newest = filePath;
          session_id = file.replace(/\.jsonl$/, '');
        }
      }
    }
    transcript_path = newest;
  }
}

if (!transcript_path || !fs.existsSync(transcript_path)) {
  console.error(
    "Could not find a Claude Code session transcript. This script should be run from within a Claude Code conversation via the /create-snapshot:snapshot command. Please file a bug if you're seeing this unexpectedly."
  );
  process.exit(1);
}

if (!transcript_path || !fs.existsSync(transcript_path)) {
  console.error(`Transcript file not found at ${transcript_path}. Please file a bug.`);
  process.exit(1);
}

// --- Require a git repo at capture time ---
//
// A snapshot is "commit SHA + diff vs HEAD", reconstituted later via
// `git archive <SHA> | tar -x` + `git apply workspace.patch`. Without a git
// repo here we have no SHA to pin, no patch to record, and no way for
// downstream `build-workspace.sh` to reproduce the workspace — the resulting
// snapshot would be structurally meaningless. This check runs BEFORE the
// snapshot directory is created so a misconfigured invocation leaves no
// half-written state behind.

// Find the git repo by asking git itself — walks up from cwd looking for
// `.git`, handling submodules and worktrees correctly. Returns null when
// cwd is outside any repo, so the worker gets a clear "cd into your repo"
// error instead of silently descending into something they didn't name.
function findGitRepo() {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return top || null;
  } catch {
    return null;
  }
}

const gitRepo = findGitRepo();

if (!gitRepo) {
  console.error(
    "Error: Not running inside a git repo. /create-snapshot needs a git repo so it can pin a commit SHA and record a diff of in-flight changes; without one the snapshot can't be reproduced as a task. cd into the repo you're exploring (the toolkit's repo/ submodule) and re-run /create-snapshot:snapshot."
  );
  process.exit(1);
}

// --- Create snapshot directory ---

const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20260403-225449
const snapshotDir = path.join(outputDir, `${ts}-${slug}`);

if (fs.existsSync(snapshotDir)) {
  console.error(`Snapshot directory already exists: ${snapshotDir}\nPlease file a bug.`);
  process.exit(1);
}

fs.mkdirSync(snapshotDir, { recursive: true });

// --- Copy conversation transcript (trimmed + branch-pruned) ---

// The JSONL is a tree of messages linked by parentUuid. When the user rewinds
// a conversation, old branches remain in the file. We need to:
//   1. Cut at the LAST /create-snapshot:snapshot command (later invocations
//      supersede earlier ones in the same session)
//   2. Find the tip of the active branch (last message before the cut)
//   3. Walk parentUuid back to the root, collecting only messages on that path
//   4. Exclude the Q&A subgraphs of any PRIOR /create-snapshot:snapshot
//      invocations in this session (their cut points are on the same
//      conversation branch, so the walk would otherwise pull in the
//      assistant's annotation questions and the user's answers — a
//      contamination path that snapshot.patch doesn't show). Boundaries
//      for prior invocations are recorded in a side file (see end of
//      this script) so this run can identify them.
//   5. Drop bookkeeping entries whose content can leak rewound-branch state.

const rawLines = fs.readFileSync(transcript_path, 'utf8').trimEnd().split('\n');

// A user message is a /create-snapshot:snapshot invocation when its content
// STARTS with one of Claude Code's slash-command tags AND mentions the
// command name. The "starts with" guard distinguishes a real invocation
// from prose that quotes the command (a worker reporting a bug, the
// command-listing skill output, etc.) — prose doesn't begin with those
// tags. The whitespace-tolerant pattern survives minor format drift in
// Claude Code's slash-command rendering.
const SNAPSHOT_CMD_PATTERN =
  /<command-(?:name|message)>\s*\/?\s*create-snapshot:snapshot\s*<\/command-(?:name|message)>/;
function isSnapshotCommandContent(content) {
  if (typeof content !== 'string') return false;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('<command-name>') && !trimmed.startsWith('<command-message>')) {
    return false;
  }
  return SNAPSHOT_CMD_PATTERN.test(content);
}

// Find every snapshot-command line index, in order. The LAST one is the
// current invocation (cut point); earlier ones bound prior Q&A subgraphs.
const snapshotCmdIndexes = [];
for (let i = 0; i < rawLines.length; i++) {
  try {
    const entry = JSON.parse(rawLines[i]);
    if (entry.type === 'user' && isSnapshotCommandContent(entry.message?.content)) {
      snapshotCmdIndexes.push(i);
    }
  } catch {
    // Skip malformed lines
  }
}

const cutIndex =
  snapshotCmdIndexes.length > 0
    ? snapshotCmdIndexes[snapshotCmdIndexes.length - 1]
    : rawLines.length;
const priorCmdIndexes = snapshotCmdIndexes.slice(0, -1);

// Load prior-snapshot boundary records so we know where each earlier
// invocation's Q&A subgraph ended. The boundary file is written at the
// end of every capture run (see below) and is keyed by session uuid.
function loadPriorBoundaries() {
  if (!dataDir || !session_id) return [];
  const boundariesPath = path.join(dataDir, 'snapshot-boundaries.jsonl');
  if (!fs.existsSync(boundariesPath)) return [];
  const lines = fs.readFileSync(boundariesPath, 'utf8').trimEnd().split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.sessionUuid === session_id && rec.snapshotCommandUuid) out.push(rec);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
const priorBoundaries = loadPriorBoundaries();

// Compute the line ranges to exclude for each prior snapshot. The Q&A
// subgraph starts at the prior snapshot's command line and runs through
// the line whose entry uuid matches the boundary record (the last entry
// in the JSONL when that prior capture-snapshot completed).
//
// Fall back to the next snapshot command (or the current cut) when no
// matching boundary record exists — better to drop too much than to leak
// the Q&A; the visible cost is excluding any "real work" that happened
// between snapshots without a recorded boundary, which only occurs if
// the boundary log was wiped or the prior capture crashed.
function findUuidLineIndex(targetUuid, startLine, endLineExclusive) {
  for (let i = startLine; i < endLineExclusive; i++) {
    try {
      const entry = JSON.parse(rawLines[i]);
      if (entry.uuid === targetUuid) return i;
    } catch {
      /* skip */
    }
  }
  return -1;
}

const priorQAExcludedLines = new Set();
for (let i = 0; i < priorCmdIndexes.length; i++) {
  const startLine = priorCmdIndexes[i];
  const nextCutLine = i + 1 < priorCmdIndexes.length ? priorCmdIndexes[i + 1] : cutIndex;
  let snapshotCmdUuid = null;
  try {
    snapshotCmdUuid = JSON.parse(rawLines[startLine]).uuid || null;
  } catch {
    /* unparseable command line — skip */
  }
  let endLine = -1;
  if (snapshotCmdUuid) {
    const boundary = priorBoundaries.find((b) => b.snapshotCommandUuid === snapshotCmdUuid);
    if (boundary && boundary.lastEntryUuid) {
      endLine = findUuidLineIndex(boundary.lastEntryUuid, startLine, nextCutLine);
    }
  }
  // No matching boundary: bound the exclusion at the next snapshot/current
  // cut so the Q&A doesn't leak even if state was lost.
  if (endLine < 0) endLine = nextCutLine - 1;
  for (let j = startLine; j <= endLine; j++) priorQAExcludedLines.add(j);
}

// Step 2: parse all entries before the cut, build uuid index
const preCutEntries = [];
const byUuid = {};
for (let i = 0; i < cutIndex; i++) {
  try {
    const entry = JSON.parse(rawLines[i]);
    preCutEntries.push({ line: rawLines[i], entry, index: i });
    if (entry.uuid) {
      byUuid[entry.uuid] = entry;
    }
  } catch {
    // Keep unparseable lines (they'll be included as non-message entries)
    preCutEntries.push({ line: rawLines[i], entry: null, index: i });
  }
}

// Step 3: find the tip of the active branch. The snapshot command's parentUuid
// points to the message the user was looking at when they ran the snapshot —
// this is authoritative even after rewinds.
let tipUuid = null;
if (cutIndex < rawLines.length) {
  try {
    const snapshotCmd = JSON.parse(rawLines[cutIndex]);
    tipUuid = snapshotCmd.parentUuid || null;
  } catch {
    // not valid JSON — leave tipUuid null
  }
}
// If the live tip is itself inside a prior snapshot's Q&A subgraph (e.g.
// the user ran /create-snapshot:snapshot a second time WITHOUT typing
// anything between the two — there's no "real work" gap), walk back past
// the excluded range to find the closest non-excluded ancestor. Otherwise
// activeBranchUuids would be empty and we'd produce an empty snapshot.
function nearestNonExcludedAncestor(startUuid) {
  let cur = startUuid;
  while (cur) {
    const e = byUuid[cur];
    if (!e) return cur; // unknown uuid — best effort, keep
    // Find the line index of this entry to check exclusion.
    // (Line index isn't stored on the entry; recompute via preCutEntries.)
    const found = preCutEntries.find((p) => p.entry?.uuid === cur);
    if (!found || !priorQAExcludedLines.has(found.index)) return cur;
    cur = e.parentUuid || null;
  }
  return null;
}
if (tipUuid) tipUuid = nearestNonExcludedAncestor(tipUuid);

// Fallback: if no snapshot command found, use the last entry with a uuid
if (!tipUuid) {
  for (let i = preCutEntries.length - 1; i >= 0; i--) {
    if (preCutEntries[i].entry?.uuid && !priorQAExcludedLines.has(preCutEntries[i].index)) {
      tipUuid = preCutEntries[i].entry.uuid;
      break;
    }
  }
}

// Collect all uuids on the active branch
const activeBranchUuids = new Set();
let current = tipUuid;
while (current) {
  activeBranchUuids.add(current);
  current = byUuid[current]?.parentUuid || null;
}

// Step 4: filter — keep entries on the active branch.
//
// Claude Code writes several bookkeeping entry types alongside the message
// tree that don't carry a branch uuid. Their content references whatever
// branch was active when they were written, so if the user has rewound,
// these will leak rewound-branch state (file backups, prior prompt text,
// stale titles, queued prompts, PR links, etc.) into the snapshot — a leak
// snapshot.patch doesn't show. Drop the ones we can't attribute to the
// active branch.
//
// `file-history-snapshot` is special-cased: it carries a `messageId`
// pointing at the message whose pre-edit state it tracks, so we can
// keep only those whose messageId is on the active branch. That
// preserves /rewind functionality after a snapshot is restored (rewind
// needs the file-backup metadata) while still dropping records from
// rewound branches.
const BLANKET_DROP_TYPES = new Set([
  'agent-name',
  'ai-title',
  'custom-title',
  'last-prompt',
  'permission-mode',
  'pr-link',
  'queue-operation',
]);

function prunedClaudeLines() {
  const kept = [];
  for (const { line, entry, index } of preCutEntries) {
    if (priorQAExcludedLines.has(index)) continue;
    if (!entry) {
      // Unparseable line — keep as-is so we don't lose data we can't classify.
      kept.push(line);
      continue;
    }
    if (entry.uuid) {
      if (activeBranchUuids.has(entry.uuid)) kept.push(line);
      continue;
    }
    // No uuid: bookkeeping entry.
    if (entry.type === 'file-history-snapshot') {
      // Keep only if the message it tracks is on the active branch.
      if (entry.messageId && activeBranchUuids.has(entry.messageId)) {
        kept.push(line);
      }
      continue;
    }
    if (!BLANKET_DROP_TYPES.has(entry.type)) kept.push(line);
  }
  return kept;
}

// Rewind branches and prior-Q&A exclusion are Claude-transcript concerns; a linear
// harness transcript just truncates at its boundary.
let startLine;
if (!IS_CLAUDE && startMarkerPath && fs.existsSync(startMarkerPath)) {
  try {
    const marker = JSON.parse(fs.readFileSync(startMarkerPath, 'utf8'));
    if (marker.transcript_path === harnessSession.rawPath) startLine = marker.line_count;
  } catch {
    startLine = undefined;
  }
}
if (!IS_CLAUDE && startLine === undefined) {
  console.error(
    'WARNING: no snapshot start marker for this session — the snapshot Q&A may be captured as conversation. Run capture-snapshot.mjs --mark-start before the annotation questions.'
  );
}

const outputLines = IS_CLAUDE
  ? prunedClaudeLines()
  : linearSnapshotLines(harnessSession, startLine);

if (outputLines.length === 0) {
  console.error(
    `WARNING: found no conversation to seed in ${transcript_path}, so this snapshot has no prior turns. The task will run cold from its prompt alone — fine if that is what you want, but if you meant to capture a conversation, check that the exchange you wanted came BEFORE this snapshot.`
  );
}

// Zero bytes, not a lone newline, when there is nothing to seed: downstream decides
// single- vs multi-turn on the file's SIZE, so a 1-byte file would try to resume nothing.
fs.writeFileSync(
  path.join(snapshotDir, 'session.jsonl'),
  outputLines.length > 0 ? outputLines.join('\n') + '\n' : ''
);

// --- Write boundary record so the NEXT capture-snapshot in this session
//     can identify and exclude this snapshot's Q&A subgraph ---
//
// The record pairs the current invocation's command-line uuid with the
// uuid of the last entry in the JSONL at this moment (which is whichever
// assistant turn invoked us as a tool). A subsequent capture run reads
// this file, finds these two uuids in its raw lines, and excludes the
// range — a small leak still exists for entries appended AFTER capture
// returns (the assistant's "Snapshot saved to: ..." reply), but the
// substantive annotation Q&A is fully bounded.
if (dataDir && session_id && cutIndex < rawLines.length) {
  let snapshotCommandUuid = null;
  try {
    snapshotCommandUuid = JSON.parse(rawLines[cutIndex]).uuid || null;
  } catch {
    /* leave null — we'll skip writing */
  }
  // Re-read transcript so we pick up any lines Claude Code has appended
  // since we read it above (the assistant's tool-use entry, etc.).
  let lastEntryUuid = null;
  try {
    const liveLines = fs.readFileSync(transcript_path, 'utf8').trimEnd().split('\n');
    for (let i = liveLines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(liveLines[i]);
        if (e.uuid) {
          lastEntryUuid = e.uuid;
          break;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* transcript unreadable now — skip writing */
  }
  if (snapshotCommandUuid && lastEntryUuid) {
    const boundariesPath = path.join(dataDir, 'snapshot-boundaries.jsonl');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(
        boundariesPath,
        JSON.stringify({
          sessionUuid: session_id,
          snapshotCommandUuid,
          lastEntryUuid,
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
    } catch {
      // Best-effort: a missing boundary just means the next run falls back
      // to the conservative "exclude through next snapshot" heuristic.
    }
  }
}

// Copy subagents and tool-results if they exist
const sessionSiblingDir = transcript_path.replace(/\.jsonl$/, '');
if (fs.existsSync(sessionSiblingDir) && fs.statSync(sessionSiblingDir).isDirectory()) {
  fs.cpSync(sessionSiblingDir, path.join(snapshotDir, 'session'), { recursive: true });
  // Claude Code creates subagent files with write-only permissions (--w-------).
  // Fix them so downstream tools (cpSync in snapshot-to-task, Harbor's dirhash) can read them.
  execSync(`chmod -R +r "${path.join(snapshotDir, 'session')}"`, { stdio: 'pipe' });
}

// --- Capture git state as a patch ---

// Returns raw stdout bytes — callers that want a single-line value must
// .trim() themselves. Don't trim here: some callers (git diff) produce
// patches where a trailing " \n" blank-context line is load-bearing, and
// stripping it corrupts the patch.
function git(cmd, opts) {
  try {
    return execSync(`git ${cmd}`, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      cwd: gitRepo,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
  } catch {
    return null;
  }
}

const commit = git('rev-parse HEAD')?.trim() ?? null;
const branch = git('rev-parse --abbrev-ref HEAD')?.trim() ?? null;
const remoteUrl = git('remote get-url origin')?.trim() ?? null;

// Generate a unified patch representing the workspace state AT THE END OF
// THE PRIOR TURN — i.e., everything done up to but not including the turn
// being snapshotted. This is the state the trial agent should inherit so
// it gets a fresh attempt at the prompt that triggered the snapshot.
//
// The UserPromptSubmit hook checkpoints the working tree to
// `refs/raccoon/turn-checkpoint` at every turn boundary (skipping snapshot
// invocations themselves), so the latest checkpoint is exactly the state
// at the start of the snapshotted turn. We diff HEAD against that
// checkpoint to produce the patch.
//
// Falls back to the pre-checkpoint behavior (full working-tree diff) when
// no checkpoint exists — e.g., the worker took a snapshot before any
// non-snapshot user message was sent, or the hook never fired (legacy
// session, plugin re-installed mid-session, etc.).
if (gitRepo) {
  try {
    const tmpIndex = path.join(snapshotDir, '.tmp-git-index');
    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    // Prefer the FROZEN ref — this is set by checkpoint-workspace at the
    // moment the user invokes /create-snapshot:*, before any Q&A turns
    // have a chance to advance the live checkpoint past the state we
    // want to capture. Fall back to the live checkpoint (then to
    // working-tree diff) for backward-compat or if the freeze step failed.
    let baseline = null;
    try {
      baseline = git('rev-parse refs/raccoon/turn-checkpoint-frozen')?.trim() ?? null;
    } catch {
      baseline = null;
    }
    if (!baseline) {
      try {
        baseline = git('rev-parse refs/raccoon/turn-checkpoint')?.trim() ?? null;
      } catch {
        baseline = null;
      }
    }

    // --binary --full-index, on both branches: a plain `git diff` records a
    // binary difference as an opaque `Binary files a/x and /dev/null differ`
    // stub, and `git apply` refuses it ("without full index line"), so
    // build-workspace.sh can't rebuild the task at all. Nobody has to edit a
    // binary to hit this — a tracked .DS_Store the toolkit zip strips from the
    // shipped checkout reads as a binary deletion in every session.
    //
    // maxBuffer: inlined binaries make patches far bigger than text diffs, and
    // exceeding the default cap would throw away the whole patch silently.
    const diffOpts = { env: indexEnv, maxBuffer: 512 * 1024 * 1024 };
    let patch;
    if (baseline) {
      // Diff HEAD against the prior-turn checkpoint. Untracked files in
      // the checkpoint have been committed to the checkpoint tree, so
      // they're included automatically.
      patch = git(`diff --binary --full-index HEAD ${baseline}`, diffOpts);
    } else {
      // No checkpoint — fall back to live working-tree diff (pre-fix
      // behavior). Captures everything different from HEAD, including
      // any agent edits during the current turn.
      git('read-tree HEAD', { env: indexEnv });
      git('add -A', { env: indexEnv });
      patch = git('diff --cached --binary --full-index HEAD', diffOpts);
    }

    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      /* ignore */
    }

    if (patch) {
      fs.writeFileSync(
        path.join(snapshotDir, 'snapshot.patch'),
        patch.endsWith('\n') ? patch : patch + '\n'
      );
    }
  } catch {
    // Read-only repo or other git error — skip patch generation
  }
}

// --- Copy annotation ---

const annotation = JSON.parse(fs.readFileSync(annotationPath, 'utf8'));
fs.writeFileSync(
  path.join(snapshotDir, 'annotation.json'),
  JSON.stringify(annotation, null, 2) + '\n'
);

// Clean up temp file
try {
  fs.unlinkSync(annotationPath);
} catch {
  // Ignore cleanup failures
}

// --- Write metadata ---

const metadata = {
  slug: slug,
  session_uuid: session_id,
  // The harness the session was actually read as, so it can't disagree with what
  // was captured.
  harness: HARNESS,
  original_cwd: process.cwd(),
  commit: commit,
  branch: branch,
  remote_url: remoteUrl,
  timestamp: new Date().toISOString(),
  plugin_version: '0.2.0',
};

fs.writeFileSync(path.join(snapshotDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

// --- Generate restore.sh ---

const restoreScript = `#!/usr/bin/env bash
set -euo pipefail

# Restore a snapshot for resuming a Claude Code conversation.
#
# Usage: ./restore.sh [target-dir]
#   target-dir: directory to clone/checkout the repo into (default: ./repo)

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="\${1:-./repo}"

# Read metadata
COMMIT=$(jq -r '.commit' "$SCRIPT_DIR/metadata.json")
REMOTE=$(jq -r '.remote_url' "$SCRIPT_DIR/metadata.json")
SESSION_UUID=$(jq -r '.session_uuid' "$SCRIPT_DIR/metadata.json")

echo "Cloning $REMOTE at $COMMIT..."
git clone "$REMOTE" "$TARGET_DIR"
cd "$TARGET_DIR"
git checkout "$COMMIT"

# Apply snapshot patch if present
if [ -f "$SCRIPT_DIR/snapshot.patch" ]; then
  echo "Applying snapshot.patch..."
  git apply "$SCRIPT_DIR/snapshot.patch"
fi

# Install conversation so the authoring harness can resume it
${
  IS_CLAUDE
    ? `ENCODED_CWD=$(echo "$PWD" | sed 's|/|-|g; s|^-||')
DEST_DIR="$HOME/.claude/projects/-$ENCODED_CWD"
mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/session.jsonl" "$DEST_DIR/$SESSION_UUID.jsonl"
if [ -d "$SCRIPT_DIR/session" ]; then
  cp -r "$SCRIPT_DIR/session" "$DEST_DIR/$SESSION_UUID"
fi

echo ""
echo "Snapshot restored. To resume the conversation:"
echo "  cd $TARGET_DIR"
echo "  claude --resume $SESSION_UUID"`
    : `DEST_DIR="\${CODEX_HOME:-$HOME/.codex}/sessions/$(date -u +%Y/%m/%d)"
mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/session.jsonl" \\
  "$DEST_DIR/rollout-$(date -u +%Y-%m-%dT%H-%M-%S).000Z-$SESSION_UUID.jsonl"

echo ""
echo "Snapshot restored. To resume the conversation:"
echo "  cd $TARGET_DIR"
echo "  codex resume $SESSION_UUID"`
}
`;

fs.writeFileSync(path.join(snapshotDir, 'restore.sh'), restoreScript);
fs.chmodSync(path.join(snapshotDir, 'restore.sh'), 0o755);

try {
  execSync('bash -ic "_ev snapshot_created 2>/dev/null" 2>/dev/null', {
    stdio: 'ignore',
    timeout: 5000,
  });
} catch {
  // best-effort
}

// --- Done ---

const fullSnapshotDir = path.resolve(snapshotDir);
console.log(`Snapshot saved to: ${fullSnapshotDir}`);
console.log(`  session.jsonl     — conversation transcript`);
if (fs.existsSync(sessionSiblingDir) && fs.statSync(sessionSiblingDir).isDirectory()) {
  console.log(`  session/          — subagents + tool results`);
}
if (fs.existsSync(path.join(snapshotDir, 'snapshot.patch'))) {
  console.log(`  snapshot.patch    — working tree changes`);
}
console.log(`  annotation.json   — worker annotations`);
console.log(`  metadata.json     — session metadata`);
console.log(`  restore.sh        — restore script for resuming`);
