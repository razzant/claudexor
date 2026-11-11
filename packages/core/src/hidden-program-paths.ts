import { lstatSync, renameSync, rmSync } from "node:fs";

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Hide, observe, then retire. A fixed sibling can also resume an interrupted hide.
 * Callers prove ownership and fence path changes before entering this operation. */
export function hideProgramPaths(paths: ReadonlyArray<{ path: string; hidden: string }>) {
  const moved: Array<{ path: string; hidden: string }> = [];
  const restore = () => {
    for (const { path, hidden } of [...moved].reverse()) {
      if (present(path))
        throw new Error(`Cannot restore hidden program over a replacement: ${path}`);
      renameSync(hidden, path);
    }
  };
  try {
    for (const entry of paths) {
      if (present(entry.hidden)) {
        if (present(entry.path))
          throw new Error(`Both program and hidden copy exist: ${entry.path}`);
      } else renameSync(entry.path, entry.hidden);
      moved.push(entry);
    }
  } catch (error) {
    restore();
    throw error;
  }
  return {
    restore,
    retire() {
      const removed: string[] = [],
        limitations: string[] = [];
      for (const { path, hidden } of moved) {
        try {
          rmSync(hidden, { recursive: true });
          removed.push(path);
        } catch {
          limitations.push(`Unused program bytes could not be pruned at ${hidden}`);
        }
      }
      return { removed, limitations };
    },
  };
}
