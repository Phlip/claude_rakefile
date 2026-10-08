/**
 * Recursive copy for scripts that must not call `cpSync`: it fails EACCES
 * against a macOS docker bind mount, where the toolkit's job dirs live.
 */

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'fs';
import { join } from 'path';

/** Copy one entry — symlink, directory or file — preserving its mode. */
export function copyPath(src: string, dest: string) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    rmSync(dest, { force: true });
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    copyTree(src, dest);
    return;
  }
  // Unlink first: copyFileSync onto an existing file keeps that file's mode.
  rmSync(dest, { force: true });
  copyFileSync(src, dest);
  chmodSync(dest, statSync(src).mode & 0o777);
}

/** Copy `src`'s contents into `dest`, creating `dest` if it doesn't exist. */
export function copyTree(src: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    copyPath(join(src, entry.name), join(dest, entry.name));
  }
}
