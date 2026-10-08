/**
 * Tests for tree-permissions.ts.
 *
 * The load-bearing case is the one from the field report: a directory that came
 * across without its search bit makes `tar` fail with `Cannot stat` on the files
 * *inside* it, so the repair has to fix directory modes, not just ownership.
 * These tests run unprivileged, so they exercise the mode axis for real and the
 * ownership axis only as far as an unprivileged process can (target resolution +
 * graceful EPERM), which is the same shape CI runs in. One case needs root and
 * skips otherwise; the rest hold under either uid, which is why the fixtures that
 * must look human-owned say so with `ownedByHuman` instead of relying on the
 * caller's uid.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  didRepair,
  manualRepairHint,
  normalizeTreePermissions,
  resolveWorkspaceOwner,
} from './tree-permissions';

function scratch(name: string): string {
  const dir = join(tmpdir(), `tree-perms-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const RUNNING_AS_ROOT = process.getuid?.() === 0;
const HUMAN_UID = RUNNING_AS_ROOT ? 1000 : (process.getuid?.() ?? 0);
const HUMAN_GID = RUNNING_AS_ROOT ? 1000 : (process.getgid?.() ?? 0);

/** Give a fixture a non-root owner, so the repair sees a tree it can hand back. */
function ownedByHuman(path: string): string {
  chownSync(path, HUMAN_UID, HUMAN_GID);
  return path;
}

test('restores the search bit on a directory that lost it', () => {
  const root = scratch('searchbit');
  const models = join(root, 'agent-output', 'app', 'models');
  mkdirSync(models, { recursive: true });
  writeFileSync(join(models, 'bill.rb'), 'class Bill; end\n');
  // r-- : readdir works, so tar can NAME the file, but stat is refused.
  chmodSync(models, 0o400);

  const report = normalizeTreePermissions(root);

  assert.equal(statSync(models).mode & 0o700, 0o700, 'owner rwx restored on the directory');
  assert.ok(report.modeFixed.some((p) => p === models));
  assert.ok(didRepair(report));
  rmSync(root, { recursive: true, force: true });
});

test('recurses into a directory it had to widen first', () => {
  const root = scratch('recurse');
  const inner = join(root, 'locked', 'deeper');
  mkdirSync(inner, { recursive: true });
  const leaf = join(inner, 'leaf.rb');
  writeFileSync(leaf, 'x\n');
  chmodSync(leaf, 0o000);
  chmodSync(inner, 0o400);
  chmodSync(join(root, 'locked'), 0o400);

  const report = normalizeTreePermissions(root);

  // Only reachable if the walk widened each parent before descending.
  assert.equal(statSync(leaf).mode & 0o600, 0o600, 'leaf became owner-readable');
  assert.ok(report.modeFixed.includes(leaf));
  rmSync(root, { recursive: true, force: true });
});

test('leaves already-correct trees untouched', () => {
  const root = scratch('noop');
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'f.txt'), 'hi\n');

  const report = normalizeTreePermissions(root);

  assert.deepEqual(report.modeFixed, [], 'no mode changes');
  assert.deepEqual(report.ownerFixed, [], 'no owner changes (already ours)');
  assert.deepEqual(report.failures, []);
  assert.equal(didRepair(report), false);
  rmSync(root, { recursive: true, force: true });
});

test('does not widen group/other beyond what was already there', () => {
  const root = ownedByHuman(scratch('narrow'));
  const f = join(root, 'secret.txt');
  writeFileSync(f, 'x\n');
  ownedByHuman(f);
  chmodSync(f, 0o000);

  normalizeTreePermissions(root, { ownerRef: root });

  const mode = statSync(f).mode & 0o777;
  assert.equal(mode, 0o600, 'owner rw only — group/other stay closed');
  rmSync(root, { recursive: true, force: true });
});

test('ignores symlinks rather than following them out of the tree', () => {
  const root = scratch('symlink');
  const outside = scratch('symlink-outside');
  const victim = join(outside, 'victim.txt');
  writeFileSync(victim, 'x\n');
  chmodSync(victim, 0o000);
  symlinkSync(outside, join(root, 'link'));

  const report = normalizeTreePermissions(root);

  assert.equal(statSync(victim).mode & 0o777, 0o000, 'target outside the tree untouched');
  assert.deepEqual(report.failures, []);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('never throws on a missing root, and reports it', () => {
  const report = normalizeTreePermissions(join(tmpdir(), 'definitely-not-here-xyz'));
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].reason, 'ENOENT');
});

test('resolveWorkspaceOwner reads the reference path, not the caller', () => {
  const root = scratch('owner');
  const owner = resolveWorkspaceOwner(root);
  assert.ok(owner, 'resolved');
  const st = statSync(root);
  assert.equal(owner.uid, st.uid);
  assert.equal(owner.gid, st.gid);
  assert.equal(resolveWorkspaceOwner(join(tmpdir(), 'nope-xyz')), null);
  rmSync(root, { recursive: true, force: true });
});

test('never chowns TO root, even when the owner ref is root-owned', () => {
  // The regression this guards: workspace root owned by root (unzipped with
  // sudo) while the task files are correctly owned by the human. Chowning to the
  // ref's owner would inflict the very lockout this module prevents. `/` is
  // root-owned on every platform we run on, so it's a stable stand-in.
  const root = scratch('root-ref');
  const f = join(root, 'mine.txt');
  writeFileSync(f, 'x\n');
  const beforeUid = statSync(f).uid;

  const report = normalizeTreePermissions(root, { ownerRef: '/' });

  assert.equal(report.target?.uid, 0, 'resolved a root target');
  assert.deepEqual(report.ownerFixed, [], 'declined to chown anything to root');
  assert.deepEqual(report.failures, [], 'and did not fail trying');
  assert.equal(statSync(f).uid, beforeUid, 'owner untouched');
  rmSync(root, { recursive: true, force: true });
});

test('still normalizes modes when the chown target is root', () => {
  const root = scratch('root-ref-modes');
  const sub = join(root, 'sub');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'f.txt'), 'x\n');
  chmodSync(sub, 0o400);

  const report = normalizeTreePermissions(root, { ownerRef: '/' });

  assert.equal(statSync(sub).mode & 0o700, 0o700, 'mode axis still applied');
  assert.ok(report.modeFixed.includes(sub));
  rmSync(root, { recursive: true, force: true });
});

test('keeps modes narrow for files that have a real owner, even under a root ref', () => {
  // The complement of the case below: we declined to chown, but these entries are
  // already the human's, so owner bits reach them and nothing should be widened.
  const root = ownedByHuman(scratch('root-ref-narrow'));
  const f = join(root, 'mine.txt');
  writeFileSync(f, 'x\n');
  ownedByHuman(f);
  chmodSync(f, 0o600);

  normalizeTreePermissions(root, { ownerRef: '/' });

  assert.equal(statSync(f).mode & 0o077, 0, 'group/other untouched');
  rmSync(root, { recursive: true, force: true });
});

test(
  'grants read+search to group and other on files stranded root-owned',
  { skip: process.getuid?.() !== 0 ? 'needs root to create root-owned files' : false },
  () => {
    // The worker authoring container: root process, root-owned workspace. The chown
    // is declined, so owner bits land on root and the human — a different uid in
    // Explore and on a WSL host — is still locked out of a --w------- capture.
    const root = scratch('stranded');
    const sub = join(root, 'agent-output');
    mkdirSync(sub, { recursive: true });
    const f = join(sub, 'answer.md');
    writeFileSync(f, 'x\n');
    chmodSync(f, 0o200);
    chmodSync(sub, 0o300);

    normalizeTreePermissions(root, { ownerRef: '/' });

    assert.equal(
      statSync(f).mode & 0o777,
      0o644,
      'file readable by everyone, writable by none but root'
    );
    assert.equal(statSync(sub).mode & 0o777, 0o755, 'directory searchable');
  }
);

test('walks a tree as deep as the filesystem allows', () => {
  const root = scratch('deep');
  // PATH_MAX caps how deep a tree can physically get (~300 levels at these name
  // lengths — building deeper fails with ENAMETOOLONG), which is well inside any
  // call-stack limit. So this isn't a stack test; it just pins that a deep,
  // narrow tree walks cleanly end to end.
  let path = root;
  for (let i = 0; i < 250; i++) {
    path = join(path, `d${i}`);
  }
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'leaf.txt'), 'x\n');
  chmodSync(join(path, 'leaf.txt'), 0o000);

  const report = normalizeTreePermissions(root);

  assert.deepEqual(report.failures, [], 'walked the whole depth cleanly');
  assert.equal(statSync(join(path, 'leaf.txt')).mode & 0o600, 0o600, 'reached the deepest leaf');
  rmSync(root, { recursive: true, force: true });
});

test('a failure in one subtree does not abandon the rest', () => {
  const root = scratch('partial');
  const good = join(root, 'good');
  mkdirSync(good, { recursive: true });
  const goodFile = join(good, 'f.txt');
  writeFileSync(goodFile, 'x\n');
  chmodSync(goodFile, 0o000);
  // A dangling symlink and a vanished path both produce per-entry trouble.
  symlinkSync(join(root, 'nowhere'), join(root, 'dangling'));

  const report = normalizeTreePermissions(root);

  assert.equal(statSync(goodFile).mode & 0o600, 0o600, 'the healthy subtree was still repaired');
  assert.ok(report.modeFixed.includes(goodFile));
  rmSync(root, { recursive: true, force: true });
});

test('reports rather than throws when the root is a file, not a directory', () => {
  const root = scratch('file-root');
  const f = join(root, 'lonely.txt');
  writeFileSync(f, 'x\n');
  chmodSync(f, 0o000);

  const report = normalizeTreePermissions(f);

  assert.equal(statSync(f).mode & 0o600, 0o600);
  assert.deepEqual(report.failures, []);
  rmSync(root, { recursive: true, force: true });
});

test('RACCOON_SKIP_PERMISSION_REPAIR=1 makes it a total no-op', () => {
  const root = scratch('killswitch');
  const sub = join(root, 'sub');
  mkdirSync(sub, { recursive: true });
  const f = join(sub, 'f.txt');
  writeFileSync(f, 'x\n');
  chmodSync(f, 0o000);
  chmodSync(sub, 0o400);

  const prev = process.env.RACCOON_SKIP_PERMISSION_REPAIR;
  process.env.RACCOON_SKIP_PERMISSION_REPAIR = '1';
  try {
    const report = normalizeTreePermissions(root);
    assert.equal(report.skipped, true);
    assert.deepEqual(report.modeFixed, []);
    assert.deepEqual(report.ownerFixed, []);
    assert.deepEqual(report.failures, []);
    assert.equal(didRepair(report), false);
    assert.equal(statSync(sub).mode & 0o777, 0o400, 'directory left exactly as it was');
  } finally {
    if (prev === undefined) delete process.env.RACCOON_SKIP_PERMISSION_REPAIR;
    else process.env.RACCOON_SKIP_PERMISSION_REPAIR = prev;
  }
  chmodSync(sub, 0o700);
  rmSync(root, { recursive: true, force: true });
});

test('manual hint repairs both axes, ownership first', () => {
  const hint = manualRepairHint('harbor-tasks/my-slug');
  assert.match(hint, /chown -R/);
  assert.match(hint, /chmod -R u\+rwX/);
  assert.ok(hint.indexOf('chown') < hint.indexOf('chmod'), 'chown before chmod');
});
