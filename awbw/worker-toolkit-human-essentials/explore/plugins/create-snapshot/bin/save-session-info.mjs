#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// Read stdin as a stream — hooks may not have /dev/stdin available
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const { session_id, transcript_path } = JSON.parse(input);

  const dataDir =
    process.env.RACCOON_SNAPSHOT_DATA ||
    process.env.CLAUDE_PLUGIN_DATA ||
    (process.env.CLAUDE_PLUGIN_ROOT && path.join(process.env.CLAUDE_PLUGIN_ROOT, '.data')) ||
    path.join(process.env.HOME || '/root', '.raccoon', 'snapshot-data');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'current-session.json'),
    JSON.stringify({ session_id, transcript_path }, null, 2) + '\n'
  );
});
