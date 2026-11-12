import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withPoolWriteSlot } from "./libuv-pool.js";

/** The awaited twin of `ensureDir`: same creation mode, off the main thread,
 * under one slot of the pool write gate. */
export async function ensureDirAsync(path: string): Promise<void> {
  await withPoolWriteSlot(undefined, () => mkdir(path, { recursive: true, mode: 0o700 }));
}

/**
 * The awaited twin of `writeText`, for callers that are already async (lane
 * start, run end). Like `writeText` and `appendLine`, the parent directory is
 * created only when the write proves it missing, so a steady-state write is one
 * file write and no mkdir. Each call holds its own pool write slot, never across
 * another await.
 */
export async function writeTextAsync(path: string, text: string): Promise<void> {
  const options = { encoding: "utf8", mode: 0o600 } as const;
  try {
    await withPoolWriteSlot(undefined, () => writeFile(path, text, options));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    await ensureDirAsync(dirname(path));
    await withPoolWriteSlot(undefined, () => writeFile(path, text, options));
  }
}

/** The awaited twin of `writeJson`: the same bytes (two-space JSON and a
 * newline), written as `writeTextAsync` writes. */
export async function writeJsonAsync(path: string, value: unknown): Promise<void> {
  await writeTextAsync(path, JSON.stringify(value, null, 2) + "\n");
}
