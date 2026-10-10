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
import { dirname, join } from "node:path";
import { mapStoreError } from "./errors.js";

/** The one thing an external-file writer needs from the store. */
export interface ExternalRegistry {
  registerExternal(dir: string): number;
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
 * target is never rewritten.
 */
export function writeExternalFile(
  registry: ExternalRegistry,
  input: { dir: string; name: string; bytes: Uint8Array; keepExisting?: boolean },
): ExternalFileReceipt {
  const target = join(input.dir, input.name);
  if (input.keepExisting && existsSync(target)) {
    return { path: target, generation: registry.registerExternal(input.dir), written: false };
  }
  ensureDirectory(registry, input.dir);
  const temp = join(input.dir, `.${input.name}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
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
    if (input.keepExisting && existsSync(target)) {
      unlinkSync(temp);
      return { path: target, generation: registry.registerExternal(input.dir), written: false };
    }
    renameSync(temp, target);
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
