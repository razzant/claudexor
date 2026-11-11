import { lstatSync, readdirSync, rmdirSync, utimesSync } from "node:fs";
import { join } from "node:path";

type Containers = { readonly [name: string]: Containers };
// Only namespace skeletons owned by retention. Wildcards stop at task/thread
// containers: attempts, runs, lane homes and thread worktrees belong to their
// lifecycle owners, including when those payloads happen to be empty.
const CONTAINERS: Containers = {
  runs: { ".retiring": {} },
  patches: {},
  anchors: { objects: {} },
  workspaces: { "*": {} },
  lanes: { "*": {} },
  threads: {},
};

/** Snapshot age before child removals; rmdir is the final emptiness proof.
 * No payloads, repositories, links or tombstones are walked. */
export function pruneEmptyRuntimeDirectories(
  root: string,
  startedAt: number,
  onError: (path: string, error: unknown) => void,
): boolean {
  const visit = (path: string, containers: Containers): boolean => {
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) return false;
      const entries = readdirSync(path, { withFileTypes: true });
      const names = new Set(entries.map((entry) => entry.name));
      if (
        names.has("tombstone.yaml") ||
        names.has(".git") ||
        (names.has("HEAD") && names.has("objects"))
      )
        return false;
      let changed = false;
      let expectedMtime = stat.mtimeMs;
      for (const entry of entries) {
        const child = Object.hasOwn(containers, entry.name)
          ? containers[entry.name]
          : containers["*"];
        if (!entry.isDirectory() || !child) continue;
        if (visit(join(path, entry.name), child)) {
          changed = true;
          names.delete(entry.name);
          expectedMtime = lstatSync(path).mtimeMs;
        }
      }
      // A just-created directory may be rounded down on a coarse filesystem.
      if (stat.mtimeMs >= startedAt - 2000) return false;
      if (names.size && !changed) return false;
      const current = lstatSync(path);
      if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino)
        return false;
      if (names.size || (changed && readdirSync(path).length)) {
        // Restore age after our child removals without attempting a doomed rmdir.
        if (changed && current.mtimeMs === expectedMtime) utimesSync(path, stat.atime, stat.mtime);
        return false;
      }
      try {
        rmdirSync(path);
        return true;
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        // Child removal alone must not renew the surviving container's age.
        if (changed && current.mtimeMs === expectedMtime) utimesSync(path, stat.atime, stat.mtime);
      }
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
        onError(path, error);
    }
    return false;
  };
  return visit(root, CONTAINERS);
}
