import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HarnessInstallLease {
  release(): void;
}

interface HarnessInstallLeaseOwner {
  pid: number;
  token: string;
}

export const HARNESS_INSTALL_LOCK_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_POLL_MS = 100;
const INSTALL_LOCK_OWNER_GRACE_MS = 5_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function readInstallLeaseOwner(path: string): HarnessInstallLeaseOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      return null;
    }
    return { pid: Number(value.pid), token: value.token };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function installLockError(path: string, stale: boolean): Error {
  const code = stale ? "install_lock_stale" : "install_lock_busy";
  const message = stale
    ? `a stale claudexor harness install lock remains at ${path}; verify no installer is running, remove that exact directory, and retry`
    : `another claudexor harness install still owns ${path}; if this persists after that installer exits, verify no installer is running, remove that exact directory, and retry`;
  return Object.assign(new Error(message), { code });
}

/** One installation lease. A kernel-held SQLite write lock serializes directory
 * owner inspection/reclamation across processes and releases automatically on
 * process death. The stable lock file is never unlinked: a replacement inode
 * would permit two owners. Existing directory owners from older engines still
 * bind this lease; only a proved dead recorded PID is reclaimed. */
export function acquireHarnessInstallLease(home: string, timeoutMs: number): HarnessInstallLease {
  const lockRoot = join(home, ".claudexor");
  const path = join(lockRoot, "harness-install.lock");
  const ownerPath = join(path, "owner.json");
  const token = randomUUID();
  const owner: HarnessInstallLeaseOwner = { pid: process.pid, token };
  const deadline = Date.now() + Math.max(0, timeoutMs);
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });

  const mutex = new DatabaseSync(join(lockRoot, "harness-install-lease.sqlite"));
  let locked = false;
  const releaseMutex = () => {
    try {
      if (locked) mutex.exec("ROLLBACK");
    } finally {
      mutex.close();
    }
  };
  try {
    for (;;) {
      if (!locked) {
        try {
          mutex.exec("BEGIN IMMEDIATE");
          locked = true;
        } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
          if (Date.now() >= deadline) throw installLockError(path, false);
          Atomics.wait(sleepCell, 0, 0, Math.min(INSTALL_LOCK_POLL_MS, deadline - Date.now()));
          continue;
        }
      }
      try {
        mkdirSync(path, { mode: 0o700 });
        try {
          writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
        } catch (error) {
          rmSync(path, { recursive: true, force: true });
          throw error;
        }
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            const current = readInstallLeaseOwner(ownerPath);
            try {
              if (current?.pid === process.pid && current.token === token)
                rmSync(path, { recursive: true, force: true });
            } finally {
              releaseMutex();
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const existing = readInstallLeaseOwner(ownerPath);
      let stale = existing !== null && !processIsAlive(existing.pid);
      if (existing === null) {
        try {
          stale = Date.now() - statSync(path).mtimeMs >= INSTALL_LOCK_OWNER_GRACE_MS;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (stale && existing !== null) {
        // All participating reclaimers hold this same kernel lock. A new owner
        // cannot appear between this observation and removal.
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (stale) throw installLockError(path, true);
      if (Date.now() >= deadline) throw installLockError(path, false);
      Atomics.wait(sleepCell, 0, 0, Math.min(INSTALL_LOCK_POLL_MS, deadline - Date.now()));
    }
  } catch (error) {
    releaseMutex();
    throw error;
  }
}
