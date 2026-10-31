import { readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { lstatPresent } from "./fs-presence.js";
import type { RawRecord } from "./object-compose.js";

const ABSENT_MODE = "000000";

/** For the alias judge only: a path it cannot look at is no alias (the exemption is denied). */
const lstatOrNull = (path: string): Stats | undefined => {
  try {
    return lstatPresent(path);
  } catch {
    return undefined;
  }
};

/** A name as a volume that folds case reads it (normalization included). */
const fold = (path: string) => path.normalize("NFC").toLowerCase();

/**
 * Whether two tree paths name one directory entry through the filesystem's folding
 * of their spelling: they differ only by case, lstat finds one inode for both, and
 * they are not both spelled exactly as entries on disk. A hard link is an entry of
 * its own, spelled exactly, so two of its names never count as one. Directory
 * listings are read once, and only for such a prospective alias.
 */
export function aliasJudge(worktree: string): (path: string, other: string) => boolean {
  const listings = new Map<string, Set<string> | null>();
  const listing = (dir: string) => {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(readdirSync(join(worktree, dir))));
      } catch {
        listings.set(dir, null);
      }
    }
    return listings.get(dir);
  };
  const spelledExactly = (path: string) => {
    const parts = path.split("/");
    return parts.every((part, at) => listing(parts.slice(0, at).join("/"))?.has(part) === true);
  };
  return (path, other) => {
    if (path === other || fold(path) !== fold(other)) return false;
    const one = lstatOrNull(join(worktree, path));
    const two = lstatOrNull(join(worktree, other));
    if (!one || !two || one.dev !== two.dev || one.ino !== two.ino) return false;
    return !(spelledExactly(path) && spelledExactly(other));
  };
}

/** Paths keyed by their folded spelling. */
export function byFold(paths: Iterable<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const path of paths) map.set(fold(path), [...(map.get(fold(path)) ?? []), path]);
  return map;
}

/** Whether `path` is one of `paths` under another spelling (see {@link aliasJudge}). */
export function foldsOnto(
  judge: (path: string, other: string) => boolean,
  folded: ReadonlyMap<string, readonly string[]>,
  path: string,
): boolean {
  return (folded.get(fold(path)) ?? []).some((other) => judge(path, other));
}

/** What a directory holds that is not on its way out, as tree paths (empty ones hold nothing). */
function survivors(worktree: string, dir: string, removed: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(worktree, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...survivors(worktree, path, removed));
    else if (!removed.has(path)) found.push(path);
  }
  return found;
}

/**
 * What a checkout from one tree to another would destroy without Git knowing:
 * `read-tree -m -u` writes a path the first tree does not name over whatever is
 * there, and removes a file or symlink standing where it needs a directory. A
 * snapshot leaves ignored files out of that tree, so such a file is the user's and
 * no revert could bring it back. For each added path, one lstat of it and of each
 * parent it does not share with another; a directory holding what stays is only
 * walked when a file is about to take its name. A directory the path merely enters
 * loses nothing, and neither do the entries the same checkout removes. Only ENOENT
 * and ENOTDIR are absence: a path that cannot be looked at is thrown, so the write
 * and its dry run both refuse instead of reading it as free.
 */
export function occupiedPaths(worktree: string, records: readonly RawRecord[]): string[] {
  const removed = new Set(
    records.filter((record) => record.newMode === ABSENT_MODE).map((record) => record.src),
  );
  // Parents already looked at: a real directory is entered; anything else stops the walk.
  const parents = new Map<string, "enter" | "stop">();
  const occupied = new Set<string>();
  /** On a filesystem that folds case, a path about to go can answer for a new spelling. */
  const judge = aliasJudge(worktree);
  const leaving = byFold(removed);
  const isLeaving = (path: string) => foldsOnto(judge, leaving, path);
  const enterable = (parent: string): boolean => {
    const known = parents.get(parent);
    if (known) return known === "enter";
    const cut = parent.lastIndexOf("/");
    const reachable = cut <= 0 || enterable(parent.slice(0, cut));
    let answer: "enter" | "stop" = "stop";
    if (reachable) {
      const stat = lstatPresent(join(worktree, parent));
      if (stat?.isDirectory()) answer = "enter";
      else if (stat && !removed.has(parent) && !isLeaving(parent)) occupied.add(parent);
    }
    parents.set(parent, answer);
    return answer === "enter";
  };
  for (const record of records) {
    if (record.oldMode !== ABSENT_MODE) continue;
    const cut = record.src.lastIndexOf("/");
    if (cut > 0 && !enterable(record.src.slice(0, cut))) continue;
    const stat = lstatPresent(join(worktree, record.src));
    if (!stat) continue;
    if (stat.isDirectory()) {
      // A gitlink's own directory stays; a file taking its name would remove it.
      if (record.newMode !== "160000")
        for (const path of survivors(worktree, record.src, removed)) occupied.add(path);
    } else if (!isLeaving(record.src)) occupied.add(record.src);
  }
  return [...occupied];
}
