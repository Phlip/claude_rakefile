// Locate and read a harness's native conversation, so capture-snapshot can work
// against any harness. Everything else in capture (snapshot.patch, restore.sh,
// annotation, metadata) is harness-agnostic.
//
// The returned session stays in the harness's OWN native format: the seeding design
// hands a native blob back to the same harness, and codex_agent reads the same staged
// /tmp/snapshot-session/session.jsonl path that snapshot_agent does.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Turn
 * @property {number} index    line index in the native session file
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {boolean} isCommand  a slash-command turn, not real conversation
 * @property {boolean} endsTurn   this record concluded its turn
 */

/**
 * @typedef {object} Session
 * @property {string} harness
 * @property {string} rawPath
 * @property {string|null} sessionId  the harness's own id for this conversation
 * @property {string[]} lines
 * @property {Turn[]} turns
 */

// Newest matching file beneath `root`, or null. Ties on mtime break on path so the
// answer is stable — two sessions written in the same millisecond are common.
function newestUnder(root, matches) {
  if (!fs.existsSync(root)) return null;
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (matches(entry.name)) found.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
    }
  };
  walk(root);
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.full.localeCompare(a.full));
  return found[0].full;
}

// User-role records codex writes that the human did not type: its own environment
// preamble, a `$name` skill invocation, and the SKILL.md body injected in response.
// Matched only at the START of the text, so a turn that merely quotes one is still real
// conversation.
function isCodexCommandText(text) {
  const trimmed = (text || '').trimStart();
  if (trimmed.startsWith('<skill>') || trimmed.startsWith('<environment_context>')) return true;
  return /^\$[\w:.-]+\s*$/.test(trimmed);
}

const HARNESSES = {
  'claude-code': {
    /** Claude Code records one JSONL per session under ~/.claude/projects/<encoded-cwd>/. */
    findSession() {
      return newestUnder(path.join(os.homedir(), '.claude', 'projects'), (n) =>
        n.endsWith('.jsonl')
      );
    },

    /** Claude names the transcript for its session id. */
    sessionId(rawPath) {
      return path.basename(rawPath, '.jsonl');
    },
    /**
     * One turn per conversational record. `endsTurn` marks an assistant record that
     * concluded its turn — the truncation boundary. Bookkeeping records (attachments,
     * file-history, permission-mode) carry no role and are skipped.
     */
    /** @param {string[]} lines @returns {Turn[]} */
    readTurns(lines) {
      /** @type {Turn[]} */
      const turns = [];
      for (const [index, line] of lines.entries()) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const role =
          entry.type === 'user' ? 'user' : entry.type === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const content = entry.message?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((b) => b && b.type === 'text')
                  .map((b) => b.text ?? '')
                  .join('')
              : '';
        turns.push({
          index,
          role,
          text,
          isCommand:
            role === 'user' &&
            typeof content === 'string' &&
            /<command-name>|<command-message>|<local-command-caveat>/.test(content),
          endsTurn: role === 'assistant' && entry.message?.stop_reason === 'end_turn',
        });
      }
      return turns;
    },
  },

  codex: {
    /** codex writes rollout JSONL under $CODEX_HOME/sessions/<date>/. */
    findSession() {
      const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      return newestUnder(
        path.join(home, 'sessions'),
        (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')
      );
    },

    /** `codex resume <id>` resolves the id recorded in session_meta, not the filename. */
    sessionId(rawPath, lines) {
      for (const line of lines) {
        try {
          const rec = JSON.parse(line);
          if (rec.type === 'session_meta' && rec.payload?.id) return rec.payload.id;
        } catch {
          continue;
        }
      }
      return null;
    },
    /**
     * codex rollouts carry `response_item` records whose payload is a message with a
     * role. An assistant message with no following tool activity ends the turn; codex
     * records no stop_reason, so a turn ends where the next user message begins —
     * resolved after the fact below.
     */
    /** @param {string[]} lines @returns {Turn[]} */
    readTurns(lines) {
      /** @type {Turn[]} */
      const turns = [];
      for (const [index, line] of lines.entries()) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type !== 'response_item') continue;
        const payload = record.payload ?? {};
        if (payload.type !== 'message') continue;
        const role =
          payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const text = Array.isArray(payload.content)
          ? payload.content.map((b) => b?.text ?? '').join('')
          : typeof payload.content === 'string'
            ? payload.content
            : '';
        turns.push({
          index,
          role,
          text,
          isCommand: role === 'user' && isCodexCommandText(text),
          endsTurn: false,
        });
      }
      // An assistant turn ends where the next user turn starts, or at the end.
      for (let i = 0; i < turns.length; i += 1) {
        if (turns[i].role !== 'assistant') continue;
        const next = turns[i + 1];
        turns[i].endsTurn = !next || next.role === 'user';
      }
      return turns;
    },
  },
};

/** @returns {string[]} */
export function supportedHarnesses() {
  return Object.keys(HARNESSES);
}

/**
 * Read the current session for `harness`. Returns null when nothing is found, so the
 * caller can report which harness had no conversation to capture.
 */
/**
 * @param {string} harness
 * @param {string} [recordedPath] transcript recorded by the SessionStart hook; preferred
 *   over the newest-file scan, which can pick a different session in a busy container.
 * @returns {Session | null}
 */
export function readSession(harness, recordedPath) {
  const reader = HARNESSES[harness];
  if (!reader) {
    throw new Error(
      `capture: no session reader for harness "${harness}" (have: ${supportedHarnesses().join(', ')})`
    );
  }
  const rawPath = recordedPath && fs.existsSync(recordedPath) ? recordedPath : reader.findSession();
  if (!rawPath) return null;
  const lines = fs.readFileSync(rawPath, 'utf8').trimEnd().split('\n');
  return {
    harness,
    rawPath,
    lines,
    turns: reader.readTurns(lines),
    sessionId: reader.sessionId(rawPath, lines),
  };
}

/**
 * Index of the last record to keep: the last turn-ending assistant record before the
 * final real user turn. Drops the prompt that elicited the failure and the failure
 * response, so the test agent inherits context but not the answer.
 *
 * Returns -1 when there is no such boundary (a one-shot conversation), which callers
 * treat as "seed nothing and run cold".
 */
/**
 * @param {Turn[]} turns
 * @returns {number}
 */
export function truncationIndex(turns) {
  let lastUser = -1;
  for (const turn of turns) {
    if (turn.role === 'user' && !turn.isCommand && turn.text.trim()) lastUser = turn.index;
  }
  if (lastUser < 0) return -1;
  let cut = -1;
  for (const turn of turns) {
    if (turn.index >= lastUser) break;
    if (turn.role === 'assistant' && turn.endsTurn) cut = turn.index;
  }
  return cut;
}

/**
 * Parse already-read lines with a harness's reader, for callers that have the text
 * rather than a path.
 *
 * @param {string} harness
 * @param {string[]} lines
 * @returns {Turn[]}
 */
export function turnsFromLines(harness, lines) {
  const reader = HARNESSES[harness];
  if (!reader) {
    throw new Error(
      `capture: no session reader for harness "${harness}" (have: ${supportedHarnesses().join(', ')})`
    );
  }
  return reader.readTurns(lines);
}

/**
 * Lines to stage as the captured `session.jsonl` for a linear-transcript harness:
 * everything up to the snapshot invocation, matching what Claude Code stages when it
 * cuts at its slash-command line. Dropping the failure-eliciting turn happens later,
 * in snapshot-to-task — capture keeps the full conversation.
 *
 * `startLine` is the rollout length recorded when the snapshot was invoked; without it
 * the whole session is kept, which would include the snapshot's own Q&A.
 *
 * @param {Session} session
 * @param {number} [startLine]
 * @returns {string[]}
 */
export function linearSnapshotLines(session, startLine) {
  if (typeof startLine === 'number' && startLine >= 0) {
    return session.lines.slice(0, startLine);
  }
  return session.lines;
}

/**
 * Drop records that describe the AUTHORING container rather than the conversation.
 *
 * codex records both its skill catalogue (a `developer` turn) and the machine it ran on (a
 * `user` turn of `<environment_context>`). Native resume replays records byte-identically,
 * so without this the test agent inherits a list of skills it does not have — one described
 * as "capture the current conversation and repo state as a snapshot" — and a working
 * directory that does not exist in the trial. codex re-injects both for the trial, and base
 * instructions travel in `session_meta`, so removing them loses nothing. Claude's fork
 * already re-records with the trial's own cwd; this brings codex to the same place.
 *
 * @param {string} harness
 * @param {string[]} lines
 * @returns {string[]}
 */
export function stripAuthoringScaffolding(harness, lines) {
  if (harness === 'claude-code') return lines;
  return lines.filter((raw) => {
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      return true;
    }
    const payload = rec?.payload;
    if (rec?.type !== 'response_item' || payload?.type !== 'message') return true;
    const text = (payload.content ?? [])
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('')
      .trim();
    // Match the machine-generated shape only — a turn that STARTS with the tag — so a
    // worker who quotes one of these strings mid-conversation keeps their turn.
    if (payload.role === 'developer') return !text.startsWith('<skills_instructions>');
    if (payload.role === 'user') return !text.startsWith('<environment_context>');
    return true;
  });
}
