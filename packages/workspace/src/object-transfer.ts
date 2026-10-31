import {
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  fstatSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileSink, gitObserved, GitOperationError } from "./git-observed.js";

/** One object database end of a transfer: where its objects live and how Git reads them. */
export interface ObjectEndpoint {
  /** Directory Git commands run in (a worktree, a bare store or a scratch repo). */
  cwd: string;
  /** Environment that makes Git see exactly this endpoint's objects. */
  env: Record<string, string>;
  /** The object directory files are linked into or read from. */
  objectsDir: string;
}

/** Margin kept free on the destination filesystem beyond what a copy needs. */
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** Copies of big blobs stream in bounded memory: Git treats every blob above this as "big". */
const STREAMING_THRESHOLD = ["-c", "core.bigFileThreshold=1m"];

export function looseObjectPath(objectsDir: string, oid: string): string {
  return join(objectsDir, oid.slice(0, 2), oid.slice(2));
}

const PACK_INDEX_HEADER = 8 + 256 * 4;

/** The object count of a version-2 pack index: its fanout total, one fixed read. */
function readPackIndexCount(fd: number, idxPath: string): number {
  const header = Buffer.alloc(PACK_INDEX_HEADER);
  if (readSync(fd, header, 0, header.length, 0) !== header.length)
    throw new Error(`short pack index ${idxPath}`);
  if (header.readUInt32BE(0) !== 0xff744f63 || header.readUInt32BE(4) !== 2)
    throw new Error(`unsupported pack index ${idxPath}`);
  return header.readUInt32BE(8 + 255 * 4);
}

function packIndexObjectCount(idxPath: string): number {
  const fd = openSync(idxPath, "r");
  try {
    return readPackIndexCount(fd, idxPath);
  } finally {
    closeSync(fd);
  }
}

/** Object ids of a version-2 pack index, read in bounded chunks (no whole-file read). */
export function packIndexObjectIds(idxPath: string, hashLength: 20 | 32): string[] {
  const fd = openSync(idxPath, "r");
  try {
    const count = readPackIndexCount(fd, idxPath);
    // v2 layout: header, fanout, sorted oids, crc32s, offsets, large offsets, checksums.
    if (fstatSync(fd).size < PACK_INDEX_HEADER + count * (hashLength + 8) + 2 * hashLength)
      throw new Error(`short pack index ${idxPath}`);
    const oids: string[] = [];
    const chunk = Buffer.alloc(hashLength * 4096);
    for (let index = 0; index < count;) {
      const take = Math.min(4096, count - index);
      const read = readSync(
        fd,
        chunk,
        0,
        take * hashLength,
        PACK_INDEX_HEADER + index * hashLength,
      );
      if (read !== take * hashLength) throw new Error(`short pack index ${idxPath}`);
      for (let entry = 0; entry < take; entry += 1)
        oids.push(chunk.toString("hex", entry * hashLength, (entry + 1) * hashLength));
      index += take;
    }
    return oids;
  } finally {
    closeSync(fd);
  }
}

function sameDevice(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

/** Hard-link errors meaning "this filesystem cannot link here": the caller streams instead. */
const LINK_UNAVAILABLE = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"]);

/** Publish `source` at `target` by hard link, never overwriting; false when the
 * filesystem refuses hard links (FAT/exFAT, some network mounts), so the
 * objects are streamed as a pack instead of failing the capture. */
function tryLink(source: string, target: string): boolean {
  if (existsSync(target)) return true;
  const temp = `${target}.tmp-${randomUUID()}`;
  try {
    linkSync(source, temp);
    renameSync(temp, target);
    return true;
  } catch (error) {
    if (LINK_UNAVAILABLE.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Bytes free for an unprivileged writer on the filesystem holding `path`;
 * null when the platform or filesystem cannot report it (free space unknown). */
export function availableBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/** A write that ran out of space is the typed space refusal, wherever it happened. */
function typedSpaceFailure(error: unknown, label: string): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== "ENOSPC" && code !== "EDQUOT") return error;
  return new GitOperationError(
    "capture_space_insufficient",
    `${label} ran out of space: ${(error as Error).message}`,
  );
}

/** On-disk sizes of the given objects at an endpoint (missing objects count zero). */
export async function objectDiskSizes(
  endpoint: ObjectEndpoint,
  oids: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const result = await gitObserved(
    endpoint.cwd,
    ["cat-file", "--batch-check=%(objectname) %(objectsize:disk)"],
    { env: endpoint.env, input: `${oids.join("\n")}\n`, label: "cat-file --batch-check" },
  );
  for (const line of result.stdout.split("\n")) {
    const [oid, size] = line.split(" ");
    if (oid && size && /^\d+$/.test(size)) sizes.set(oid, Number(size));
  }
  return sizes;
}

/** The subset of `oids` an endpoint lacks (its own objects plus any alternates its env names). */
export async function missingObjects(
  endpoint: ObjectEndpoint,
  oids: readonly string[],
): Promise<string[]> {
  if (oids.length === 0) return [];
  const result = await gitObserved(endpoint.cwd, ["cat-file", "--batch-check=%(objectname)"], {
    env: endpoint.env,
    input: `${oids.join("\n")}\n`,
    label: "cat-file --batch-check",
  });
  return result.stdout
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.slice(0, -" missing".length));
}

/** Refuse before writing when the destination cannot hold what is about to be
 * copied. Unknown free space refuses nothing: a write that then runs out of
 * space still ends as the same typed refusal (see typedSpaceFailure). */
export function assertSpaceFor(destinationDir: string, requiredBytes: number, label: string): void {
  if (requiredBytes <= 0) return;
  const free = availableBytes(destinationDir);
  if (free !== null && free < requiredBytes + SPACE_MARGIN_BYTES) {
    throw new GitOperationError(
      "capture_space_insufficient",
      `${label} needs ${requiredBytes} bytes plus a ${SPACE_MARGIN_BYTES}-byte margin; ${free} bytes are free`,
      { requiredBytes: requiredBytes + SPACE_MARGIN_BYTES, availableBytes: free },
    );
  }
}

export interface TransferResult {
  linkedPacks: number;
  linkedLoose: number;
  streamedObjects: number;
  copiedBytes: number;
}

/**
 * Make every object of `oids` present in `to`. Whole source packs whose objects
 * are all wanted are adopted by hard link on one filesystem; wanted loose
 * objects are linked; the rest are streamed as one self-contained pack (no
 * deltas, big-blob streaming on both sides), so no child holds a large blob in
 * memory and no JS string ever holds object bytes. A streamed pack is staged
 * inside the destination object directory (`tmp_*`, which Git's own prune
 * reclaims after a crash), so its publication is a same-filesystem rename even
 * when the source lives on another volume.
 */
export async function transferObjects(
  from: ObjectEndpoint,
  to: ObjectEndpoint,
  oids: readonly string[],
  hashLength: 20 | 32,
): Promise<TransferResult> {
  try {
    return await transferObjectsUnchecked(from, to, oids, hashLength);
  } catch (error) {
    throw typedSpaceFailure(error, "object copy");
  }
}

async function transferObjectsUnchecked(
  from: ObjectEndpoint,
  to: ObjectEndpoint,
  oids: readonly string[],
  hashLength: 20 | 32,
): Promise<TransferResult> {
  const result: TransferResult = {
    linkedPacks: 0,
    linkedLoose: 0,
    streamedObjects: 0,
    copiedBytes: 0,
  };
  let wanted = new Set(await missingObjects(to, [...new Set(oids)]));
  if (wanted.size === 0) return result;
  const sizes = await objectDiskSizes(from, [...wanted]);
  let linkable = sameDevice(from.objectsDir, to.objectsDir);
  // Adopt whole packs only on one filesystem: a cross-device copy of a pack
  // with foreign objects would cost more than streaming just the wanted ones.
  const packDir = join(from.objectsDir, "pack");
  if (linkable && existsSync(packDir)) {
    mkdirSync(join(to.objectsDir, "pack"), { recursive: true });
    for (const name of readdirSync(packDir)) {
      if (!name.endsWith(".idx")) continue;
      const idx = join(packDir, name);
      const pack = idx.slice(0, -4) + ".pack";
      if (!existsSync(pack)) continue;
      // A pack holding more objects than are wanted can never be adopted whole.
      const count = packIndexObjectCount(idx);
      if (count === 0 || count > wanted.size) continue;
      const members = packIndexObjectIds(idx, hashLength);
      if (!members.every((oid) => wanted.has(oid))) continue;
      const packTarget = join(to.objectsDir, "pack", name.slice(0, -4) + ".pack");
      if (!tryLink(pack, packTarget)) {
        linkable = false;
        break;
      }
      // The .idx makes a pack visible; without it the linked .pack is inert.
      if (!tryLink(idx, join(to.objectsDir, "pack", name))) {
        rmSync(packTarget, { force: true });
        linkable = false;
        break;
      }
      for (const oid of members) wanted.delete(oid);
      result.linkedPacks += 1;
    }
  }
  if (linkable) {
    for (const oid of [...wanted]) {
      const source = looseObjectPath(from.objectsDir, oid);
      if (!existsSync(source)) continue;
      mkdirSync(join(to.objectsDir, oid.slice(0, 2)), { recursive: true });
      if (!tryLink(source, looseObjectPath(to.objectsDir, oid))) break;
      wanted.delete(oid);
      result.linkedLoose += 1;
    }
  }
  if (wanted.size > 0) {
    const required = [...wanted].reduce((sum, oid) => sum + (sizes.get(oid) ?? 0), 0);
    assertSpaceFor(to.objectsDir, required, "object copy");
    const staging = join(to.objectsDir, `tmp_claudexor-${randomUUID()}`);
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const base = join(staging, "transfer");
      const sink = fileSink(`${base}.pack`);
      try {
        await gitObserved(
          from.cwd,
          [...STREAMING_THRESHOLD, "pack-objects", "--stdout", "-q", "--window=0", "--depth=0"],
          {
            env: from.env,
            input: `${[...wanted].join("\n")}\n`,
            stdout: sink,
            label: "pack-objects",
          },
        );
      } finally {
        sink.end();
      }
      result.copiedBytes += sink.bytes();
      const indexed = await gitObserved(
        to.cwd,
        [...STREAMING_THRESHOLD, "index-pack", `${base}.pack`],
        { env: to.env, label: "index-pack", progress: () => statSafe(`${base}.idx`) },
      );
      const name = indexed.stdout.trim().split(/\s+/).pop() ?? "";
      if (!/^[0-9a-f]{40,64}$/.test(name)) {
        throw new GitOperationError("capture_failed", "index-pack returned no pack name");
      }
      mkdirSync(join(to.objectsDir, "pack"), { recursive: true });
      // The .idx makes a pack visible; it moves last.
      renameSync(`${base}.pack`, join(to.objectsDir, "pack", `pack-${name}.pack`));
      renameSync(`${base}.idx`, join(to.objectsDir, "pack", `pack-${name}.idx`));
      result.streamedObjects += wanted.size;
      wanted = new Set();
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return result;
}

function statSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
