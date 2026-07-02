/**
 * Orphaned-child bookkeeping for the daemon (T3.1#4). Harness children run in
 * their OWN process groups (deliberate: group kill), so they survive a daemon
 * crash/SIGKILL and keep mutating trees with nobody watching. The daemon
 * periodically snapshots the live child registry to a pids file; on the next
 * start, any recorded pid that is still alive AND still runs the recorded
 * command is an orphan from a previous daemon life — its process group is
 * killed before new work is accepted.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { liveChildProcesses } from "@claudexor/core";

interface RecordedChild {
  pid: number;
  cmd: string;
}

export function writePidsSnapshot(path: string): void {
  try {
    const pids = liveChildProcesses();
    if (pids.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pids }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* best-effort bookkeeping; never fail a run over it */
  }
}

/**
 * Kill process groups recorded by a PREVIOUS daemon life. Guards against pid
 * recycling by requiring the live process's command name to still match the
 * recorded command (typed equality on basename, no pattern matching). Returns
 * a human-readable action log for the daemon log.
 */
export function reapRecordedOrphans(path: string): string[] {
  let recorded: RecordedChild[] = [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { pids?: unknown };
    if (Array.isArray(raw.pids)) {
      recorded = raw.pids.filter(
        (p): p is RecordedChild =>
          !!p && typeof p === "object" && typeof (p as RecordedChild).pid === "number" && typeof (p as RecordedChild).cmd === "string",
      );
    }
  } catch {
    return [];
  }
  const actions: string[] = [];
  for (const child of recorded) {
    const liveCmd = processCommandName(child.pid);
    if (liveCmd === null) continue; // already gone
    if (basename(liveCmd) !== basename(child.cmd)) {
      actions.push(`skip pid ${child.pid}: command changed (${basename(liveCmd)} != ${basename(child.cmd)}) — likely recycled`);
      continue;
    }
    try {
      process.kill(-child.pid, "SIGTERM");
      actions.push(`SIGTERM orphan process group ${child.pid} (${basename(child.cmd)})`);
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* group exited after SIGTERM */
        }
      }, 3_000).unref?.();
    } catch {
      try {
        process.kill(child.pid, "SIGTERM");
        actions.push(`SIGTERM orphan pid ${child.pid} (${basename(child.cmd)}; group already gone)`);
      } catch {
        /* exited between the liveness check and the kill */
      }
    }
  }
  rmSync(path, { force: true });
  return actions;
}

/** The live command name for a pid, or null when the process is gone. */
function processCommandName(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    const cmd = out.trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}
