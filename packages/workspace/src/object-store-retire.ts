import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { controlDir } from "./object-store-leases.js";

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return ["unreadable"];
  }
}

function olderThan(path: string, cutoff: number): boolean {
  try {
    return statSync(path).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

/** No loose object, no pack, no pending import, no root record, nothing recent. */
function strictlyEmpty(store: string, cutoff: number): boolean {
  const objects = join(store, "objects");
  const pending = controlDir(store, "pending");
  const roots = controlDir(store, "roots");
  return (
    entries(pending).length === 0 &&
    entries(roots).length === 0 &&
    entries(objects).every((name) => name === "info" || name === "pack") &&
    entries(join(objects, "pack")).length === 0 &&
    [store, objects, pending, roots].every((path) => olderThan(path, cutoff))
  );
}

/**
 * Retire a STRICTLY empty engine-owned bare object store (#503), called by the
 * pruner while it still holds the store's prune lock and found no live root
 * record. The store is renamed aside in one step and rechecked there: when an
 * import recorded a pending lease or root meanwhile, it is put back and kept.
 * A later import creates a fresh store as for any project that never had one.
 * Returns whether the store is gone.
 */
export function retireEmptyObjectStore(store: string, cutoff: number): boolean {
  if (!existsSync(join(store, "objects")) || !strictlyEmpty(store, cutoff)) return false;
  const aside = `${store}.retired-${randomUUID()}`;
  try {
    renameSync(store, aside);
  } catch {
    return false;
  }
  if (
    entries(controlDir(aside, "pending")).length > 0 ||
    entries(controlDir(aside, "roots")).length > 0
  ) {
    try {
      renameSync(aside, store);
    } catch {
      // The path was taken by a fresh store meanwhile; the aside keeps its records.
    }
    return false;
  }
  rmSync(aside, { recursive: true, force: true });
  return true;
}

/**
 * A path that holds only the store's control directory and no repository: what
 * an import's lease leaves when it raced a retirement. It is never a store (a
 * store appears by one rename of a complete repository), so it is removed and
 * the caller initializes a fresh store in its place.
 */
export function clearStoreSkeleton(store: string): void {
  const names = entries(store);
  if (names.length > 0 && names.every((name) => name === "claudexor"))
    rmSync(store, { recursive: true, force: true });
}
