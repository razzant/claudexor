import type { Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { allocatedBytes } from "@claudexor/workspace";

/** Count an inode only when its last link is scheduled for removal. Dry runs
 * accumulate planned unlinks across trees; real deletion observes updated link counts. */
export async function treeReclaimableBytes(
  root: string,
  removed: Map<string, number>,
  signal?: AbortSignal,
): Promise<number> {
  let total = 0;
  const count = (info: Stats) => {
    const key = `${info.dev}:${info.ino}`;
    const links = (removed.get(key) ?? 0) + 1;
    removed.set(key, links);
    // Allocated bytes where the block count is evidence of them (a sparse file
    // frees only what it holds), else the logical length. Extents shared by a
    // copy-on-write clone are still counted in full, so the figure may overstate.
    if (links === info.nlink) total += allocatedBytes(info) ?? info.size;
  };
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        count(await stat(path));
      }
    }
  };
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (rootInfo.isDirectory()) await walk(root);
  else if (rootInfo.isFile()) count(rootInfo);
  return total;
}
