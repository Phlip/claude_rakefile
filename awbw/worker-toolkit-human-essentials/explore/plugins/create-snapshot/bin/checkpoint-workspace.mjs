#!/usr/bin/env node

// Rewind-aware workspace checkpointing for the reduced-toolset Explore agent.
// One script, two hook events (branches on hook_event_name):
//
//  UserPromptSubmit -> CAPTURE
//    Snapshot the pre-turn working tree into refs/raccoon/turn-checkpoint (the
//    chain capture-snapshot uses for snapshot.patch) AND record, in
//    .git/raccoon-state.json, anchor_map[tip] = checkpoint-commit and
//    last_anchor = tip. `tip` is the conversation node the new prompt attaches
//    to (the END of the previous turn) — exactly the node a future /rewind to
//    THIS turn will branch from. Anchoring to the prior tip (not the
//    just-submitted, maybe-unflushed message) makes capture race-free.
//
//  PreToolUse (first tool call of a turn) -> RECONCILE
//    Claude Code's /rewind restores the conversation but NOT bash-made edits,
//    and fires no hook. By the first tool call the post-rewind branch message is
//    reliably persisted and the agent has not yet read/edited code. We parse the
//    transcript into a parentUuid DAG, pick the ACTIVE branch (leaf with the
//    newest tip), and walk it for the newest checkpoint anchor that is a genuine
//    rewind fork (the anchor still has an orphaned child branch — the discarded
//    turns). If found, restore the working tree to that checkpoint before the tool
//    runs. Idempotent per (anchor, branch): restores once per rewind.
//
// Every failure path is a safe no-op: the hook never aborts the session and
// never restores to an unverified tree.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHECKPOINT_REF = 'refs/raccoon/turn-checkpoint';
const FROZEN_REF = 'refs/raccoon/turn-checkpoint-frozen';
// Synthetic parent for every parentless transcript node, so that a rewind to the
// VERY FIRST turn (where the new prompt also has parentUuid=null) is detected by
// the same divergence machinery as any other turn.
const ROOT = '__ROOT__';
const RACCOON_AUTHOR = {
  GIT_AUTHOR_NAME: 'raccoon',
  GIT_AUTHOR_EMAIL: 'raccoon@local',
  GIT_COMMITTER_NAME: 'raccoon',
  GIT_COMMITTER_EMAIL: 'raccoon@local',
};

function makeGit(gitDir, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  return (cmd) =>
    execSync(`git ${cmd}`, {
      cwd: gitDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
}

function findGitDir(cwd) {
  let gitDir = cwd;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(gitDir, '.git'))) return gitDir;
    const parent = path.dirname(gitDir);
    if (parent === gitDir) return null;
    gitDir = parent;
  }
  return null;
}

// ---- transcript + state ----

function readEntries(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
    const out = [];
    for (const raw of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && typeof o.uuid === 'string') out.push(o);
    }
    return out;
  } catch {
    return [];
  }
}

function tsOf(e) {
  const t = e && e.timestamp ? Date.parse(e.timestamp) : 0;
  return Number.isFinite(t) ? t : 0;
}

function statePath(gitDir) {
  return path.join(gitDir, '.git', 'raccoon-state.json');
}
function loadState(gitDir) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(gitDir), 'utf8'));
    return { anchor_map: {}, last_anchor: null, reconciled_for: null, ...s };
  } catch {
    return { anchor_map: {}, last_anchor: null, reconciled_for: null };
  }
}
function saveState(gitDir, s) {
  try {
    // Atomic write: a tmp file + rename, so a hook killed mid-write can never
    // leave a half-written (corrupt) state.json behind.
    const target = statePath(gitDir);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, target);
  } catch {
    // best-effort
  }
}

// Loose checkpoint objects must survive: a restore resets the checkpoint chain
// ref backward, which can orphan later anchors' commits. Disabling auto-gc keeps
// every anchor commit fetchable for a future rewind. The task container is
// ephemeral, so accumulating loose objects is harmless.
function disableAutoGc(gitDir) {
  try {
    makeGit(gitDir)('config gc.auto 0');
  } catch {
    // best-effort
  }
}

// The conversation node the new prompt attaches to = end of the previous turn.
// Newest uuid-bearing entry, excluding the just-submitted prompt (which may or
// may not be flushed yet — excluding it makes this race-robust).
function conversationTip(entries, currentPrompt) {
  const cp = (currentPrompt || '').trim();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.uuid) continue;
    const role = e.type || (e.message && e.message.role);
    const content = e.message && e.message.content;
    if (role === 'user' && typeof content === 'string' && cp && content.trim() === cp) continue;
    return e.uuid;
  }
  return null;
}

// ---- capture (UserPromptSubmit) ----

function ensureExcludes(gitDir) {
  const localExcludePath = path.join(gitDir, '.git', 'info', 'exclude');
  const MARKER = '# raccoon-checkpoint excludes (auto-managed):';
  const excludes = [
    MARKER,
    '.pnpm-store/',
    '.yarn/cache/',
    '.yarn/install-state.gz',
    'vendor/bundle/',
    '.bundle/cache/',
    '.raccoon-setup-done', // run-app's per-repo first-use setup marker (polyglot toolkits)
  ];
  try {
    let existing = '';
    try {
      existing = fs.readFileSync(localExcludePath, 'utf8');
    } catch {
      existing = '';
    }
    if (!existing.includes(MARKER)) {
      fs.mkdirSync(path.dirname(localExcludePath), { recursive: true });
      fs.appendFileSync(localExcludePath, '\n' + excludes.join('\n') + '\n');
    }
  } catch {
    // best-effort
  }
}

function freezeForSnapshot(gitDir) {
  // Freeze the state at the START of the turn being snapshotted — i.e.,
  // whatever CHECKPOINT_REF already holds (or HEAD, if no turn has happened
  // yet this session). This must NOT be the live working tree: the live tree
  // includes the edits made during the turn that triggered /snapshot, and
  // capture-snapshot's `diff HEAD <frozen>` is supposed to exclude exactly
  // that turn so the trial agent gets a fresh attempt at the prompt (see the
  // comment above baseline selection in capture-snapshot.mjs). Freezing the
  // live tree instead bakes the agent's just-made edits into the snapshot.
  try {
    const git = makeGit(gitDir);
    let source = null;
    try {
      source = git(`rev-parse ${CHECKPOINT_REF}`);
    } catch {
      try {
        source = git('rev-parse HEAD');
      } catch {
        source = null;
      }
    }
    if (source) git(`update-ref ${FROZEN_REF} ${source}`);
  } catch {
    // best-effort — never break /snapshot
  }
}

// The snapshot invocation, in whichever form the harness uses: Claude Code takes
// `/create-snapshot:snapshot`, codex takes `$create-snapshot:snapshot`. Both send the raw
// text as `prompt` on the UserPromptSubmit hook (verified against codex 0.146.1), so the
// prefix is the only difference — and missing it means freezing never happens and the
// snapshotted turn's own edits get baked into the workspace.
const SNAPSHOT_INVOCATION_RE = /^[/$](?:create-snapshot|snapshot)(?![\w-])/;

function capture(gitDir, data) {
  const prompt = (data.prompt ?? '').trim();
  if (SNAPSHOT_INVOCATION_RE.test(prompt)) {
    freezeForSnapshot(gitDir);
    return;
  }
  let commit = null;
  try {
    const tmpIndex = path.join(gitDir, '.git', 'raccoon-checkpoint.index');
    const git = makeGit(gitDir, { ...RACCOON_AUTHOR, GIT_INDEX_FILE: tmpIndex });
    ensureExcludes(gitDir);
    disableAutoGc(gitDir);
    git('read-tree HEAD');
    git('add -A');
    const tree = git('write-tree');
    let parent;
    try {
      parent = git(`rev-parse ${CHECKPOINT_REF}`);
    } catch {
      parent = git('rev-parse HEAD');
    }
    commit = git(`commit-tree ${tree} -p ${parent} -m "raccoon-checkpoint: pre-turn"`);
    git(`update-ref ${CHECKPOINT_REF} ${commit}`);
    try {
      fs.unlinkSync(tmpIndex);
    } catch {
      // ignore
    }
  } catch {
    return; // never break the session
  }
  // Record the anchor mapping for rewind reconciliation. On the very first turn
  // there is no prior node, so we anchor to the synthetic ROOT — this is the
  // pre-turn-1 (initial) state, which a rewind to the first turn restores to.
  try {
    const tip = conversationTip(readEntries(data.transcript_path), data.prompt) || ROOT;
    if (commit) {
      const s = loadState(gitDir);
      s.anchor_map[tip] = commit;
      s.last_anchor = tip;
      saveState(gitDir, s);
    }
  } catch {
    // best-effort; capture still succeeded
  }
}

// ---- reconcile (PreToolUse) ----

function subtreeContains(start, target, children) {
  const stack = [start];
  const seen = new Set();
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === target) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of children.get(n) || []) stack.push(c);
  }
  return false;
}

function reachesLeaf(start, leafSet, children) {
  const stack = [start];
  const seen = new Set();
  while (stack.length > 0) {
    const n = stack.pop();
    if (leafSet.has(n)) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of children.get(n) || []) stack.push(c);
  }
  return false;
}

// node is a genuine rewind fork: >=2 children, one reaching the active leaf and
// at least one reaching a different (orphaned) leaf.
function isDivergence(node, activeLeaf, leaves, children) {
  const kids = children.get(node) || [];
  if (kids.length < 2) return false;
  const leafSet = new Set(leaves);
  const reachesActive = kids.some((k) => subtreeContains(k, activeLeaf, children));
  const reachesOther = kids.some(
    (k) => !subtreeContains(k, activeLeaf, children) && reachesLeaf(k, leafSet, children)
  );
  return reachesActive && reachesOther;
}

// Restore the working tree to a commit's tree, saving the current state to a
// safety ref first. Returns the safety ref name, or null on failure.
function restoreToCommit(gitDir, commit) {
  try {
    const restoreIndex = path.join(gitDir, '.git', 'raccoon-restore.index');
    const stashIndex = path.join(gitDir, '.git', 'raccoon-stash.index');
    const gitStash = makeGit(gitDir, { ...RACCOON_AUTHOR, GIT_INDEX_FILE: stashIndex });
    const gitRestore = makeGit(gitDir, { ...RACCOON_AUTHOR, GIT_INDEX_FILE: restoreIndex });
    const gitPlain = makeGit(gitDir, RACCOON_AUTHOR);

    ensureExcludes(gitDir);
    disableAutoGc(gitDir);
    gitStash('read-tree HEAD');
    gitStash('add -A');
    const curTree = gitStash('write-tree');
    let parent = null;
    try {
      parent = gitPlain('rev-parse HEAD');
    } catch {
      parent = null;
    }
    const curCommit = gitStash(
      `commit-tree ${curTree}${parent ? ` -p ${parent}` : ''} -m "raccoon: pre-rewind safety"`
    );
    const safetyRef = `refs/raccoon/pre-rewind/${Date.now()}`;
    gitPlain(`update-ref ${safetyRef} ${curCommit}`);

    // Files to delete = present in the current tree but absent from the target
    // checkpoint. Computed as a set difference of `ls-tree` listings rather than
    // `diff --diff-filter=A`, because git's rename/copy detection reclassifies an
    // added path as R/C, which a filter on "A" would miss — leaving the renamed-to
    // file stranded in the worktree after a restore.
    let added = [];
    try {
      const inCheckpoint = new Set(
        gitPlain(`ls-tree -r --name-only ${commit}`).split('\n').filter(Boolean)
      );
      const inCurrent = gitPlain(`ls-tree -r --name-only ${curCommit}`).split('\n').filter(Boolean);
      added = inCurrent.filter((f) => !inCheckpoint.has(f));
    } catch {
      added = [];
    }
    gitRestore(`read-tree ${commit}`);
    gitRestore('checkout-index -a -f');
    for (const f of added) {
      try {
        fs.rmSync(path.join(gitDir, f), { force: true });
      } catch {
        // ignore
      }
    }
    for (const idx of [restoreIndex, stashIndex]) {
      try {
        fs.unlinkSync(idx);
      } catch {
        // ignore
      }
    }
    return safetyRef;
  } catch {
    return null;
  }
}

function reconcile(gitDir, data) {
  let s;
  try {
    s = loadState(gitDir);
  } catch {
    return;
  }
  if (!s || !s.anchor_map || Object.keys(s.anchor_map).length === 0) return;

  const entries = readEntries(data.transcript_path);
  if (entries.length === 0) return;

  const byId = new Map();
  const children = new Map();
  const referenced = new Set();
  for (const e of entries) byId.set(e.uuid, e);
  for (const e of entries) {
    // Parentless or dangling-parent nodes hang off the synthetic ROOT.
    const p = e.parentUuid && byId.has(e.parentUuid) ? e.parentUuid : ROOT;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(e.uuid);
    referenced.add(p);
  }
  const leaves = [...byId.keys()].filter((u) => !referenced.has(u));
  if (leaves.length === 0) return;

  // active branch = leaf with the newest tip (the branch CC is appending to now)
  let activeLeaf = leaves[0];
  for (const u of leaves) if (tsOf(byId.get(u)) > tsOf(byId.get(activeLeaf))) activeLeaf = u;

  // Walk the active chain (through ROOT) for the newest anchor that is a GENUINE
  // rewind divergence: the anchor node has an orphaned child branch (the discarded
  // turns) alongside the active branch. We skip anchors that are NOT forks, so:
  //   - pure forward progress (single child) never triggers a restore;
  //   - redoing the LAST turn still triggers (the new turn builds on the same
  //     boundary as the prior turn, but the discarded turn is an orphan sibling);
  //   - a stray anchor recorded on the active branch itself (e.g. the post-rewind
  //     capture's tip) can't mask the real divergence further up the chain.
  // branchChild = the divergence node's child on the active path (the "branch id").
  let cur = activeLeaf;
  let prev = null;
  let branchChild = null;
  const seen = new Set();
  let activeAnchor = null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (
      Object.prototype.hasOwnProperty.call(s.anchor_map, cur) &&
      isDivergence(cur, activeLeaf, leaves, children)
    ) {
      activeAnchor = cur;
      branchChild = prev;
      break;
    }
    prev = cur;
    if (cur === ROOT) break;
    const e = byId.get(cur);
    cur = e && e.parentUuid && byId.has(e.parentUuid) ? e.parentUuid : ROOT;
  }
  if (!activeAnchor) return;

  // Idempotency keyed on (anchor, active branch) — NOT the active leaf. Every
  // tool call within a post-rewind turn advances the leaf, but the branch is
  // stable, so we restore exactly once per rewind. A fresh re-rewind to the same
  // turn forks a NEW child off the anchor, changing the key, so it restores again.
  const reconKey = `${activeAnchor}:${branchChild || ''}`;
  if (s.reconciled_for === reconKey) return; // this rewind already reconciled

  const safety = restoreToCommit(gitDir, s.anchor_map[activeAnchor]);
  try {
    makeGit(gitDir)(`update-ref ${CHECKPOINT_REF} ${s.anchor_map[activeAnchor]}`);
  } catch {
    // ignore
  }
  s.reconciled_for = reconKey;
  saveState(gitDir, s);
  // Record the restore to a side log ONLY — never stdout/stderr. Hook output on
  // PreToolUse is captured into the transcript (as an attachment entry) and the
  // transcript is the task data, so any emission here would contaminate it. The
  // log lives under .git/, which is never staged, snapshotted, or transcribed.
  try {
    const line =
      `${new Date().toISOString()} rewind reconciled: restored to anchor ${activeAnchor} ` +
      `(${s.anchor_map[activeAnchor]})${safety ? `; pre-rewind state saved to ${safety}` : ''}\n`;
    fs.appendFileSync(path.join(gitDir, '.git', 'raccoon-rewind.log'), line);
  } catch {
    // best-effort; the restore itself already succeeded
  }
}

function main(data) {
  const cwd = data.cwd || process.cwd();
  const gitDir = findGitDir(cwd);
  if (!gitDir) return;
  const event = data.hook_event_name || (data.tool_name ? 'PreToolUse' : 'UserPromptSubmit');
  // RECONCILE undoes a /rewind, which only Claude Code has. Other harnesses append
  // and never fork, so there is nothing to reconcile and the transcript it would walk
  // has no parentUuid DAG.
  const canRewind = (process.env.RACCOON_HARNESS || 'claude-code') === 'claude-code';
  if (event === 'PreToolUse') {
    if (canRewind) reconcile(gitDir, data);
  } else capture(gitDir, data);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  try {
    main(data);
  } catch {
    // A failure here must never break the user's session.
  }
  process.exit(0);
});
