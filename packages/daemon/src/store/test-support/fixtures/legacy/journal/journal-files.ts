import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { fsyncDirectory } from "../util/index.js";

export interface AppendIntent {
  v: 1;
  offset: number;
  length: number;
}

export function sameJournalFile(expected: Stats, actual: Stats, bytes = expected.size): boolean {
  return (
    actual.isFile() &&
    actual.nlink === 1 &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === bytes
  );
}

export function openJournalWriter(path: string): number {
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("journal file is not privately owned");
    if ((stat.mode & 0o777) !== 0o600) {
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** A failed rename may resume only the exact original canonical file. */
export function reopenOriginalWriter(path: string, original: Stats): number {
  let fd = -1;
  try {
    if (!sameJournalFile(original, lstatSync(path))) return -1;
    fd = openJournalWriter(path);
    if (sameJournalFile(original, fstatSync(fd))) return fd;
  } catch {
    /* the caller enters its typed recovery path */
  }
  if (fd >= 0) closeSync(fd);
  return -1;
}

export function appendAndSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

/** Truncate only an already validated pending suffix. Windows append handles
 * lack FILE_WRITE_DATA, required by NtSetInformationFile's EOF operation. */
export function truncatePendingSuffix(
  fd: number,
  path: string,
  offset: number,
  bytes: number,
): void {
  if (process.platform !== "win32") {
    ftruncateSync(fd, offset);
    fsyncSync(fd);
    return;
  }
  const original = fstatSync(fd);
  const recoveryFd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (
      !sameJournalFile(original, fstatSync(fd), bytes) ||
      !sameJournalFile(original, fstatSync(recoveryFd), bytes) ||
      !sameJournalFile(original, lstatSync(path), bytes)
    ) {
      throw new Error("journal identity changed before pending suffix recovery");
    }
    ftruncateSync(recoveryFd, offset);
    fsyncSync(recoveryFd);
    if (
      !sameJournalFile(original, fstatSync(fd), offset) ||
      !sameJournalFile(original, fstatSync(recoveryFd), offset) ||
      !sameJournalFile(original, lstatSync(path), offset)
    ) {
      throw new Error("journal identity changed during pending suffix recovery");
    }
  } finally {
    // A close failure must also leave the intent in place and refuse readiness.
    closeSync(recoveryFd);
  }
}

export function ensurePrivateFile(path: string): void {
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(dirname(path));
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("journal path is not a private regular file");
  }
}

export function readIntent(path: string): AppendIntent | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) throw new Error("unsafe file");
    const value = JSON.parse(readFileSync(fd, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0 ||
      !Number.isSafeInteger(value.length) ||
      Number(value.length) <= 0
    ) {
      throw new Error("invalid shape");
    }
    return value as unknown as AppendIntent;
  } finally {
    closeSync(fd);
  }
}

export function writeIntent(path: string, value: AppendIntent): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

export function removeFile(path: string): void {
  if (!existsSync(path)) return;
  rmSync(path);
  fsyncDirectory(dirname(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
