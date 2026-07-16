import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Immutable facts about the exact bytes at an executable path — the SINGLE
 * producer of executable facts shared by the harness PATH resolver and the
 * setup-login evidence gate, so the two surfaces can never disagree about the
 * same file (the parity break that made setup-login reject a binary Doctor and
 * runs accepted).
 *
 * `nlink` is captured as a FACT, never an inline rejection here: link-count
 * policy is scoped to the file's owner/type by the CALLER. Daemon-owned MUTABLE
 * files (journal, token, locks) legitimately require `nlink === 1` at their own
 * call-sites — a second hard link there means the private file is not
 * exclusively owned. An external, read-only vendor binary is a different case:
 * the official installer hard-links the platform binary into its launcher
 * (`@anthropic-ai/claude-code` → `nlink === 2`), so for a binary Claudexor never
 * writes, `dev`/`inode`/`sha256` already prove which exact bytes will run and
 * the link count is irrelevant.
 */
export interface ExecutableInspection {
  /** realpath-resolved canonical path (all symlinks followed). */
  realpath: string;
  isRegularFile: boolean;
  /** Any exec bit set (POSIX mode & 0o111). Advisory on win32. */
  isExecutable: boolean;
  size: number;
  /** mode & 0o7777. */
  mode: number;
  device: string;
  inode: string;
  nlink: number;
  /** The opened inode still matches the named canonical file and it is not a
   *  symlink — no swap raced between open and stat. */
  identityStable: boolean;
}

// O_NOFOLLOW/O_NONBLOCK are POSIX-only; on win32 they are undefined and must
// degrade to a no-op (0) or the OR would produce NaN and every open would fail
// — which would make the resolver find no binaries on Windows.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Safely open the realpath-resolved canonical file (O_NOFOLLOW so a swapped
 * symlink can't redirect us; O_NONBLOCK so a FIFO on PATH cannot block the
 * open), capture its facts, and hand the SAME fd to `fn` so a content read is
 * byte-faithful to the exact inode we identity-checked (no TOCTOU between the
 * check and the read).
 */
export function withExecutableInspection<T>(
  path: string,
  fn: (info: ExecutableInspection, fd: number) => T,
): T {
  const canonical = realpathSync(resolve(path));
  const fd = openSync(canonical, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const named = lstatSync(canonical, { bigint: true });
    const identityStable =
      !named.isSymbolicLink() &&
      named.isFile() &&
      named.dev === stat.dev &&
      named.ino === stat.ino;
    const info: ExecutableInspection = {
      realpath: canonical,
      isRegularFile: stat.isFile(),
      isExecutable: (stat.mode & 0o111n) !== 0n,
      size: Number(stat.size),
      mode: Number(stat.mode & 0o7777n),
      device: String(stat.dev),
      inode: String(stat.ino),
      nlink: Number(stat.nlink),
      identityStable,
    };
    return fn(info, fd);
  } finally {
    closeSync(fd);
  }
}

/** Facts only (fd closed before returning). */
export function inspectExecutable(path: string): ExecutableInspection {
  return withExecutableInspection(path, (info) => info);
}

/** True when the inspection describes a real, bounded regular file. */
export function isBoundedRegularExecutable(info: ExecutableInspection): boolean {
  return (
    info.isRegularFile && info.identityStable && info.size >= 0 && info.size <= MAX_EXECUTABLE_BYTES
  );
}

/**
 * Cheap "the process can spawn this" verdict for the harness PATH resolver: a
 * bounded regular file the current user may execute. No content hash. Returns
 * false on any inspection error (dangling symlink, permission, mid-walk race).
 */
export function isLaunchableExecutable(path: string): boolean {
  try {
    const info = inspectExecutable(path);
    if (!info.isRegularFile || !info.identityStable) return false;
    if (process.platform !== "win32") accessSync(info.realpath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
