/**
 * Shared helper for finding a Claude Code session id inside a JSONL or
 * stream-json `.txt` file. Both formats embed the id under one of two keys:
 *
 *   - `session_id` — stream-json output (`claude-code.txt` from `--print
 *     --output-format=stream-json`).
 *   - `sessionId` — Claude Code's internal session log (the resumable JSONL
 *     under `~/.claude/projects/<key>/<id>.jsonl`).
 *
 * Real files only use one key, but if a future format ever emits both we
 * shouldn't have two callers picking different winners — so this helper is
 * the single source of truth.
 */
import { readFileSync } from 'fs';

export function readSessionId(filePath: string): string | null {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    const camel = typeof obj.sessionId === 'string' ? obj.sessionId : null;
    const snake = typeof obj.session_id === 'string' ? obj.session_id : null;
    const id = camel ?? snake;
    if (id) return id;
  }
  return null;
}
