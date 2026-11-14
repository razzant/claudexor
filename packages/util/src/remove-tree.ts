import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { withPoolWriteSlot } from "./libuv-pool.js";

export interface RemoveTreeOptions {
  /** Node's `rm` retries for EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM. They
   * wait on a timer, never on the thread; Node applies them only with
   * `recursive`, which on a single file still removes just that file. */
  maxRetries?: number;
  retryDelay?: number;
  /** A root entry a crash recovery reads to recognize the tree (an envelope's
   * `owner.json`): removed after every other entry, just before the root. */
  lastEntry?: string;
}

/** The path no longer names an entry (ENOTDIR: a parent was replaced meanwhile). */
const gone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Remove `root` and everything under it without waiting on the main thread:
 * depth first and one entry at a time, which is `rmSync`'s own order moved off
 * the thread (a recursive `fs.promises.rm` of a directory starts every child at
 * once and fills the libuv pool). Inside each directory its subdirectories go
 * first and its own entries after them, so the root's own entries (an
 * envelope's markers, `lastEntry` last of all) are the last to go: a crash
 * mid-delete leaves a tree its recovery still recognizes. A root that is a link
 * is removed as a link, never followed. An entry that is already gone is no
 * failure; any other failure stops the walk and rejects. Each removal holds one
 * slot of the pool write gate for that call alone; listings are reads, ungated.
 */
export async function removeTree(root: string, options: RemoveTreeOptions = {}): Promise<void> {
  const rmOptions = {
    recursive: true,
    force: true,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.retryDelay !== undefined ? { retryDelay: options.retryDelay } : {}),
  };
  const remove = async (path: string): Promise<void> => {
    try {
      await withPoolWriteSlot(undefined, () => rm(path, rmOptions));
    } catch (error) {
      if (!gone(error)) throw error;
    }
  };
  const empty = async (dir: string, last?: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      await empty(path);
      await remove(path);
    }
    const own = entries.filter((entry) => !entry.isDirectory());
    for (const entry of [
      ...own.filter((e) => e.name !== last),
      ...own.filter((e) => e.name === last),
    ])
      await remove(join(dir, entry.name));
  };
  let directory: boolean;
  try {
    directory = (await lstat(root)).isDirectory();
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  if (directory) await empty(root, options.lastEntry);
  await remove(root);
}
