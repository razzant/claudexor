import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureCanonicalPrivateDirectory,
  userConfigDir,
  userHomeDir,
} from "@claudexor/util";

export function daemonDir(): string {
  return join(userConfigDir(), "daemon");
}

/**
 * Prove every daemon-owned root component before any token/log/lock writer is
 * allowed to touch it. On first launch the default `~/.claudexor` parent may
 * not exist yet, so create that one owned root before proving the v2 subtree.
 * A custom root must still have a canonical parent supplied by its operator.
 */
export function ensureDaemonRuntimeRoot(): string {
  if (!process.env.CLAUDEXOR_CONFIG_DIR?.trim()) {
    const defaultParent = join(userHomeDir(), ".claudexor");
    if (!existsSync(defaultParent)) ensureCanonicalPrivateDirectory(defaultParent);
  }
  const configRoot = ensureCanonicalPrivateDirectory(userConfigDir());
  const root = ensureCanonicalPrivateDirectory(join(configRoot, "daemon"));
  if (root !== resolve(daemonDir())) throw new Error("daemon runtime root is not canonical");
  return root;
}

export function defaultSocketPath(): string {
  return process.env.CLAUDEXOR_DAEMON_SOCK || join(daemonDir(), "claudexord.sock");
}

export function logPath(): string {
  return join(daemonDir(), "claudexord.log");
}

/** Read or generate a per-user local auth token (0600), never through links. */
export function ensureToken(): string {
  const root = ensureDaemonRuntimeRoot();
  const path = join(root, "token");
  try {
    return readValidatedToken(path, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const token = randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("daemon token target is unsafe");
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(`${token}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return readValidatedToken(path, true);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(root);
  return token;
}

export function readToken(): string | null {
  try {
    const root = validateDaemonRuntimeRootReadOnly();
    return readValidatedToken(join(root, "token"), false);
  } catch {
    return null;
  }
}

function validateDaemonRuntimeRootReadOnly(): string {
  const root = resolve(daemonDir());
  const stat = lstatSync(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync.native(root) !== root ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(`daemon runtime root is not canonical and private: ${root}`);
  }
  return root;
}

/**
 * Rotate only a proven owner-controlled token inode. The caller already fences
 * a live daemon; this writer adds no compatibility path that would chmod or
 * overwrite a symlink/hardlink/foreign file.
 */
export function rotateToken(): string {
  const root = ensureDaemonRuntimeRoot();
  const path = join(root, "token");
  if (existsSync(path)) void readValidatedToken(path, false);
  const token = randomUUID();
  const temp = join(root, `.token-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(`${token}\n`, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (existsSync(path)) void readValidatedToken(path, false);
    renameSync(temp, path);
    fsyncDirectory(root);
    return token;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* renamed or never created */
    }
  }
}

function readValidatedToken(path: string, repairMode: boolean): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > 4 * 1024 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    )
      throw new Error("daemon token is not an owner-controlled singly-linked regular file");
    if ((opened.mode & 0o077) !== 0) {
      if (!repairMode) throw new Error("daemon token permissions are not private");
      // The inode/path identity was fully proven above; only now may startup
      // repair permissions inherited from an older Claudexor version.
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    }
    const token = readFileSync(fd, "utf8").trim();
    if (!token || token.includes("\n") || token.includes("\r")) {
      throw new Error("daemon token is empty or malformed");
    }
    return token;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
