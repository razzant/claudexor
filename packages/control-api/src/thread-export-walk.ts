import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

/** A bundle path segment: no separator, no traversal. */
export const bundleSegment = (value: string): string =>
  encodeURIComponent(value).replace(/^\.+/, (dots) => "%2E".repeat(dots.length));

/** The file an item was inventoried as; a transfer serves only this inode. */
export interface ExportFileIdentity {
  absPath: string;
  dev: number;
  ino: number;
  sizeBytes: number;
  mtimeMs: number;
}

export type WalkedEntry =
  | { kind: "file"; rel: string; file: ExportFileIdentity }
  | { kind: "symlink"; rel: string; linkTarget: string }
  | { kind: "special"; rel: string };

export interface WalkProblem {
  rel: string;
  message: string;
}

const errorText = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/**
 * Every entry under a real directory, never through a link: a link is recorded
 * by its own text and its target is never read, a FIFO or socket is recorded
 * and never opened. Reads are asynchronous, so a large tree never holds the
 * event loop. An unreadable entry is reported, never skipped silently.
 */
export async function walkTree(
  root: string,
  prefix = "",
  signal?: AbortSignal,
): Promise<{ entries: WalkedEntry[]; problems: WalkProblem[] }> {
  const entries: WalkedEntry[] = [];
  const problems: WalkProblem[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    signal?.throwIfAborted();
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      signal?.throwIfAborted();
      problems.push({ rel: rel || ".", message: errorText(error) });
      return;
    }
    signal?.throwIfAborted();
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      signal?.throwIfAborted();
      const path = join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entered = await describeEntry(path, childRel);
      signal?.throwIfAborted();
      if ("message" in entered) problems.push(entered);
      else if (entered.kind === "directory") await visit(path, childRel);
      else entries.push(entered);
    }
  };
  await visit(root, prefix);
  return { entries, problems };
}

/** One lstat classification; a directory is the walk's to enter. */
export async function describeEntry(
  path: string,
  rel: string,
): Promise<WalkedEntry | { kind: "directory" } | WalkProblem> {
  try {
    const stat = await lstat(path);
    if (stat.isDirectory()) return { kind: "directory" };
    if (stat.isSymbolicLink()) return { kind: "symlink", rel, linkTarget: await readlink(path) };
    if (!stat.isFile()) return { kind: "special", rel };
    return {
      kind: "file",
      rel,
      file: {
        absPath: path,
        dev: stat.dev,
        ino: stat.ino,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      },
    };
  } catch (error) {
    return { rel, message: errorText(error) };
  }
}

export function itemChanged(detail: string): Error {
  return Object.assign(new Error(`export item changed since the manifest: ${detail}`), {
    code: "thread_export_item_changed",
    status: 409,
    retryable: false,
    requiredActions: ["re-read the manifest"],
  });
}

/** Open only the inode the inventory saw, unchanged, without following a link. */
export async function openIdentified(file: ExportFileIdentity) {
  let handle;
  try {
    handle = await open(
      file.absPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
    throw itemChanged(`${file.absPath} (${errorText(error)})`);
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== file.dev ||
      stat.ino !== file.ino ||
      stat.size !== file.sizeBytes ||
      stat.mtimeMs !== file.mtimeMs
    )
      throw itemChanged(file.absPath);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** sha256 and byte count of a stream's exact bytes, without holding them. An
 * optional decoder rides the same pipeline, so its failure rejects exactly once. */
export async function digestStream(
  source: NodeJS.ReadableStream,
  signal?: AbortSignal,
  decoder?: NodeJS.ReadWriteStream,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      done();
    },
  });
  const options = signal ? { signal } : {};
  if (decoder) await pipeline(source, decoder, sink, options);
  else await pipeline(source, sink, options);
  return { sha256: `sha256:${hash.digest("hex")}`, sizeBytes };
}

/** The exact digest of a file known by identity; a later change is refused. */
export async function digestIdentified(
  file: ExportFileIdentity,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await openIdentified(file);
  try {
    const result = await digestStream(handle.createReadStream({ autoClose: false }), signal);
    if (result.sizeBytes !== file.sizeBytes) throw itemChanged(file.absPath);
    return result;
  } finally {
    await handle.close();
  }
}

/** The decoded bytes' digest; a corrupt or non-zstd original throws. */
export async function digestDecoded(
  file: ExportFileIdentity,
  signal?: AbortSignal,
): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await openIdentified(file);
  try {
    return await digestStream(
      handle.createReadStream({ autoClose: false }),
      signal,
      createZstdDecompress(),
    );
  } finally {
    await handle.close();
  }
}

/** Decode a `.jsonl.zst` original into `sink` (the second pass of a transfer). */
export async function streamDecoded(
  file: ExportFileIdentity,
  sink: NodeJS.WritableStream,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await openIdentified(file);
  try {
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createZstdDecompress(),
      sink,
      signal ? { signal } : {},
    );
  } finally {
    await handle.close();
  }
}
