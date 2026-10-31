import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GitDeliveryPair } from "@claudexor/schema";
import { WorkspaceError } from "@claudexor/core";
import { existsStrict } from "./fs-presence.js";
import { controlDir } from "./object-store-leases.js";
import { runFilesExpired } from "./run-expiry.js";

/**
 * Durable custody: a root record names the objects it keeps and the path that
 * owns them (a run directory, a thread directory, an envelope, an anchor). It
 * is live while its owner exists, so retention of the owner is retention of its
 * objects, and roots are durable the moment an import is verified (no caller
 * has to finish later). A run directory retention retired keeps only
 * `tombstone.yaml`: its payload is gone, and so is its custody. A record appears
 * whole by one rename: one torn by a crash or a full disk would refuse every
 * later prune of its project.
 */
export function writeRootRecord(
  store: string,
  owner: string,
  roots: string[],
  pair?: GitDeliveryPair,
): string {
  const dir = controlDir(store, "roots");
  const tmp = controlDir(store, "tmp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`;
  const staged = join(tmp, `root-${name}`);
  try {
    writeFileSync(
      staged,
      JSON.stringify({
        owner,
        roots,
        created_at: new Date().toISOString(),
        ...(pair ? { pair } : {}),
      }) + "\n",
      { mode: 0o600 },
    );
    renameSync(staged, join(dir, name));
  } finally {
    rmSync(staged, { force: true });
  }
  return join(dir, name);
}

/**
 * The newest delivery pair kept under `owner` whose post-tree is `postTree`:
 * a delivery retains its pair before it writes, so a replay that finds the
 * result already applied (its caller died before recording it) recovers the
 * pair revert needs. Null when no such record exists; a record directory that
 * cannot be looked at throws, since it may hold that pair.
 */
export function retainedPairOf(
  store: string,
  owner: string,
  postTree: string,
): GitDeliveryPair | null {
  const dir = controlDir(store, "roots");
  if (!existsStrict(dir)) return null;
  let newest: { at: number; pair: GitDeliveryPair } | null = null;
  for (const name of readdirSync(dir)) {
    let record: { owner?: unknown; pair?: unknown; created_at?: unknown };
    try {
      record = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (record.owner !== owner || record.pair === undefined) continue;
    const pair = GitDeliveryPair.safeParse(record.pair);
    if (!pair.success || pair.data.post_tree !== postTree) continue;
    const at = Date.parse(String(record.created_at));
    if (!newest || at >= newest.at) newest = { at, pair: pair.data };
  }
  return newest?.pair ?? null;
}

/** An owner path that still holds custody: it exists and is not a retired run. */
function ownerHoldsCustody(owner: string, retired: ReadonlySet<string>): boolean {
  if (retired.has(owner)) return false;
  try {
    return existsStrict(owner) && !runFilesExpired(owner);
  } catch {
    // An owner whose presence or retirement cannot be read (only ENOENT and ENOTDIR
    // say it is gone) keeps its objects.
    return true;
  }
}

/** Roots of every record whose owner still holds custody; dead records are
 * removed unless `dryRun`. `retired` names owners a retention pass retires now
 * (a dry run has not written their tombstones, yet must count the same set). */
export function liveRootRecords(
  store: string,
  dryRun = false,
  retired: ReadonlySet<string> = new Set(),
): string[] {
  const dir = controlDir(store, "roots");
  // A record directory that cannot be looked at may name live roots: it throws.
  if (!existsStrict(dir)) return [];
  const roots: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let record: { owner?: unknown; roots?: unknown };
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Unreadable custody is never treated as absent: keep everything it could name.
      throw new WorkspaceError(`object store root record ${path} is unreadable; pruning refused`);
    }
    if (typeof record.owner === "string" && ownerHoldsCustody(record.owner, retired)) {
      if (Array.isArray(record.roots))
        for (const root of record.roots) if (typeof root === "string") roots.push(root);
    } else if (!dryRun) unlinkSync(path);
  }
  return roots;
}
