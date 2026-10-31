import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { GitDeliveryPair, GitObjectFormat } from "@claudexor/schema";
import { WorkspaceError } from "@claudexor/core";
import { projectRuntimeDir } from "@claudexor/util";
import { gitObserved, GitOperationError } from "./git-observed.js";
import { repositoryObjectFormat, repositoryObjectFormatOrNull } from "./git-result.js";
import { liveRootRecords, retainedPairOf, writeRootRecord } from "./object-store-roots.js";
import {
  acquirePruneLock,
  beginPendingRoots,
  controlDir,
  endPendingRoots,
  livePendingRecords,
} from "./object-store-leases.js";
import {
  missingObjects,
  packIndexObjectIds,
  transferObjects,
  type ObjectEndpoint,
  type TransferResult,
} from "./object-transfer.js";

/**
 * The project object store (D): one private bare repository per project under
 * Claudexor's runtime directory. It is NEVER an alternate of the user's
 * repository; user-repo operations import exactly the objects they need first.
 * Objects enter after capture and after delivery and are verified against the
 * store alone. Retention prunes by reachability from recorded roots.
 */
export function objectStorePath(projectRoot: string): string {
  return join(projectRuntimeDir(projectRoot), "git-store");
}

export { beginPendingRoots, endPendingRoots, type PendingRoots } from "./object-store-leases.js";

const HASH_LENGTH: Record<GitObjectFormat, 20 | 32> = { sha1: 20, sha256: 32 };

/** Git sees the store alone: no alternates, no repository discovery, no locks on reads. */
export function storeEnv(store: string): Record<string, string> {
  return {
    GIT_DIR: store,
    GIT_OBJECT_DIRECTORY: join(store, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export function storeEndpoint(store: string): ObjectEndpoint {
  return { cwd: store, env: storeEnv(store), objectsDir: join(store, "objects") };
}

/** The user's repository as a transfer endpoint (its own object directory). */
export async function repositoryEndpoint(repo: string): Promise<ObjectEndpoint> {
  const objects = await gitObserved(
    repo,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
    { label: "rev-parse objects" },
  );
  return { cwd: repo, env: { GIT_OPTIONAL_LOCKS: "0" }, objectsDir: objects.stdout.trim() };
}

/** One in-flight initialization per store in this process. */
const initializing = new Map<string, Promise<void>>();

/** Initialize atomically: a complete store appears by one rename, so concurrent
 * captures (a best-of-n wave, another process) never see a half-made store. */
async function initializeStore(store: string, format: GitObjectFormat): Promise<void> {
  mkdirSync(dirname(store), { recursive: true, mode: 0o700 });
  const temp = `${store}.init-${process.pid}-${randomUUID()}`;
  try {
    await gitObserved(
      dirname(store),
      [
        "init",
        "--bare",
        "--quiet",
        "--template=",
        ...(format === "sha256" ? ["--object-format=sha256"] : []),
        temp,
      ],
      {
        env: {
          GIT_DIR: null,
          GIT_OBJECT_DIRECTORY: null,
          GIT_INDEX_FILE: null,
          GIT_WORK_TREE: null,
        },
        label: "init object store",
      },
    );
    // The store is only ever pruned by Claudexor's reachability pass.
    await gitObserved(temp, ["config", "gc.auto", "0"], { env: storeEnv(temp), label: "config" });
    for (const name of ["pending", "tmp", "roots"])
      mkdirSync(controlDir(temp, name), { recursive: true });
    try {
      renameSync(temp, store);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** The object format a project keeps: its store's, else its own repository's;
 * null for a project in no Git repository that has no store yet. */
async function projectObjectFormat(projectRoot: string): Promise<GitObjectFormat | null> {
  const store = objectStorePath(projectRoot);
  if (existsSync(join(store, "objects")) && existsSync(join(store, "HEAD")))
    return repositoryObjectFormat(store, storeEnv(store));
  return repositoryObjectFormatOrNull(projectRoot);
}

const formatRefusal = (projectRoot: string, kept: GitObjectFormat, format: GitObjectFormat) =>
  `this repository uses ${format} Git objects, but project ${projectRoot} keeps ${kept} objects (one project keeps one object format); refused before anything was written`;

/**
 * One store serves all of a project's execution roots, so one project keeps one
 * Git object format: a repository of the other one is refused, typed and naming
 * both, before any of its objects, or a store of its format, is made or mounted.
 */
export async function assertProjectObjectFormat(
  projectRoot: string,
  format: GitObjectFormat,
): Promise<void> {
  const kept = await projectObjectFormat(projectRoot);
  if (kept !== null && kept !== format)
    throw new GitOperationError("capture_failed", formatRefusal(projectRoot, kept, format));
}

export async function ensureObjectStore(
  projectRoot: string,
  objectFormat?: GitObjectFormat,
): Promise<{ store: string; objectFormat: GitObjectFormat }> {
  const store = objectStorePath(projectRoot);
  const format = objectFormat ?? (await repositoryObjectFormat(projectRoot));
  if (!existsSync(join(store, "objects")) || !existsSync(join(store, "HEAD"))) {
    // A store takes its project's format, never one a foreign repository brings.
    await assertProjectObjectFormat(projectRoot, format);
    const pending = initializing.get(store) ?? initializeStore(store, format);
    initializing.set(store, pending);
    try {
      await pending;
    } finally {
      if (initializing.get(store) === pending) initializing.delete(store);
    }
  }
  if (existsSync(join(store, "objects", "info", "alternates")))
    throw new WorkspaceError(`object store ${store} has alternates; refusing to use it`);
  const stored = await repositoryObjectFormat(store, storeEnv(store));
  if (stored !== format)
    throw new GitOperationError("capture_failed", formatRefusal(projectRoot, stored, format));
  for (const name of ["pending", "tmp", "roots"])
    mkdirSync(controlDir(store, name), { recursive: true });
  return { store, objectFormat: format };
}

export { liveRootRecords, writeRootRecord } from "./object-store-roots.js";

/** The newest delivery pair kept under `owner` whose post-tree is `postTree` (see retainedPairOf). */
export function retainedDeliveryPair(
  projectRoot: string,
  owner: string,
  postTree: string,
): GitDeliveryPair | null {
  return retainedPairOf(objectStorePath(projectRoot), owner, postTree);
}

/** Objects reachable from `roots` minus the boundary commit and its tree, listed in a source. */
async function closureBeyond(
  source: ObjectEndpoint,
  roots: readonly string[],
  boundary: { commit: string; tree: string } | null,
): Promise<string[]> {
  if (roots.length === 0) return [];
  // A negative commit stops commit walks; a negative tree excludes its contents
  // even for a bare-tree start (rev-list marks a lone `--not <commit>` tree only
  // through walked commits).
  const args = [
    "rev-list",
    "--objects",
    ...roots,
    ...(boundary ? ["--not", boundary.commit, boundary.tree] : []),
  ];
  const listed = await gitObserved(source.cwd, args, {
    env: source.env,
    label: "rev-list --objects",
  });
  return [
    ...new Set(
      listed.stdout
        .split("\n")
        .map((line) => line.split(" ")[0]!)
        .filter(Boolean),
    ),
  ];
}

export interface RetainResult extends TransferResult {
  store: string;
  objects: number;
  /** The durable root record now owning these objects. */
  rootRecord: string;
}

/**
 * Copy what a result needs beyond its boundary into the project store, verify
 * it against the store alone, then record its roots durably under `owner`. A
 * pending record covers the import itself (two-flag protocol with prune).
 */
export async function retainInObjectStore(input: {
  projectRoot: string;
  source: ObjectEndpoint;
  roots: string[];
  boundary: { commit: string; tree: string } | null;
  objectFormat: GitObjectFormat;
  /** Path whose existence keeps these roots live (a run or thread directory). */
  owner: string;
  /** The delivery pair these roots keep, recorded for a later replay. */
  pair?: GitDeliveryPair;
}): Promise<RetainResult> {
  const { store } = await ensureObjectStore(input.projectRoot, input.objectFormat);
  const pending = await beginPendingRoots(store, input.roots);
  try {
    const needed = await closureBeyond(input.source, input.roots, input.boundary);
    const target = storeEndpoint(store);
    const transfer = await transferObjects(
      input.source,
      target,
      needed,
      HASH_LENGTH[input.objectFormat],
    );
    const absent = await missingObjects(target, needed);
    if (absent.length > 0) {
      throw new GitOperationError(
        "capture_object_missing",
        `${absent.length} object(s) did not reach the project store (first ${absent[0]})`,
      );
    }
    const rootRecord = writeRootRecord(store, input.owner, input.roots, input.pair);
    return { ...transfer, store, objects: needed.length, rootRecord };
  } finally {
    endPendingRoots(pending);
  }
}

export interface RepositoryImport extends TransferResult {
  /** Objects neither the user's repository nor the project store holds. */
  missing: string[];
  /** The store keeps objects of another format than the repository's: it was not read. */
  formatMismatch?: { kept: GitObjectFormat; repository: GitObjectFormat };
}

/** Interior objects a traversal from present roots reports missing (`?oid`). */
async function missingInterior(
  endpoint: ObjectEndpoint,
  roots: readonly string[],
): Promise<string[]> {
  if (roots.length === 0) return [];
  const listed = await gitObserved(
    endpoint.cwd,
    ["rev-list", "--objects", "--no-walk", "--missing=print", ...roots],
    { env: endpoint.env, label: "rev-list --missing=print" },
  );
  return listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("?"))
    .map((line) => line.slice(1).trim());
}

/** Objects a read-only check cannot reach through `endpoint`: missing roots, else
 * what a traversal from them reports missing (nothing is imported). */
export async function unreachableObjects(
  endpoint: ObjectEndpoint,
  roots: readonly string[],
): Promise<string[]> {
  const absent = await missingObjects(endpoint, roots);
  return absent.length > 0 ? absent : missingInterior(endpoint, roots);
}

/**
 * D(1): before a traversal, the start objects are checked with `cat-file --batch-check`;
 * a missing one is imported from the store (rev-list cannot start from a missing
 * object). The traversal then reports missing interior objects, imported the
 * same way, round by round, until none is left or neither side has them.
 */
export async function importIntoRepository(input: {
  projectRoot: string;
  repo: string;
  roots: string[];
}): Promise<RepositoryImport> {
  const user = await repositoryEndpoint(input.repo);
  const format = await repositoryObjectFormat(input.repo);
  const storePath = objectStorePath(input.projectRoot);
  const kept = existsSync(join(storePath, "objects"))
    ? await repositoryObjectFormat(storePath, storeEnv(storePath))
    : null;
  // A store of the other format is never read into this repository.
  const store = kept === format ? storeEndpoint(storePath) : null;
  const total: RepositoryImport = {
    linkedPacks: 0,
    linkedLoose: 0,
    streamedObjects: 0,
    copiedBytes: 0,
    missing: [],
    ...(kept && kept !== format ? { formatMismatch: { kept, repository: format } } : {}),
  };
  const unavailable = new Set<string>();
  const roots = [...new Set(input.roots)];
  let wanted = await missingObjects(user, roots);
  // Each round imports what the last traversal reported; a missing tree hides
  // its children until it arrives, so depth bounds the rounds.
  for (let round = 0; round < 1024; round += 1) {
    if (wanted.length > 0) {
      const absentInStore = store ? new Set(await missingObjects(store, wanted)) : new Set(wanted);
      const fromStore = wanted.filter((oid) => !absentInStore.has(oid));
      for (const oid of absentInStore) unavailable.add(oid);
      if (store && fromStore.length > 0) {
        const moved = await transferObjects(store, user, fromStore, HASH_LENGTH[format]);
        total.linkedPacks += moved.linkedPacks;
        total.linkedLoose += moved.linkedLoose;
        total.streamedObjects += moved.streamedObjects;
        total.copiedBytes += moved.copiedBytes;
      }
    }
    const starts = roots.filter((oid) => !unavailable.has(oid));
    const interior = (await missingInterior(user, starts)).filter((oid) => !unavailable.has(oid));
    if (interior.length === 0) break;
    wanted = interior;
  }
  total.missing = [...unavailable].sort();
  return total;
}

/** Unreferenced store objects younger than this are never pruned. */
export const OBJECT_STORE_GRACE_MS = 60 * 60 * 1000;

/** The walk over loose objects gives the event loop a turn this often. */
const PRUNE_ENTRIES_PER_TURN = 2_048;

/** Retention's entry: prune one project runtime directory's store, if it has one.
 * `retiredOwners`: run directories this pass retires (a dry run included). */
export async function pruneProjectObjectStore(
  runtimeDir: string,
  options: { dryRun: boolean; graceMs?: number; retiredOwners?: ReadonlySet<string> },
): Promise<{ freedBytes: number; yielded: boolean }> {
  const store = join(runtimeDir, "git-store");
  if (!existsSync(join(store, "objects"))) return { freedBytes: 0, yielded: false };
  return pruneObjectStore({
    store,
    graceMs: options.graceMs ?? OBJECT_STORE_GRACE_MS,
    dryRun: options.dryRun,
    objectFormat: await repositoryObjectFormat(store, storeEnv(store)),
    ...(options.retiredOwners ? { retiredOwners: options.retiredOwners } : {}),
  });
}

/** Plain-file mtime of an object's container (its loose file or its pack). */
function containerAge(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Prune the store by reachability: keep everything reachable from `roots` plus
 * live pending records, and everything younger than `graceMs`. Packs whose
 * objects are all unreachable and old are removed; mixed old packs are
 * rewritten with their kept objects. Returns the bytes freed. A pass that finds
 * a live import yields without deleting anything.
 */
export async function pruneObjectStore(input: {
  store: string;
  /** Extra live roots beyond the store's own live root records. */
  roots?: readonly string[];
  graceMs: number;
  dryRun?: boolean;
  objectFormat: GitObjectFormat;
  /** Owners retired by the calling retention pass (see liveRootRecords). */
  retiredOwners?: ReadonlySet<string>;
}): Promise<{ freedBytes: number; yielded: boolean }> {
  const { store } = input;
  if (!existsSync(join(store, "objects"))) return { freedBytes: 0, yielded: false };
  const hold = acquirePruneLock(store);
  if (!hold) return { freedBytes: 0, yielded: true };
  try {
    // Any live import may rely on an old object it found present: yield.
    if (livePendingRecords(store, input.graceMs).length > 0)
      return { freedBytes: 0, yielded: true };
    const endpoint = storeEndpoint(store);
    const roots = [
      ...new Set([
        ...(input.roots ?? []),
        ...liveRootRecords(store, input.dryRun, input.retiredOwners),
      ]),
    ];
    const absentRoots = new Set(await missingObjects(endpoint, roots));
    const starts = roots.filter((oid) => !absentRoots.has(oid));
    const live = new Set<string>();
    if (starts.length > 0) {
      const listed = await gitObserved(
        store,
        ["rev-list", "--objects", "--no-walk", "--missing=allow-any", ...starts],
        { env: endpoint.env, label: "rev-list reachable" },
      );
      for (const line of listed.stdout.split("\n")) if (line) live.add(line.split(" ")[0]!);
    }
    const cutoff = Date.now() - input.graceMs;
    let freedBytes = 0;
    const objectsDir = join(store, "objects");
    // A lock lost to a reaper (this process was judged stale) deletes nothing more.
    if (!hold.stillHeld()) return { freedBytes: 0, yielded: true };
    // Private scratch (staged locks, repacks) an interrupted process left behind.
    if (!input.dryRun)
      for (const name of readdirSync(controlDir(store, "tmp")))
        if (containerAge(join(controlDir(store, "tmp"), name)) < cutoff)
          rmSync(join(controlDir(store, "tmp"), name), { recursive: true, force: true });
    let walked = 0;
    for (const fan of readdirSync(objectsDir)) {
      if (fan.startsWith("tmp_") && containerAge(join(objectsDir, fan)) < cutoff) {
        // Publication staging an interrupted transfer left behind.
        if (!input.dryRun) rmSync(join(objectsDir, fan), { recursive: true, force: true });
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(fan)) continue;
      for (const rest of readdirSync(join(objectsDir, fan))) {
        walked += 1;
        if (walked % PRUNE_ENTRIES_PER_TURN === 0) {
          await nextTurn();
          if (!hold.stillHeld()) return { freedBytes, yielded: true };
        }
        const oid = fan + rest;
        const path = join(objectsDir, fan, rest);
        if (live.has(oid) || containerAge(path) >= cutoff) continue;
        freedBytes += statSync(path).size;
        if (!input.dryRun) unlinkSync(path);
      }
      if (!input.dryRun) {
        try {
          rmdirSync(join(objectsDir, fan));
        } catch {
          // Not empty.
        }
      }
    }
    const packDir = join(objectsDir, "pack");
    for (const name of existsSync(packDir) ? readdirSync(packDir) : []) {
      if (!name.endsWith(".idx")) continue;
      const idx = join(packDir, name);
      const pack = idx.slice(0, -4) + ".pack";
      if (!existsSync(pack) || containerAge(pack) >= cutoff) continue;
      const members = packIndexObjectIds(idx, HASH_LENGTH[input.objectFormat]);
      const kept = members.filter((oid) => live.has(oid));
      if (kept.length === members.length) continue;
      const size = statSync(pack).size + statSync(idx).size;
      if (input.dryRun) {
        freedBytes += kept.length === 0 ? size : 0;
        continue;
      }
      // The kept objects stream into a fresh pack before the old one goes.
      if (kept.length > 0) await repackKept(store, endpoint, kept, input.objectFormat);
      if (!hold.stillHeld()) return { freedBytes, yielded: true };
      unlinkSync(idx);
      unlinkSync(pack);
      freedBytes += size;
    }
    return { freedBytes, yielded: false };
  } finally {
    hold.release();
  }
}

async function repackKept(
  store: string,
  endpoint: ObjectEndpoint,
  kept: string[],
  objectFormat: GitObjectFormat,
): Promise<void> {
  // A staging directory that sees no store objects, so every kept object is
  // streamed (bounded memory) into one new pack, renamed into place (.idx last).
  const scratch = join(controlDir(store, "tmp"), `repack-${randomUUID()}`);
  mkdirSync(join(scratch, "objects", "pack"), { recursive: true });
  try {
    const staging: ObjectEndpoint = {
      cwd: store,
      env: { ...storeEnv(store), GIT_OBJECT_DIRECTORY: join(scratch, "objects") },
      objectsDir: join(scratch, "objects"),
    };
    await transferObjects(endpoint, staging, kept, HASH_LENGTH[objectFormat]);
    const names = readdirSync(join(scratch, "objects", "pack"));
    for (const suffix of [".pack", ".idx"])
      for (const name of names.filter((entry) => entry.endsWith(suffix)))
        renameSync(join(scratch, "objects", "pack", name), join(endpoint.objectsDir, "pack", name));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
