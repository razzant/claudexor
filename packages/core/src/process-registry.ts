/**
 * Passive registry of live harness child process groups (T3.1#4). Every
 * `spawnProcess` child registers on spawn and unregisters on close; the
 * daemon snapshots the registry into a pids file so a crashed/killed daemon
 * can REAP surviving orphans on the next start (children live in their own
 * process groups by design, so they outlive the daemon). Purely
 * observational: adapters gain no orchestration behavior.
 */
const live = new Map<number, string>();

export function registerChildProcess(pid: number, cmd: string): void {
  live.set(pid, cmd);
}

export function unregisterChildProcess(pid: number): void {
  live.delete(pid);
}

/** Snapshot of currently-live child process groups: pid + command name. */
export function liveChildProcesses(): { pid: number; cmd: string }[] {
  return [...live.entries()].map(([pid, cmd]) => ({ pid, cmd }));
}
