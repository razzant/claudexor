/**
 * Per-run cgroup v2 boundary at spawn (run-deadline/1, Linux only).
 *
 * When the daemon proved it may manage a delegated cgroup v2 subtree, every
 * deadline-bearing run gets its own cgroup and the run's scope markers are
 * registered here with that cgroup's `cgroup.procs`. A child launched through
 * the run-owned launch point (`run-spawn.ts`, which `spawnProcess` and
 * `runCaptureRaw` use) whose environment carries such a marker
 * first moves itself into the cgroup, then execs the real program, so the
 * program and everything it ever forks (setsid, double fork, a cleaned
 * environment) stay inside the cgroup until it is killed whole with
 * `cgroup.kill`. The move happens before the program runs, so nothing escapes
 * between spawn and move. A failed move aborts that launch (exit 125): a run
 * promised a cgroup boundary never runs outside it.
 *
 * Purely registry state inside the daemon process: no marker is registered
 * where the boundary is not proven, and then spawns are unchanged.
 */
import { isRunScopeMarkerName, SCOPE_MARKER_VALUE } from "./process-scope.js";

const procsByMarker = new Map<string, string>();

/** Run every launch carrying `marker` inside the cgroup whose `cgroup.procs` is given. */
export function registerScopeCgroup(marker: string, procsPath: string): void {
  procsByMarker.set(marker, procsPath);
}

export function unregisterScopeCgroup(marker: string): void {
  procsByMarker.delete(marker);
}

/** Exit status of the shim when the move into the cgroup failed. */
export const CGROUP_ENTRY_FAILED_EXIT = 125;

/**
 * The invocation that enters the run's cgroup before exec, or the original one
 * when no cgroup is registered for the spawn environment's run marker.
 * `/bin/sh -c 'echo 0 > "$0" || exit 125; exec "$@"' <procs> <binary> <args…>`:
 * writing 0 moves the writing process itself; exec keeps its pid and birth, so
 * the process identity captured at spawn still names the real program.
 */
export function enterScopeCgroup<T extends { binary: string; args: string[] }>(
  invocation: T,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== "linux" || procsByMarker.size === 0) return invocation;
  let procs: string | undefined;
  for (const [name, value] of Object.entries(env)) {
    if (value !== SCOPE_MARKER_VALUE || !isRunScopeMarkerName(name)) continue;
    procs = procsByMarker.get(name);
    if (procs) break;
  }
  if (!procs) return invocation;
  return {
    ...invocation,
    binary: "/bin/sh",
    args: [
      "-c",
      `echo 0 > "$0" || exit ${CGROUP_ENTRY_FAILED_EXIT}; exec "$@"`,
      procs,
      invocation.binary,
      ...invocation.args,
    ],
  };
}
