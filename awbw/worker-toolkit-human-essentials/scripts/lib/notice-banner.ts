/**
 * Wrap a notice in a banner loud enough to survive a scrollback.
 *
 * Yellow only when stderr is a terminal, so piped logs stay clean.
 */
export function banner(message: string, headline: string): string {
  const RULE = '#'.repeat(78);
  const pad = ' '.repeat(Math.max(0, Math.floor((78 - headline.length) / 2)));

  const body = [RULE, `${pad}${headline}`, RULE, '', message, RULE].join('\n');
  const color = process.stderr.isTTY ? ['\u001b[33m', '\u001b[39m'] : ['', ''];
  return `${color[0]}${body}${color[1]}`;
}
