import { processTiming } from "@claudexor/util";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { link, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mapStoreError } from "./errors.js";
import { withUploadWriteSlot } from "./libuv-pool.js";

/** What an external write carries; a slow write names it in the daemon log. */
export type ExternalWritePurpose = "blob_body" | "terminal_receipt" | "terminal_log" | "import";

/** What an external-file writer needs from the store. */
export interface ExternalRegistry {
  registerExternal(dir: string): number;
  /** One line when a write becomes one of the daemon's worst synchronous
   * sections (`worstSync` in `GET /v2/daemon/status`), so it can be attributed. */
  logSlowWrite?(line: string): void;
}

export interface ExternalFileReceipt {
  path: string;
  /** Generation whose pass makes the directory entry durable. */
  generation: number;
  /** False when a content-addressed target already existed and was kept. */
  written: boolean;
}

/** Node does not expose the POSIX O_DSYNC name on Windows, but passes numeric
 * open flags to libuv. UV_FS_O_DSYNC maps to FILE_FLAG_WRITE_THROUGH there
 * (deps/uv/include/uv/win.h in the supported Node runtime). */
export function externalWriteFlags(access: number): number {
  const sync = process.platform === "win32" ? 0x04000000 : constants.O_DSYNC;
  return access | sync | (constants.O_NOFOLLOW ?? 0);
}

/**
 * Write an external file the SYNTHESIS_R5 §4.4 way: a sibling `.tmp` opened
 * `O_DSYNC` (the data is at the drive when `write` returns, 0.05–0.4 ms for
 * 4 KiB–2 MiB), then `rename` into place, then a `{g, dir}` registration so
 * the flusher's pass fsyncs the directory entry. No Node sync primitive runs
 * on this thread. `keepExisting` is the content-addressed mode: an existing
 * target is never rewritten. The whole call is one `store.external_write`
 * section; one that enters the worst sections is logged with its purpose,
 * size and the split between metadata calls and the data write.
 */
export function writeExternalFile(
  registry: ExternalRegistry,
  input: {
    dir: string;
    name: string;
    bytes: Uint8Array;
    keepExisting?: boolean;
    purpose: ExternalWritePurpose;
  },
): ExternalFileReceipt {
  const started = performance.now();
  let opened: number | null = null;
  let closed: number | null = null;
  let written = false;
  try {
    const target = join(input.dir, input.name);
    if (input.keepExisting && existsSync(target)) {
      return { path: target, generation: registry.registerExternal(input.dir), written: false };
    }
    ensureDirectory(registry, input.dir);
    const temp = join(input.dir, `.${input.name}.${randomUUID()}.tmp`);
    let fd: number | null = null;
    try {
      opened = performance.now();
      fd = openSync(
        temp,
        externalWriteFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
        0o600,
      );
      let offset = 0;
      while (offset < input.bytes.byteLength) {
        offset += writeSync(fd, input.bytes, offset, input.bytes.byteLength - offset, offset);
      }
      closeSync(fd);
      fd = null;
      closed = performance.now();
      if (input.keepExisting && existsSync(target)) {
        unlinkSync(temp);
        return { path: target, generation: registry.registerExternal(input.dir), written: false };
      }
      renameSync(temp, target);
      written = true;
    } catch (error) {
      if (fd !== null) closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        /* best effort; the orphan sweep removes stale .tmp files */
      }
      throw mapStoreError(error, `writing ${target}`);
    }
    return { path: target, generation: registry.registerExternal(input.dir), written: true };
  } finally {
    const ended = performance.now();
    recordExternalWrite(registry, {
      purpose: input.purpose,
      bytes: input.bytes.byteLength,
      written,
      metadata_before_ms: (opened ?? ended) - started,
      data_write_ms: opened === null ? 0 : (closed ?? ended) - opened,
      metadata_publish_ms: closed === null ? 0 : ended - closed,
      total_ms: ended - started,
    });
  }
}

/** One `store.external_write` section; one entering the worst sections is logged. */
function recordExternalWrite(
  registry: ExternalRegistry,
  sample: {
    purpose: ExternalWritePurpose;
    bytes: number;
    written: boolean;
    staged?: true;
  } & Record<`${string}_ms`, number>,
): void {
  if (!processTiming.recordSync("store.external_write", sample.total_ms)) return;
  const rounded = Object.fromEntries(
    Object.entries(sample).map(([key, value]) => [
      key,
      key.endsWith("_ms") ? Math.round(Number(value) * 1_000) / 1_000 : value,
    ]),
  );
  registry.logSlowWrite?.(`store.external_write ${JSON.stringify(rounded)}`);
}

/**
 * Publish a staged temp under its final name in the commit's synchronous
 * step: rename it into place and register the directory, exactly what
 * `writeExternalFile` does after its own write (and the same section for
 * attribution). Null when the rename cannot happen there (another filesystem,
 * or the temp is gone): the caller then writes the bytes itself.
 */
export function publishStagedFile(
  registry: ExternalRegistry,
  input: { temp: string; dir: string; name: string; bytes: number; purpose: ExternalWritePurpose },
): ExternalFileReceipt | null {
  const started = performance.now();
  const target = join(input.dir, input.name);
  let written = false;
  try {
    renameSync(input.temp, target);
    written = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "ENOENT") throw mapStoreError(error, `publishing ${target}`);
    try {
      unlinkSync(input.temp);
    } catch {
      /* best effort; the orphan sweep removes stale .tmp files */
    }
    return null;
  } finally {
    const ended = performance.now();
    recordExternalWrite(registry, {
      purpose: input.purpose,
      bytes: input.bytes,
      written,
      staged: true,
      metadata_publish_ms: ended - started,
      total_ms: ended - started,
    });
  }
  return { path: target, generation: registry.registerExternal(input.dir), written: true };
}

/** An `O_DSYNC` temp file in `dir` holding `bytes`, written on the libuv pool
 * rather than the request thread. The caller publishes or removes it. */
export async function writeStagedTemp(
  dir: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(
    temp,
    externalWriteFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
    0o600,
  );
  let closed = false;
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      offset += bytesWritten;
    }
    closed = true;
    await handle.close();
    return temp;
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Incremental `O_DSYNC` write of an existing file on the libuv pool, using the
 * same flags as `writeStagedTemp`. The caller owns the path (an upload part).
 * `accept` runs on the request thread before each chunk is submitted and may
 * throw to stop the transfer; `committed` runs after that chunk's write returns.
 * A write already sitting in the pool finishes before the next `accept`.
 * Each pool operation (the open with its truncate, every write, the close)
 * holds one slot of the upload gate until it returns, so a transfer waiting for
 * its next chunk from the network holds none. `cancelled` runs while the open
 * or a write waits for a slot and may throw. The close waits for its slot even
 * after a cancel, so the descriptor is closed on every exit.
 */
export async function writeExternalIncremental(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  hooks?: {
    accept?: (chunk: Uint8Array, received: number) => void;
    committed?: (chunk: Uint8Array, received: number) => void;
    cancelled?: () => void;
  },
): Promise<number> {
  const handle = await withUploadWriteSlot(hooks?.cancelled, async () => {
    const opened = await open(path, externalWriteFlags(constants.O_RDWR));
    try {
      await opened.truncate(0);
      return opened;
    } catch (error) {
      await opened.close().catch(() => undefined);
      throw error;
    }
  });
  let received = 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await withUploadWriteSlot(undefined, () => handle.close());
  };
  try {
    for await (const chunk of chunks) {
      hooks?.accept?.(chunk, received);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await withUploadWriteSlot(hooks?.cancelled, () =>
          handle.write(chunk, offset, chunk.byteLength - offset, received + offset),
        );
        if (bytesWritten <= 0) throw new Error(`short write of ${path}`);
        offset += bytesWritten;
      }
      received += chunk.byteLength;
      hooks?.committed?.(chunk, received);
    }
    await close();
    return received;
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * The off-loop twin of `writeExternalFile` for a content-addressed body: the
 * same `O_DSYNC` temp, published under its final name only while that name is
 * absent (a hard link refuses an existing target, so a concurrent twin never
 * rewrites it). It creates and registers nothing: the synchronous owner finds
 * the file in the tick that commits its row and registers the directory then,
 * under that commit's flusher barrier. Resolves whether this call published.
 */
export async function stageExternalFile(input: {
  dir: string;
  name: string;
  bytes: Uint8Array;
}): Promise<boolean> {
  const target = join(input.dir, input.name);
  if (
    await stat(target).then(
      () => true,
      () => false,
    )
  )
    return false;
  const temp = await writeStagedTemp(input.dir, input.name, input.bytes);
  try {
    await link(temp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Publish by hard link (finalize, SYNTHESIS_R5 §6.4): an existing target wins. */
export function linkExternalFile(
  registry: ExternalRegistry,
  input: { source: string; dir: string; name: string },
): ExternalFileReceipt {
  const target = join(input.dir, input.name);
  ensureDirectory(registry, input.dir);
  let written = false;
  try {
    linkSync(input.source, target);
    written = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw mapStoreError(error, `linking ${input.source} to ${target}`);
    }
  }
  return { path: target, generation: registry.registerExternal(input.dir), written };
}

/** Remove a file; a missing file is already removed. The directory is registered. */
export function unlinkExternalFile(registry: ExternalRegistry, path: string): number {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw mapStoreError(error, `unlinking ${path}`);
    }
  }
  return registry.registerExternal(dirname(path));
}

/** Create a directory (and register its parent, whose entry changed). */
export function ensureDirectory(registry: ExternalRegistry, dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  registry.registerExternal(dirname(dir));
}
