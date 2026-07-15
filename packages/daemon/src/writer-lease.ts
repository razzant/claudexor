import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface DaemonWriterLease {
  readonly path: string;
  release(): void;
}

/** Claim single-writer authority before any daemon journal is opened. */
export function acquireDaemonWriterLease(socketPath: string): DaemonWriterLease {
  const path = `${socketPath}.writer`;
  const token = randomUUID();
  const ownerPath = `${path}/owner.json`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readLeaseOwner(ownerPath);
      if (!owner || processIsAlive(owner.pid)) throw writerBusy(path);
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
      const owner = readLeaseOwner(ownerPath);
      if (owner?.token === token && owner.pid === process.pid) {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

function writerBusy(path: string): Error {
  return Object.assign(new Error(`another claudexor daemon owns ${path}`), {
    code: "daemon_writer_busy",
    status: 409,
  });
}

function readLeaseOwner(path: string): { pid: number; token: string } | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
    return Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      typeof value.token === "string"
      ? { pid: Number(value.pid), token: value.token }
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
