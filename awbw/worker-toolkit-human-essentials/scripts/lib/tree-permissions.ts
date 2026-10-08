/**
 * tree-permissions.ts — make a copied tree readable by whoever owns the workspace.
 *
 * Files captured from a task run can arrive owned by another user, or with a
 * directory missing the permission needed to walk into it. Packaging then fails
 * with `Cannot stat: Permission denied`. This repairs both.
 *
 * Grants owner rwX only, never group or other. Never throws, and never hands
 * files to root. Set `RACCOON_SKIP_PERMISSION_REPAIR=1` to turn it off.
 */
import { chmodSync, chownSync, lstatSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface NormalizeReport {
  /** Paths whose owner was changed. */
  ownerFixed: string[];
  /** Paths whose mode gained owner rwX. */
  modeFixed: string[];
  /** Paths we wanted to change but could not, with the errno. */
  failures: { path: string; reason: string }[];
  /** Resolved target owner, or null if it couldn't be determined. */
  target: { uid: number; gid: number } | null;
  /** Set when disabled via RACCOON_SKIP_PERMISSION_REPAIR. */
  skipped?: boolean;
}

/** Owner a workspace tree should have: whoever owns `ownerRef`. */
export function resolveWorkspaceOwner(ownerRef: string): { uid: number; gid: number } | null {
  try {
    const st = statSync(ownerRef);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

/**
 * Owner-rwX mode, preserving every other bit. Dirs also need the search bit.
 *
 * `stranded` means the file stays root-owned because we have no non-root owner to
 * give it to. Owner bits then help nobody — whoever has to read it is a different
 * user — so read and search are granted more widely. Never write, never +x on files.
 */
function withOwnerAccess(mode: number, isDir: boolean, stranded: boolean): number {
  const owner = isDir ? 0o700 : 0o600;
  return mode | owner | (stranded ? (isDir ? 0o055 : 0o044) : 0);
}

/**
 * Give every entry under `root` to the workspace owner and make sure that owner
 * can read and traverse it. Symlinks are skipped. Repairs what it can and
 * reports what it couldn't; it never throws and never blocks its caller.
 */
export function normalizeTreePermissions(
  root: string,
  options: { ownerRef?: string } = {}
): NormalizeReport {
  if (process.env.RACCOON_SKIP_PERMISSION_REPAIR === '1') {
    return { ownerFixed: [], modeFixed: [], failures: [], target: null, skipped: true };
  }

  const target = resolveWorkspaceOwner(options.ownerRef ?? process.cwd());
  const report: NormalizeReport = { ownerFixed: [], modeFixed: [], failures: [], target };

  // Never hand files to root — that would lock the owner out rather than help.
  const chownTarget = target && target.uid !== 0 ? target : null;

  try {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const path = stack.pop() as string;

      let st;
      try {
        st = lstatSync(path);
      } catch (err) {
        report.failures.push({ path, reason: (err as NodeJS.ErrnoException).code ?? 'ELSTAT' });
        continue;
      }
      if (st.isSymbolicLink()) continue;

      const isDir = st.isDirectory();

      // Mode first: a directory we can't search is one we can't descend into.
      const wanted = withOwnerAccess(st.mode, isDir, chownTarget === null && st.uid === 0);
      if (wanted !== st.mode) {
        try {
          chmodSync(path, wanted);
          report.modeFixed.push(path);
        } catch (err) {
          report.failures.push({ path, reason: (err as NodeJS.ErrnoException).code ?? 'ECHMOD' });
        }
      }

      if (chownTarget && (st.uid !== chownTarget.uid || st.gid !== chownTarget.gid)) {
        try {
          chownSync(path, chownTarget.uid, chownTarget.gid);
          report.ownerFixed.push(path);
        } catch (err) {
          report.failures.push({ path, reason: (err as NodeJS.ErrnoException).code ?? 'ECHOWN' });
        }
      }

      if (!isDir) continue;
      try {
        for (const entry of readdirSync(path)) stack.push(join(path, entry));
      } catch (err) {
        report.failures.push({ path, reason: (err as NodeJS.ErrnoException).code ?? 'EREADDIR' });
      }
    }
  } catch (err) {
    report.failures.push({ path: root, reason: (err as NodeJS.ErrnoException).code ?? 'EWALK' });
  }

  return report;
}

/** True when something was actually repaired. */
export function didRepair(report: NormalizeReport): boolean {
  return report.ownerFixed.length > 0 || report.modeFixed.length > 0;
}

/** The command to run on your host if we couldn't fix it ourselves. */
export function manualRepairHint(path: string): string {
  return `sudo chown -R "$(id -un):$(id -gn)" ${path} && chmod -R u+rwX ${path}`;
}
