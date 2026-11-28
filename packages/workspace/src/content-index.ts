/**
 * One verified payload per digest within a run.
 *
 * A run's directory work keeps exact file bytes under several engine-owned
 * immutable names: each isolated attempt's baseline, each attempt's capture,
 * the run's final files and review evidence. Bytes one of them already holds
 * are linked under the next name instead of being written again. The index
 * lives with the run's `WorkspaceManager` (one per run, in one process) and
 * knows only names this run created or verified: nothing is discovered from
 * directory names, nothing is kept on disk, and it ends with the run. Writable
 * trees (an attempt's copy, a review copy, an Apply target) always receive an
 * independent copy, never one of these names.
 */
import type { Stats } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "@claudexor/util";
import {
  claimImmutableFile,
  fileCopyHost,
  FileChangedError,
  hasImmutableFile,
  ImmutableFileMismatch,
  shareImmutableFile,
  writeIndependentCopy,
  type FileDigest,
} from "./file-copy.js";

/** An inode as it was when verified: a write, a chmod or a new name moves its ctime. */
interface VerifiedInode {
  sha256: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

const inodeKey = (info: Stats) => `${info.dev}:${info.ino}`;

export class RunContentIndex {
  /** Digest -> engine-owned names of this run known to hold it. */
  readonly #holders = new Map<string, string[]>();
  readonly #verified = new Map<string, VerifiedInode>();
  /** One keeper per digest at a time: concurrent attempts never race to store it;
   * keepers of other digests never wait for it. */
  readonly #claims = new Map<string, Promise<unknown>>();

  /** Whether `info` is an inode this index verified as `digest`, unchanged since. */
  verified(info: Stats, digest: FileDigest): boolean {
    const seen = this.#verified.get(inodeKey(info));
    return (
      seen !== undefined &&
      seen.sha256 === digest.sha256 &&
      seen.sizeBytes === digest.sizeBytes &&
      info.size === digest.sizeBytes &&
      seen.mtimeMs === info.mtimeMs &&
      seen.ctimeMs === info.ctimeMs
    );
  }

  /** `path` (as `info`) holds `digest`: verified or created by this run. */
  remember(path: string, info: Stats, digest: FileDigest): void {
    this.#verified.set(inodeKey(info), {
      sha256: digest.sha256,
      sizeBytes: digest.sizeBytes,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    });
    const names = this.#holders.get(digest.sha256) ?? [];
    if (!names.includes(path)) names.push(path);
    this.#holders.set(digest.sha256, names);
  }

  /** Run `work` for `digest` after every earlier keeper of the same digest. */
  async exclusive<T>(digest: string, work: () => Promise<T>): Promise<T> {
    const prior = this.#claims.get(digest) ?? Promise.resolve();
    const mine = prior.then(work, work);
    const settled = mine.then(
      () => undefined,
      () => undefined,
    );
    this.#claims.set(digest, settled);
    try {
      return await mine;
    } finally {
      if (this.#claims.get(digest) === settled) this.#claims.delete(digest);
    }
  }

  /**
   * Give `target` this run's verified bytes of `digest`: true when it holds
   * them afterwards, false when no known name still does, and the caller then
   * stores them from its own source. A name that holds other bytes, or that went
   * away (even between its check and the link), is forgotten and never linked;
   * any other failure (permission, room, the target's own bytes) is thrown.
   */
  async adopt(target: string, digest: FileDigest): Promise<boolean> {
    for (const holder of [...(this.#holders.get(digest.sha256) ?? [])]) {
      if (holder === target) continue;
      try {
        if (await hasImmutableFile(holder, digest, this)) {
          await shareImmutableFile(holder, target, digest, this);
          return true;
        }
      } catch (error) {
        const holderChanged = error instanceof ImmutableFileMismatch && error.path === holder;
        if (!holderChanged && !(await gone(holder))) throw error;
      }
      this.#forget(digest.sha256, holder);
    }
    return false;
  }

  #forget(digest: string, path: string): void {
    const names = (this.#holders.get(digest) ?? []).filter((name) => name !== path);
    if (names.length > 0) this.#holders.set(digest, names);
    else this.#holders.delete(digest);
  }
}

/** Whether an engine-owned name is absent now (any other reading failure is no answer). */
async function gone(path: string): Promise<boolean> {
  return lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );
}

/** The file at `path` is still the one `before` saw, at the digest's length. */
async function assertUnchanged(path: string, before: Stats, digest: FileDigest): Promise<void> {
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== digest.sizeBytes ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new FileChangedError(path);
}

const sameDigest = (a: FileDigest, b: FileDigest) =>
  a.sha256 === b.sha256 && a.sizeBytes === b.sizeBytes;

/**
 * The digest of the regular file `path` (seen as `before`) and, with
 * `contentDir`, its bytes kept there under their content name. With the run's
 * `index`, the file is hashed before anything is written and its digest is
 * claimed alone: bytes the run already holds are linked, and only the first
 * keeper of a digest writes them (one copy, read a second time to write it).
 * Without an index it is written once while it is hashed. A file that changed
 * while it was read is `FileChangedError`.
 */
export async function keepFileContent(
  path: string,
  before: Stats,
  contentDir?: string,
  index?: RunContentIndex,
): Promise<FileDigest> {
  if (!contentDir) {
    const digest = await fileCopyHost.digest(path);
    await assertUnchanged(path, before, digest);
    return digest;
  }
  await mkdir(contentDir, { recursive: true });
  const temp = join(contentDir, newId("pending"));
  try {
    // Within a run every file is hashed before anything is written: bytes it
    // already holds are named again, with no temporary copy whatever their size.
    const hashFirst = index !== undefined;
    const digest = hashFirst
      ? await fileCopyHost.digest(path)
      : await writeIndependentCopy(path, temp);
    await assertUnchanged(path, before, digest);
    const target = join(contentDir, digest.sha256.slice(7));
    const keep = async () => {
      if (await hasImmutableFile(target, digest, index)) return;
      if (index && (await index.adopt(target, digest))) return;
      if (hashFirst) {
        const copied = await writeIndependentCopy(path, temp);
        if (!sameDigest(copied, digest)) throw new FileChangedError(path);
        await assertUnchanged(path, before, copied);
      }
      await claimImmutableFile(temp, target, digest, index);
    };
    await (index ? index.exclusive(digest.sha256, keep) : keep());
    return digest;
  } finally {
    await rm(temp, { force: true });
  }
}
