/**
 * Passive registry of live harness child process groups. Every
 * `spawnProcess` child registers on spawn and unregisters on close; the
 * daemon snapshots the registry into a pids file so a crashed/killed daemon
 * can REAP surviving orphans on the next start (POSIX children live in their
 * own process groups by design, so they outlive the daemon; a Windows child has
 * no group identity, is not registered, and normally ends with the daemon in
 * libuv's kill-on-close Job). Purely observational: adapters gain no
 * orchestration behavior.
 *
 * A child spawned with a run scope marker in its env records that marker
 * NAME here (never the value or any other env byte), so the daemon's capture
 * tick can walk the child's descendants and attribute them to the run that
 * must end them (DIRECTIVE 1, the second membership source).
 */
import { measureSync } from "@claudexor/util";
import { defaultProcessGroupService, type ProcessGroupHandle } from "./process-group.js";
import { defaultProbeGroupAlive } from "./process-tree.js";

export interface LiveChildProcess {
  pid: number;
  cmd: string;
  processGroup: ProcessGroupHandle;
  /** The run scope marker this child was spawned under, when any. */
  scopeMarker?: string;
}

const live = new Map<number, LiveChildProcess>();
const listeners = new Set<(child: LiveChildProcess) => void>();
const retiredListeners = new Set<(child: LiveChildProcess) => void>();

/**
 * Observe every registration (the run custodian seeds a root's own process
 * group and scope floor the moment it is spawned, before any capture tick).
 * Returns the unsubscribe. A listener must never throw into the spawn path.
 */
export function onChildProcessRegistered(listener: (child: LiveChildProcess) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Register a just-spawned child and return its registration (null when its
 * group was not captured). A spawn site of the default service reuses the
 * registration's `processGroup` instead of running the identity helper a second
 * time; the returned object is also the exact key `unregisterChildProcess`
 * compares. The capture stays synchronous at spawn (INV-144) and is labeled in
 * `worstSync`.
 */
export function registerChildProcess(
  pid: number,
  cmd: string,
  scopeMarker?: string,
): LiveChildProcess | null {
  const captured = measureSync("process.identity_capture", () =>
    defaultProcessGroupService.captureLeader(pid),
  );
  if (captured.status !== "known") {
    live.delete(pid);
    return null;
  }
  const child: LiveChildProcess = {
    pid,
    cmd,
    processGroup: captured.handle,
    ...(scopeMarker ? { scopeMarker } : {}),
  };
  live.set(pid, child);
  for (const listener of listeners) {
    try {
      listener(child);
    } catch {
      /* observation never fails a spawn */
    }
  }
  return child;
}

/** Unregister exactly this registration (the object `registerChildProcess`
 * returned): a close, an error or a stop of an earlier child never removes a
 * later child registered under the same, reused pid. */
export function unregisterChildProcess(child: LiveChildProcess | null | undefined): void {
  if (child && live.get(child.pid) === child) live.delete(child.pid);
}

/**
 * Observe a registration whose own process group was proven EMPTY when its
 * child closed by itself (`retireChildProcess`): the same registration object
 * (pid, group and the leader's spawn-time identity), so an owner drops that
 * group's basis and nothing registered later under the same numbers.
 */
export function onChildGroupRetired(listener: (child: LiveChildProcess) => void): () => void {
  retiredListeners.add(listener);
  return () => {
    retiredListeners.delete(listener);
  };
}

/**
 * Unregister a child that closed by itself (no stop asked for it), and when its
 * own group is then proven empty — a signal-0 probe answering ESRCH, never an
 * assumption from the close — tell the observers. A live or unknown group (a
 * member left behind, a probe that failed otherwise) retires nothing; Windows has
 * no group to probe.
 */
export function retireChildProcess(
  child: LiveChildProcess,
  probeGroupAlive: (pgid: number) => boolean = defaultProbeGroupAlive,
): void {
  unregisterChildProcess(child);
  if (process.platform === "win32" || probeGroupAlive(child.processGroup.pgid)) return;
  for (const listener of retiredListeners) {
    try {
      listener(child);
    } catch {
      /* observation never fails a capture */
    }
  }
}

/** Snapshot of children whose exact kernel process-group identity was captured. */
export function liveChildProcesses(): LiveChildProcess[] {
  return [...live.values()];
}
