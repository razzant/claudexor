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
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureCanonicalPrivateDirectory } from "@claudexor/util";

export function fingerprintPartition(path: string): string {
  const hash = createHash("sha256");
  if (!existsSync(path)) return hash.update("missing\0").digest("hex");
  const root = lstatSync(path, { bigint: true });
  if (root.isSymbolicLink()) {
    hash.update(`symlink\0${readlinkSync(path)}\0`);
    return hash.digest("hex");
  }
  if (!root.isDirectory()) return hash.update(`other\0${metadata(root)}\0`).digest("hex");
  // Deliberately exclude the root inode/timestamps: this content fingerprint
  // must remain stable when the owned partition is atomically quarantined.
  hash.update("directory\0");
  for (const name of readdirSync(path).sort()) {
    const entryPath = join(path, name);
    const stat = lstatSync(entryPath, { bigint: true });
    hash.update(`entry\0${name}\0${metadata(stat)}\0`);
    if (stat.isSymbolicLink()) hash.update(`target\0${readlinkSync(entryPath)}\0`);
    else if (stat.isFile() && stat.nlink === 1n) hash.update(hashOwnedFile(entryPath));
  }
  return hash.digest("hex");
}

export function exportPartitionEntries(source: string, destination: string) {
  if (!existsSync(source))
    return [
      { name: ".", type: "missing", mode: 0, size: 0, nlink: 0, sha256: null, copiedAs: null },
    ];
  const root = lstatSync(source, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink()) {
    return [
      {
        name: ".",
        type: root.isSymbolicLink() ? "symlink" : "other",
        mode: Number(root.mode & 0o777n),
        size: Number(root.size),
        nlink: Number(root.nlink),
        sha256: null,
        copiedAs: null,
        ...(root.isSymbolicLink() ? { linkTarget: readlinkSync(source) } : {}),
      },
    ];
  }
  return readdirSync(source)
    .sort()
    .map((name) => {
      const path = join(source, name);
      const stat = lstatSync(path, { bigint: true });
      const type = stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other";
      let digest: string | null = null;
      let copiedAs: string | null = null;
      if (stat.isFile() && stat.nlink === 1n) {
        const bytes = readOwnedFile(path);
        digest = sha256(bytes);
        copiedAs = name;
        writeExclusiveFile(join(destination, name), bytes, 0o400);
      }
      return {
        name,
        type,
        mode: Number(stat.mode & 0o777n),
        size: Number(stat.size),
        nlink: Number(stat.nlink),
        sha256: digest,
        copiedAs,
        ...(stat.isSymbolicLink() ? { linkTarget: readlinkSync(path) } : {}),
      };
    });
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

export function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  return hashOwnedFile(path).toString("hex");
}

function hashOwnedFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
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
