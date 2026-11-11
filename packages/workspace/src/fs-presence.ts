import { lstatSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

const absence = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Whether something is at `path`, following a symlink as `existsSync` does, but
 * with only ENOENT and ENOTDIR read as absence: any other failure is thrown. */
export function existsStrict(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (absence(error)) return false;
    throw error;
  }
}

/**
 * What lstat finds at `path`, or undefined when nothing is there: no entry
 * (ENOENT), or a parent that is not a directory (ENOTDIR). Any other failure (a
 * parent that cannot be searched, an I/O error) says nothing about presence and is
 * thrown, never read as absence.
 */
export function lstatPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (absence(error)) return undefined;
    throw error;
  }
}

/** Whether `path` below `root` is a file or symlink Git can reach: no parent is a
 * symlink or a file. Presence reads as {@link lstatPresent}: anything but ENOENT and
 * ENOTDIR is thrown, never read as absence. */
export function reachableFile(root: string, path: string): boolean {
  const parts = path.split("/");
  for (let at = 1; at < parts.length; at += 1)
    if (!lstatPresent(join(root, ...parts.slice(0, at)))?.isDirectory()) return false;
  const stat = lstatPresent(join(root, path));
  return stat !== undefined && !stat.isDirectory();
}
