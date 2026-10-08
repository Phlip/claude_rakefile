// Types for harness-session.mjs, so TS consumers (its test, snapshot-to-task) see a
// real shape instead of `any`.

export interface Turn {
  /** Line index in the native session file. */
  index: number;
  role: 'user' | 'assistant';
  text: string;
  /** A slash-command turn, not real conversation. */
  isCommand: boolean;
  /** This record concluded its turn — the truncation boundary. */
  endsTurn: boolean;
}

export interface Session {
  harness: string;
  rawPath: string;
  /** The harness own id for this conversation. */
  sessionId: string | null;
  lines: string[];
  turns: Turn[];
}

export function supportedHarnesses(): string[];
export function readSession(harness: string, recordedPath?: string): Session | null;
export function truncationIndex(turns: Turn[]): number;
export function turnsFromLines(harness: string, lines: string[]): Turn[];
export function linearSnapshotLines(session: Session, startLine?: number): string[];
export function stripAuthoringScaffolding(harness: string, lines: string[]): string[];
