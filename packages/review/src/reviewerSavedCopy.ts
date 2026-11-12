import { lstatSync, statfsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { UninspectableReviewerFile } from "./reviewRuntimeTypes.js";

// A reviewer's copy of a result's saved files (#535): only the changed files, of
// any size. It is checked for room first, and a disk that fills on the way names
// what the copy cannot hold instead of ending the run.

/** Room kept free beyond a copy's own bytes. */
const COPY_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export const isSpaceError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
};

/** The bytes of the regular files under `dir` (a saved copy: only changed files). */
export async function regularBytes(dir: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) bytes += await regularBytes(path);
    else if (entry.isFile()) bytes += (await stat(path)).size;
  }
  return bytes;
}

/** Whether `bytes` fit where `dir` lives with the margin; a volume that cannot say refuses nothing. */
export function roomFor(dir: string, bytes: number): boolean {
  try {
    const stats = statfsSync(dir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return !Number.isFinite(free) || free >= bytes + COPY_SPACE_MARGIN_BYTES;
  } catch {
    return true;
  }
}

/**
 * The saved files a copy that ran out of room does not hold whole: absent, or shorter
 * than their source (the one being written). Such a file is removed, so no reviewer
 * reads part of one as the result's content, and named `space_insufficient`, so the
 * review cannot pass clean. Paths already named for another reason stay as named.
 */
export async function notWhollyCopied(
  copy: {
    sourceRoot: string;
    root: string;
    /** Whether the copy's rules take this source path. */
    copied: (sourcePath: string) => boolean;
    named: readonly UninspectableReviewerFile[];
  },
  /** A reviewer-relative name for a source-relative path. */
  name: (rel: string) => string,
): Promise<UninspectableReviewerFile[]> {
  const { sourceRoot, root, copied, named } = copy;
  const known = new Set(named.map((file) => file.path));
  const missing: UninspectableReviewerFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const sourcePath = join(dir, entry.name);
      if (!copied(sourcePath)) continue;
      if (entry.isDirectory()) {
        await walk(sourcePath);
        continue;
      }
      const rel = relative(sourceRoot, sourcePath);
      const path = name(rel);
      const copy = lstatSync(join(root, rel), { throwIfNoEntry: false });
      const whole = entry.isFile()
        ? copy?.isFile() === true && copy.size === lstatSync(sourcePath).size
        : copy !== undefined;
      if (whole || known.has(path)) continue;
      await rm(join(root, rel), { force: true });
      missing.push({ path, reason: "space_insufficient" });
    }
  };
  await walk(sourceRoot);
  return missing;
}
