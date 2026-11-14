import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withPoolWriteSlot } from "./libuv-pool.js";

/** The awaited twin of `ensureDir`: same creation mode, off the main thread,
 * under one slot of the pool write gate. */
export async function ensureDirAsync(path: string): Promise<void> {
  await withPoolWriteSlot(undefined, () => mkdir(path, { recursive: true, mode: 0o700 }));
}

/** Distinct temporary siblings for concurrent writes of one path in this process. */
let replacements = 0;

/**
 * The awaited twin of `writeText`, for callers that are already async (lane
 * start, run end). The text is written to a temporary sibling, which is then
 * renamed over the file (a rename replaces an existing file on every platform
 * Node supports), so a reader sees the old text or the new one, never a
 * truncated or partial file. A file that existed keeps its permission bits; a
 * new one is created 0o600. Like `writeText` and `appendLine`, the parent
 * directory is created only when the write proves it missing, so a
 * steady-state write makes no mkdir. Each call holds its own pool write slot,
 * never across another await.
 */
export async function writeTextAsync(path: string, text: string): Promise<void> {
  const existing = await stat(path).then(
    (stats) => (stats.isFile() ? stats.mode & 0o7777 : null),
    () => null,
  );
  const mode = existing ?? 0o600;
  const tmp = `${path}.${process.pid}.${(replacements += 1)}.tmp`;
  const options = { encoding: "utf8", mode } as const;
  try {
    try {
      await withPoolWriteSlot(undefined, () => writeFile(tmp, text, options));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      await ensureDirAsync(dirname(path));
      await withPoolWriteSlot(undefined, () => writeFile(tmp, text, options));
    }
    // The creation mode passes through the process umask; the replaced file's
    // own bits are set exactly.
    if (existing !== null) await withPoolWriteSlot(undefined, () => chmod(tmp, existing));
    await withPoolWriteSlot(undefined, () => rename(tmp, path));
  } catch (error) {
    await withPoolWriteSlot(undefined, () => rm(tmp, { force: true })).catch(() => undefined);
    throw error;
  }
}

/** The awaited twin of `writeJson`: the same bytes (two-space JSON and a
 * newline), written as `writeTextAsync` writes. */
export async function writeJsonAsync(path: string, value: unknown): Promise<void> {
  await writeTextAsync(path, JSON.stringify(value, null, 2) + "\n");
}
