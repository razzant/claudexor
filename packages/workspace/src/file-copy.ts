/**
 * Exact file bytes at a second name, without paying for them twice.
 *
 * An INDEPENDENT copy (anything a harness, a user or a delivery may write) is a
 * bounded stream from an open, no-follow handle after a destination space check,
 * which leaves the zero blocks of a sparse source unwritten. Only a trusted,
 * engine-owned immutable source may instead be a copy-on-write clone, where the
 * runtime makes one (a Linux reflink; Node offers none on macOS). A SHARED name
 * (one inode) is only for two engine-owned immutable files of one run. All keep
 * the exact length, holes included.
 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, link, lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import { newId } from "@claudexor/util";
import type { RunContentIndex } from "./content-index.js";
import { availableBytes, LINK_UNAVAILABLE, SPACE_MARGIN_BYTES } from "./object-transfer.js";

/** The identity of exact file bytes; `sha256` carries its `sha256:` prefix. */
export interface FileDigest {
  sha256: string;
  sizeBytes: number;
}

/** A copy that does not fit, cannot be shown to fit, or ran out of space. */
export class FileSpaceError extends WorkspaceError {
  readonly code = "capture_space_insufficient";
  readonly requiredBytes?: number;
  readonly availableBytes?: number;
  constructor(
    message: string,
    facts: { requiredBytes?: number; availableBytes?: number; cause?: unknown } = {},
  ) {
    super(message, facts.cause === undefined ? undefined : { cause: facts.cause });
    if (facts.requiredBytes !== undefined) this.requiredBytes = facts.requiredBytes;
    if (facts.availableBytes !== undefined) this.availableBytes = facts.availableBytes;
  }
}

/** A file that changed while it was being read: the reading is stale, not unreadable. */
export class FileChangedError extends WorkspaceError {
  readonly code = "file_changed";
  constructor(path: string) {
    super(`File changed while being captured: ${path}`);
  }
}

/** An engine-owned immutable name that holds other bytes than its reference. */
export class ImmutableFileMismatch extends WorkspaceError {
  readonly code = "immutable_mismatch";
  /** The name whose bytes differ (a copy's source, when the copy did not match). */
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

const CHUNK_BYTES = 1024 * 1024;
/** The granularity at which an all-zero range is left unwritten. */
const HOLE_BYTES = 4096;
const ZERO_BLOCK = Buffer.alloc(HOLE_BYTES);
/** From this size a copy is checked for room first; a smaller one costs at most its own length. */
const COSTLY_BYTES = 1024 * 1024;
/** The size from which a file's bytes are worth looking for in a store before copying. */
export const LARGE_FILE_BYTES = COSTLY_BYTES;
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;

/** A write that ran out of space is the typed space refusal, wherever it happened. */
export function fileSpaceFailure(error: unknown, label: string): unknown {
  const code = codeOf(error);
  if (code !== "ENOSPC" && code !== "EDQUOT") return error;
  return new FileSpaceError(`${label} ran out of space: ${(error as Error).message}`, {
    cause: error,
  });
}

/**
 * Refuse a costly byte copy the destination cannot be shown to hold. The bound
 * is the file's whole length, deliberately conservative: a destination that
 * keeps holes (ext4, APFS) might need far less, but the engine does not assume
 * it, so a sparse file can be refused where it would have fitted. Unknown free
 * space is not room.
 */
function assertCopySpace(destinationDir: string, sizeBytes: number): void {
  if (sizeBytes < COSTLY_BYTES) return;
  const requiredBytes = sizeBytes + SPACE_MARGIN_BYTES;
  const free = fileCopyHost.availableBytes(destinationDir);
  if (free !== null && free >= requiredBytes) return;
  // Free space that cannot be read proves nothing either way: a copy below the
  // margin proceeds (a real ENOSPC still ends as the typed refusal), one of the
  // margin or more is refused as unconfirmed.
  if (free === null && sizeBytes < SPACE_MARGIN_BYTES) return;
  throw new FileSpaceError(
    free === null
      ? `file copy of ${sizeBytes} bytes was not started: free space at the destination is unknown, and a copy of ${SPACE_MARGIN_BYTES} bytes (64 MiB) or more needs it confirmed`
      : `file copy needs the file's full length of ${sizeBytes} bytes (holes at the destination are not assumed) plus a ${SPACE_MARGIN_BYTES}-byte margin; ${free} bytes are free`,
    { requiredBytes, ...(free === null ? {} : { availableBytes: free }) },
  );
}

/** A source that is not the length it was checked at, however it changed. */
const changedDuringCapture = (path: string) => new FileChangedError(path);

/** Remove a file this module created. */
const discard = (path: string) => rm(path, { force: true });

/** Give `source`'s inode the name `target`, never over an existing entry. */
async function claimName(source: string, target: string) {
  try {
    await fileCopyHost.link(source, target);
    return "linked" as const;
  } catch (error) {
    if (codeOf(error) === "EEXIST") return "taken" as const;
    if (LINK_UNAVAILABLE.has(codeOf(error) ?? "")) return "unavailable" as const;
    throw error;
  }
}

/**
 * Create `target` as a copy-on-write clone of the trusted, engine-owned
 * immutable `source`; false when this runtime cannot clone between them
 * (nothing is left at `target`). An existing `target` is never touched. Node
 * reaches no clonefile(2) on macOS (its forced clone answers ENOSYS and its
 * fallback copies every byte), so there the checked stream is used.
 */
async function cloneFile(source: string, target: string): Promise<boolean> {
  if (process.platform === "darwin") return false;
  try {
    await copyFile(source, target, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw error;
    return false;
  }
}

/** Fewer allocated bytes than length. Only such a source has zero ranges to
 * leave unwritten: an allocated file is not thinned by being copied. */
const isSparse = (info: Stats) => (info.blocks ?? 0) * 512 < info.size;

/** The host facilities a copy depends on, in one place so a test can withhold them. */
export const fileCopyHost = { clone: cloneFile, availableBytes, link, isSparse };

/** Read a regular file in bounded memory. With `limit` (the length the caller
 * checked room for) at most that many bytes are read, and one more read must
 * find the end: a file that grew meanwhile is `changedDuringCapture`. */
async function readChunks(
  input: FileHandle,
  each: (chunk: Buffer, offset: number) => Promise<void> | void,
  bound?: { limit: number; path: string },
): Promise<FileDigest> {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (;;) {
    const want = bound ? Math.min(buffer.length, bound.limit - sizeBytes) : buffer.length;
    if (want === 0) {
      const { bytesRead } = await input.read(buffer, 0, 1, sizeBytes);
      if (bytesRead > 0) throw changedDuringCapture(bound!.path);
      break;
    }
    const { bytesRead } = await input.read(buffer, 0, want, sizeBytes);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    await each(chunk, sizeBytes);
    sizeBytes += bytesRead;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, sizeBytes };
}

export async function fileDigest(path: string): Promise<FileDigest> {
  const input = await open(path, OPEN_READ);
  try {
    if (!(await input.stat()).isFile()) throw new WorkspaceError(`Not a regular file: ${path}`);
    return await readChunks(input, () => undefined);
  } finally {
    await input.close();
  }
}

/** Positional write of `chunk[from, to)`; a short write continues where it stopped. */
async function writeRange(
  output: FileHandle,
  chunk: Buffer,
  range: { from: number; to: number; position: number },
): Promise<void> {
  for (let { from, position } = range; from < range.to;) {
    const { bytesWritten } = await output.write(chunk, from, range.to - from, position);
    if (bytesWritten <= 0) throw new WorkspaceError("File copy made no write progress");
    from += bytesWritten;
    position += bytesWritten;
  }
}

/** Stream `input` into the empty `output`. With `holes`, only the blocks that
 * hold data are written. */
async function copyStream(
  input: FileHandle,
  output: FileHandle,
  holes: boolean,
  bound: { limit: number; path: string },
): Promise<FileDigest> {
  const digest = await readChunks(
    input,
    async (chunk, offset) => {
      if (!holes) return writeRange(output, chunk, { from: 0, to: chunk.length, position: offset });
      let from = -1;
      for (let at = 0; at < chunk.length;) {
        const end = Math.min(chunk.length, at + HOLE_BYTES - ((offset + at) % HOLE_BYTES));
        const zero = chunk.compare(ZERO_BLOCK, 0, end - at, at, end) === 0;
        if (!zero && from < 0) from = at;
        if (zero && from >= 0) {
          await writeRange(output, chunk, { from, to: at, position: offset + from });
          from = -1;
        }
        at = end;
      }
      if (from >= 0)
        await writeRange(output, chunk, { from, to: chunk.length, position: offset + from });
    },
    bound,
  );
  // Sets the exact length: trailing holes and zero-only files have no write of their own.
  await output.truncate(digest.sizeBytes);
  return digest;
}

const matches = (a: FileDigest, b: FileDigest) =>
  a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;

/**
 * Create `target`, which must not exist, as an independent copy of the regular
 * file `source`, and answer the digest of the bytes it holds. With `expected`,
 * other bytes are refused. `durable: false` skips the final flush, for a
 * disposable copy (a review or verification tree). `immutableSource` marks an
 * engine-owned immutable blob, the only source that may be cloned; any other is
 * streamed from the handle opened here. A failure removes only what this call
 * created.
 */
export async function writeIndependentCopy(
  source: string,
  target: string,
  options: {
    expected?: FileDigest;
    mode?: number;
    durable?: boolean;
    immutableSource?: boolean;
  } = {},
): Promise<FileDigest> {
  const input = await open(source, OPEN_READ);
  let created = false;
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new WorkspaceError(`Not a regular file: ${source}`);
    let digest: FileDigest;
    if (options.immutableSource && (await fileCopyHost.clone(source, target))) {
      created = true;
      digest = await fileDigest(target);
    } else {
      assertCopySpace(dirname(target), info.size);
      const output = await open(target, "wx", 0o600);
      created = true;
      try {
        digest = await copyStream(input, output, fileCopyHost.isSparse(info), {
          limit: info.size,
          path: source,
        });
      } finally {
        await output.close();
      }
    }
    // Room was checked for the length seen at the start (a clone is of the source
    // as it is when cloned): a source of any other length changed meanwhile.
    if (digest.sizeBytes !== info.size) throw changedDuringCapture(source);
    if (options.expected && !matches(digest, options.expected))
      throw new ImmutableFileMismatch(
        "File artifact does not match its recorded hash and size",
        source,
      );
    const written = await open(target, "r+");
    try {
      // The digest is of the bytes read; the file must also hold that length.
      if ((await written.stat()).size !== digest.sizeBytes)
        throw new WorkspaceError("File copy does not hold the source's exact length");
      // A clone took its source's mode: the copy is private unless told otherwise.
      await written.chmod(options.mode ?? 0o600);
      if (options.durable !== false) await written.sync();
    } finally {
      await written.close();
    }
    return digest;
  } catch (error) {
    if (created) await discard(target);
    throw fileSpaceFailure(error, "file copy");
  } finally {
    await input.close();
  }
}

/** Whether the immutable `path` already holds `expected`; false only when it is
 * absent. Anything else there is refused (`ImmutableFileMismatch`) and left as
 * it is. With the run's `index`, an inode it verified and that is unchanged
 * since is not read again. */
export async function hasImmutableFile(
  path: string,
  expected: FileDigest,
  index?: RunContentIndex,
): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  if (info.isFile() && info.size === expected.sizeBytes) {
    if (index?.verified(info, expected)) return true;
    if (matches(await fileDigest(path), expected)) {
      index?.remember(path, info, expected);
      return true;
    }
  }
  throw new ImmutableFileMismatch(
    `Existing result bytes do not match their immutable file reference: ${path}`,
    path,
  );
}

/** A new name changes an inode's ctime: the index learns the identity after it. */
async function named(path: string, digest: FileDigest, index?: RunContentIndex): Promise<void> {
  if (index) index.remember(path, await lstat(path), digest);
}

/** Publish a private file this process just wrote (and hashed) under its
 * immutable name, whole or not at all; true when this call created `target`.
 * The caller removes `staged`. */
export async function claimImmutableFile(
  staged: string,
  target: string,
  digest: FileDigest,
  index?: RunContentIndex,
): Promise<boolean> {
  if (await hasImmutableFile(target, digest, index)) return false;
  const claim = await claimName(staged, target);
  if (claim === "taken") {
    await hasImmutableFile(target, digest, index);
    return false;
  }
  // Without hard links the name was just seen free.
  if (claim === "unavailable") await rename(staged, target);
  await named(target, digest, index);
  return true;
}

/**
 * Give an engine-owned immutable file a second engine-owned name in the same
 * run without writing its bytes again. Both names are one inode: never hand
 * either to a writer or change its mode. True when this call created `target`;
 * a filesystem without hard links (or another volume) gets an independent
 * copy instead, which then stands alone.
 */
export async function shareImmutableFile(
  source: string,
  target: string,
  expected: FileDigest,
  index?: RunContentIndex,
): Promise<boolean> {
  try {
    await mkdir(dirname(target), { recursive: true });
    if (await hasImmutableFile(target, expected, index)) return false;
    if (!(await hasImmutableFile(source, expected, index)))
      throw new WorkspaceError(`Immutable file is missing: ${source}`);
    const claim = await claimName(source, target);
    if (claim === "linked") {
      await named(target, expected, index);
      return true;
    }
    if (claim === "taken") {
      await hasImmutableFile(target, expected, index);
      return false;
    }
    // Written under a private name: the immutable one never holds a fragment.
    const staged = join(dirname(target), newId("pending"));
    try {
      await writeIndependentCopy(source, staged, { expected, immutableSource: true });
      return await claimImmutableFile(staged, target, expected, index);
    } finally {
      await discard(staged);
    }
  } catch (error) {
    throw fileSpaceFailure(error, "file publication");
  }
}

/**
 * `shareImmutableFile` from a store that may not hold the bytes: true when
 * `target` holds `expected` afterwards, false when `source` is absent. A source
 * that exists must be exactly those bytes.
 */
export async function adoptImmutableFile(
  source: string,
  target: string,
  expected: FileDigest,
  index?: RunContentIndex,
): Promise<boolean> {
  const present = await lstat(source).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!present) return false;
  await shareImmutableFile(source, target, expected, index);
  return true;
}

/** An `fs.cp` filter that writes each admitted regular file itself, as an
 * independent disposable copy that keeps holes (a review tree: not flushed);
 * directories and links stay `cp`'s own. */
export function independentFileFilter(admit: (source: string) => boolean | Promise<boolean>) {
  return async (source: string, target: string): Promise<boolean> => {
    if (!(await admit(source))) return false;
    const info = await lstat(source);
    if (!info.isFile()) return true;
    await writeIndependentCopy(source, target, { mode: info.mode & 0o777, durable: false });
    return false;
  };
}
