import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  type KnownProcessIdentity,
  type ProcessIdentityReader,
} from "@claudexor/core";

export interface DaemonWriterLease {
  readonly path: string;
  release(): void;
}

export interface DaemonLeaseOwner {
  pid: number;
  token: string;
  /** Birth identity of the owning daemon, recorded at acquisition so a later
   * terminator can verify it never signals a recycled pid (W3.5/sol #5).
   * Absent on legacy leases or when the platform cannot observe identity. */
  identity?: KnownProcessIdentity;
}

/** Claim single-writer authority before any daemon journal is opened. */
export function acquireDaemonWriterLease(
  socketPath: string,
  deps: { identity?: ProcessIdentityReader } = {},
): DaemonWriterLease {
  const path = `${socketPath}.writer`;
  const token = randomUUID();
  const ownerPath = `${path}/owner.json`;
  const self = (deps.identity ?? defaultProcessIdentityService).self();
  const owner: DaemonLeaseOwner = {
    pid: process.pid,
    token,
    ...(self.status === "known" ? { identity: self } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLeaseOwner(ownerPath);
      if (!existing || processIsAlive(existing.pid)) throw writerBusy(path);
      const stale = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(path, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      if (attempt === 1) throw new Error(`could not replace stale daemon writer lease ${path}`);
    }
  }
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      const current = readLeaseOwner(ownerPath);
      if (current?.token === token && current.pid === process.pid) {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

/** Read the current writer-lease owner for a socket path (null when free). */
export function daemonLeaseOwner(socketPath: string): DaemonLeaseOwner | null {
  return readLeaseOwner(`${socketPath}.writer/owner.json`);
}

function writerBusy(path: string): Error {
  return Object.assign(new Error(`another claudexor daemon owns ${path}`), {
    code: "daemon_writer_busy",
    status: 409,
  });
}

function readLeaseOwner(path: string): DaemonLeaseOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      token?: unknown;
      identity?: unknown;
    };
    if (
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      typeof value.token !== "string"
    ) {
      return null;
    }
    return {
      pid: Number(value.pid),
      token: value.token,
      ...(isKnownProcessIdentity(value.identity) ? { identity: value.identity } : {}),
    };
  } catch {
    return null;
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
