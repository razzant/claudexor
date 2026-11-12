import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The awaited twin of `ensureDir`: same creation mode, off the main thread. */
export async function ensureDirAsync(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * The awaited twin of `writeText`, for callers that are already async (lane
 * start, run end). Like `writeText` and `appendLine`, the parent directory is
 * created only when the write proves it missing, so a steady-state write is one
 * file write and no mkdir.
 */
export async function writeTextAsync(path: string, text: string): Promise<void> {
  const options = { encoding: "utf8", mode: 0o600 } as const;
  try {
    await writeFile(path, text, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    await ensureDirAsync(dirname(path));
    await writeFile(path, text, options);
  }
}
