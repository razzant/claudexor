import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { JournalRecoveryState } from "./store/errors.js";
import { ensureCanonicalPrivateDirectory, fsyncDirectory } from "@claudexor/util";

export function cloneRecovery(value: JournalRecoveryState): JournalRecoveryState {
  return value.status === "ready" ? { ...value } : { ...value, location: { ...value.location } };
}

export function copyOwnedFile(source: string, target: string, mode: number): string {
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertOwnedRegular(source, before);
    const out = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) written += writeSync(out, buffer, written, count - written);
        offset += count;
      }
      fsyncSync(out);
      fchmodSync(out, mode);
      fsyncSync(out);
      const after = fstatSync(fd, { bigint: true });
      if (metadata(before) !== metadata(after))
        throw new Error(`journal file changed while exporting: ${source}`);
      assertOwnedRegular(source, after);
      return hash.digest("hex");
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

export function readOwnedFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertOwnedRegular(path, before);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (metadata(before) !== metadata(after))
      throw new Error(`journal file changed while exporting: ${path}`);
    assertOwnedRegular(path, after);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function writeAtomicPrivateJson(path: string, value: unknown, exclusive: boolean): void {
  ensureCanonicalPrivateDirectory(dirname(path));
  if (exclusive && existsSync(path)) {
    throw Object.assign(new Error("recovery idempotency record already exists"), {
      code: "idempotency_conflict",
      status: 409,
    });
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeExclusiveFile(tmp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* renamed or absent */
    }
  }
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return hashOwnedFile(path).toString("hex");
}

function hashOwnedFile(path: string, expected?: BigIntStats): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (expected && metadata(expected) !== metadata(before)) {
      throw new Error(`journal file changed before hashing: ${path}`);
    }
    assertOwnedRegular(path, before);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (metadata(before) !== metadata(after))
      throw new Error(`journal file changed while hashing: ${path}`);
    assertOwnedRegular(path, after);
    return hash.digest();
  } finally {
    closeSync(fd);
  }
}

function assertOwnedRegular(path: string, opened: BigIntStats): void {
  const named = lstatSync(path, { bigint: true });
  if (
    !opened.isFile() ||
    opened.nlink !== 1n ||
    named.isSymbolicLink() ||
    !named.isFile() ||
    named.nlink !== 1n ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  )
    throw new Error(`journal recovery file is not a singly-linked owned regular file: ${path}`);
}

function metadata(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
}

export function writeExclusiveFile(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
