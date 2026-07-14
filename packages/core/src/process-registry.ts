/**
 * Passive registry of live harness child process groups. Every
 * `spawnProcess` child registers on spawn and unregisters on close; the
 * daemon snapshots the registry into a pids file so a crashed/killed daemon
 * can REAP surviving orphans on the next start (children live in their own
 * process groups by design, so they outlive the daemon). Purely
 * observational: adapters gain no orchestration behavior.
 */
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";

interface LiveChildProcess {
  pid: number;
  cmd: string;
  processGroup: ProcessGroupHandle;
}

const live = new Map<number, LiveChildProcess>();

export function registerChildProcess(pid: number, cmd: string): void {
  const captured = defaultProcessGroupService.captureLeader(pid);
  if (captured.status === "known") live.set(pid, { pid, cmd, processGroup: captured.handle });
  else live.delete(pid);
}

export function unregisterChildProcess(pid: number): void {
  live.delete(pid);
}

/** Snapshot of children whose exact kernel process-group identity was captured. */
export function liveChildProcesses(): LiveChildProcess[] {
  return [...live.values()];
}
