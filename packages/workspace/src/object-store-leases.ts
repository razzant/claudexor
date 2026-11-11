import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compareProcessBirth,
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  WorkspaceError,
  type KnownProcessIdentity,
} from "@claudexor/core";
import { noteCleanupFault } from "./cleanup-fault.js";
import { existsStrict } from "./fs-presence.js";

/*
 * Leases of the project object store (#535): the pending records that keep a
 * running import's objects from a concurrent prune, and the prune lock. Both
 * name their process by PID and, where the platform reports one, its kernel
 * birth, so a reused PID never keeps a lease alive.
 */

/** The store's private control directories (pending, roots, tmp, the prune lock). */
export function controlDir(store: string, name: string): string {
  return join(store, "claudexor", name);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A recorded process: its PID and, where the platform reports one, its kernel birth. */
interface ProcessOwner {
  pid: number;
  identity?: KnownProcessIdentity;
}

function selfOwner(): ProcessOwner {
  const identity = defaultProcessIdentityService.self();
  return { pid: process.pid, ...(identity.status === "known" ? { identity } : {}) };
}

/**
 * `alive`: the recorded process still runs (same PID and same kernel birth);
 * `dead`: it exited, or its PID now names another process; `unverified`: the
 * PID is in use but no birth was recorded or it cannot be read now.
 */
function ownerState(owner: { pid?: unknown; identity?: unknown }): "alive" | "dead" | "unverified" {
  const pid = Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processAlive(pid)) return "dead";
  if (!isKnownProcessIdentity(owner.identity)) return "unverified";
  const birth = compareProcessBirth(owner.identity, defaultProcessIdentityService.read(pid));
  if (birth === "same") return "alive";
  return birth === "unknown" ? "unverified" : "dead";
}

/** Milliseconds since `path` was last written; vanished paths are infinitely old. */
function ageOf(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Keep `path`'s mtime fresh while its holder runs (the bounded liveness of an
 * unverifiable owner); unref'd, so it never keeps a process alive. */
function renewWhileHeld(path: string, everyMs: number, held: () => boolean = () => true) {
  const timer = setInterval(() => {
    try {
      if (!held()) return;
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // Gone: its holder released it.
    }
  }, everyMs);
  timer.unref?.();
  return timer;
}

export interface PendingRoots {
  store: string;
  path: string;
  roots: string[];
  /** Renews the record's mtime while the import runs. */
  renewal?: ReturnType<typeof setInterval>;
}

/** Bound of a prune-lock wait before an import gives up. */
const PRUNE_WAIT_MS = 600_000;

/**
 * Two-flag protocol with prune: an import first records its pending roots, then
 * waits out a prune already holding the lock; a prune first takes the lock,
 * then yields when any live pending record exists. One of the two always sees
 * the other, so a prune never deletes an object a concurrent import relies on.
 * The record names this process by PID and kernel birth: it stays live for as
 * long as this process runs, however long the import takes.
 */
export async function beginPendingRoots(store: string, roots: string[]): Promise<PendingRoots> {
  const dir = controlDir(store, "pending");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${process.pid}-${randomUUID()}.json`);
  writeFileSync(
    path,
    JSON.stringify({ ...selfOwner(), created_at: new Date().toISOString(), roots }) + "\n",
    { mode: 0o600 },
  );
  const pending: PendingRoots = {
    store,
    path,
    roots,
    renewal: renewWhileHeld(path, PENDING_RENEW_MS),
  };
  try {
    const lock = controlDir(store, "prune.lock");
    // A holder verified once (by kernel birth) needs only a PID check per poll.
    let verified: string | undefined;
    const held = () => {
      const owner = existsSync(lock) ? readLockOwner(lock) : null;
      if (owner?.nonce && owner.nonce === verified && processAlive(Number(owner.pid))) return true;
      const live = pruneLockHeld(lock);
      verified = live ? owner?.nonce : undefined;
      return live;
    };
    for (let waited = 0; held(); waited += 100) {
      if (waited > PRUNE_WAIT_MS)
        throw new WorkspaceError("object store prune did not finish in time");
      await sleep(100);
    }
    return pending;
  } catch (error) {
    noteCleanupFault(error, endPendingRoots(pending));
    throw error;
  }
}

/**
 * End a pending lease. Never throws: what the leased operation answered stays its
 * answer, and its caller's remaining cleanup still runs. A record that cannot be
 * removed (a directory that refuses the unlink) is not released: it stays, naming
 * this process, and a prune counts it as it counts any record (see
 * `livePendingRecords`), so it can only delay pruning. Returns that removal fault
 * as the caller's cleanup diagnostic, else undefined.
 */
export function endPendingRoots(pending: PendingRoots | null | undefined): unknown {
  if (!pending) return undefined;
  if (pending.renewal) clearInterval(pending.renewal);
  try {
    rmSync(pending.path, { force: true });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The prune lock's owner: a pruning process plus a nonce naming this one hold. */
interface PruneLockOwner extends ProcessOwner {
  nonce: string;
}

function readLockOwner(lock: string): Partial<PruneLockOwner> | null {
  try {
    const owner: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
    return owner && typeof owner === "object" ? (owner as Partial<PruneLockOwner>) : null;
  } catch {
    return null;
  }
}

/** A lock appears whole (owner included) by one rename; one without an owner
 * is debris of an interrupted writer, held only while this young. */
const LOCK_SETTLE_MS = 60_000;
/** A pruner renews its lock this often; an unverifiable holder silent for
 * LOCK_STALE_MS is gone (a verified live holder is never stale). */
const LOCK_RENEW_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;

function pruneLockHeld(lock: string): boolean {
  if (!existsSync(lock)) return false;
  const owner = readLockOwner(lock);
  if (owner === null) return ageOf(lock) < LOCK_SETTLE_MS;
  const state = ownerState(owner);
  return (
    state === "alive" || (state === "unverified" && ageOf(join(lock, "owner.json")) < LOCK_STALE_MS)
  );
}

/** Errors meaning "the lock path is taken" (a directory rename onto an existing one). */
const LOCK_TAKEN = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EISDIR"]);

/**
 * Take the prune lock atomically: the owner record is written into a private
 * directory that becomes the lock by one rename, so no reader ever sees a lock
 * without its owner. A stale lock (dead or reused-PID owner, or ownerless
 * debris) is moved aside by one rename — of racing reapers only one moves it —
 * and checked to be the lock judged stale before it is removed. Returns the
 * hold, or null when another live pruner holds the lock.
 */
export function acquirePruneLock(
  store: string,
): { stillHeld: () => boolean; release: () => void } | null {
  const lock = controlDir(store, "prune.lock");
  const tmp = controlDir(store, "tmp");
  mkdirSync(tmp, { recursive: true });
  const nonce = randomUUID();
  const staged = join(tmp, `prune-lock-${nonce}`);
  mkdirSync(staged);
  try {
    writeFileSync(join(staged, "owner.json"), JSON.stringify({ ...selfOwner(), nonce }) + "\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // An existing (even empty) lock is never replaced by the rename below.
      if (!existsSync(lock)) {
        try {
          renameSync(staged, lock);
          const stillHeld = () => readLockOwner(lock)?.nonce === nonce;
          const renewal = renewWhileHeld(join(lock, "owner.json"), LOCK_RENEW_MS, stillHeld);
          return {
            stillHeld,
            release: () => {
              clearInterval(renewal);
              if (stillHeld()) rmSync(lock, { recursive: true, force: true });
            },
          };
        } catch (error) {
          if (!LOCK_TAKEN.has((error as NodeJS.ErrnoException).code ?? "") || !existsSync(lock))
            throw error;
        }
      }
      if (pruneLockHeld(lock)) return null;
      const judged = readLockOwner(lock)?.nonce;
      const aside = join(tmp, `prune-lock-stale-${randomUUID()}`);
      try {
        renameSync(lock, aside);
      } catch {
        return null; // another pruner reaped or replaced it first
      }
      if (readLockOwner(aside)?.nonce !== judged) {
        // A fresh lock replaced the stale one meanwhile: hand it back and yield.
        try {
          renameSync(aside, lock);
        } catch {
          // The slot is taken again; that holder's own checks see the change.
        }
        return null;
      }
      rmSync(aside, { recursive: true, force: true });
    }
    return null;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

/** Without a readable kernel birth a pending record is live this long after
 * its last renewal, so a leaked record can delay pruning but never block it. */
const PENDING_MAX_AGE_MS = 60 * 60 * 1000;
const PENDING_RENEW_MS = 60_000;

export function livePendingRecords(store: string, graceMs: number): string[][] {
  const dir = controlDir(store, "pending");
  // Only ENOENT and ENOTDIR say there are none: an unreadable one may hold a live lease.
  if (!existsStrict(dir)) return [];
  const live: string[][] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      const age = Date.now() - statSync(path).mtimeMs;
      // A running import has no wall-clock limit: its record stays live while
      // its own process (PID and kernel birth) runs. A dead owner's or a
      // reused PID's record is reclaimed once past the grace window.
      const state = ownerState(record);
      if (
        age < graceMs ||
        state === "alive" ||
        (state === "unverified" && age < PENDING_MAX_AGE_MS)
      )
        live.push(record.roots ?? []);
      else unlinkSync(path);
    } catch {
      // A record being written is young: it counts as live. An unreadable one
      // past the maximum age is debris and must not block pruning forever.
      const age = (() => {
        try {
          return Date.now() - statSync(path).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (age < PENDING_MAX_AGE_MS) live.push([]);
      else rmSync(path, { force: true });
    }
  }
  return live;
}
