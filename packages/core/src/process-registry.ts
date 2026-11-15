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
import {
  defaultProcessGroupService,
  type ProcessGroupCapture,
  type ProcessGroupHandle,
} from "./process-group.js";

export interface LiveChildProcess {
  pid: number;
  cmd: string;
  processGroup: ProcessGroupHandle;
  /** The run scope marker this child was spawned under, when any. */
  scopeMarker?: string;
}

const live = new Map<number, LiveChildProcess>();
const listeners = new Set<(child: LiveChildProcess) => void>();

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
 * Register a just-spawned child and return the identity capture it made, so a
 * spawn site that also needs the child's group handle reuses this one read
 * instead of running the identity helper a second time. The capture stays
 * synchronous at spawn (INV-144) and is labeled in `worstSync`.
 */
export function registerChildProcess(
  pid: number,
  cmd: string,
  scopeMarker?: string,
): ProcessGroupCapture {
  const captured = measureSync("process.identity_capture", () =>
    defaultProcessGroupService.captureLeader(pid),
  );
  if (captured.status === "known") {
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
  } else live.delete(pid);
  return captured;
}

export function unregisterChildProcess(pid: number): void {
  live.delete(pid);
}

/** Snapshot of children whose exact kernel process-group identity was captured. */
export function liveChildProcesses(): LiveChildProcess[] {
  return [...live.values()];
}
