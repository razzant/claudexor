import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  type ProcessIdentityReader,
} from "@claudexor/core";
import { daemonLeaseOwner, processIsAlive } from "./writer-lease.js";

export type DaemonTerminationOutcome =
  /** The daemon released its lease or its pid is gone — confirmed dead. */
  | { outcome: "exited"; detail: string }
  /** The graceful window lapsed; an identity-VERIFIED SIGKILL brought it down. */
  | { outcome: "killed"; detail: string }
  /** Still alive at the deadline (or unkillable without identity proof). */
  | { outcome: "still_alive"; detail: string };

export interface AwaitDaemonTerminationOptions {
  /** Total confirmation budget (default 20s: the daemon's own W-C8 ladder
   * self-exits within its 15s stop deadline + 2s drain sweep + slack). */
  deadlineMs?: number;
  /** Graceful window before the SIGKILL escalation (default 17s). */
  killAfterMs?: number;
  pollMs?: number;
}

export interface DaemonTerminationDeps {
  identity?: ProcessIdentityReader;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Await the CONFIRMED death of the daemon owning `socketPath`'s writer lease
 * (W3.5): "stop requested" is not "stopped" — a disposer that removes state
 * under a still-live daemon manufactures orphans. Polls the lease owner
 * (released lease or a gone/replaced pid = dead). Past the graceful window a
 * SIGKILL is sent ONLY when the recorded birth identity still matches the
 * live process — a recycled pid is never signalled (sol #5); without a
 * verifiable identity this fails closed to an honest `still_alive`.
 */
export async function awaitDaemonTermination(
  socketPath: string,
  options: AwaitDaemonTerminationOptions = {},
  deps: DaemonTerminationDeps = {},
): Promise<DaemonTerminationOutcome> {
  const deadlineMs = options.deadlineMs ?? 20_000;
  const killAfterMs = options.killAfterMs ?? 17_000;
  const pollMs = options.pollMs ?? 150;
  const identity = deps.identity ?? defaultProcessIdentityService;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = deps.isAlive ?? processIsAlive;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;

  const start = now();
  let killed = false;
  let noKillReason: string | null = null;
  for (;;) {
    const owner = daemonLeaseOwner(socketPath);
    if (!owner) {
      return {
        outcome: killed ? "killed" : "exited",
        detail: killed ? "daemon exited after SIGKILL escalation" : "daemon released its lease",
      };
    }
    if (!isAlive(owner.pid)) {
      return {
        outcome: killed ? "killed" : "exited",
        detail: `daemon pid ${owner.pid} is gone (stale lease left behind)`,
      };
    }
    if (owner.identity) {
      const observed = identity.read(owner.pid);
      if (observed.status === "missing") {
        return { outcome: killed ? "killed" : "exited", detail: `daemon pid ${owner.pid} is gone` };
      }
      if (
        observed.status === "known" &&
        compareProcessIdentity(owner.identity, observed) === "different"
      ) {
        return {
          outcome: "exited",
          detail: `pid ${owner.pid} was recycled by another process (never signalled)`,
        };
      }
    }
    const elapsed = now() - start;
    if (elapsed >= deadlineMs) {
      return {
        outcome: "still_alive",
        detail:
          noKillReason ??
          (killed
            ? `daemon pid ${owner.pid} survived SIGKILL confirmation window`
            : `daemon pid ${owner.pid} is still alive after ${deadlineMs}ms`),
      };
    }
    if (!killed && elapsed >= killAfterMs) {
      // Escalate ONLY under a verified identity match observed THIS iteration.
      const observed = owner.identity ? identity.read(owner.pid) : null;
      if (
        owner.identity &&
        observed?.status === "known" &&
        compareProcessIdentity(owner.identity, observed) === "same"
      ) {
        try {
          kill(owner.pid, "SIGKILL");
          killed = true;
        } catch {
          /* delivery raced its exit; the next poll observes the truth */
        }
      } else {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (${
          owner.identity ? "identity unverifiable" : "no recorded birth identity"
        })`;
      }
    }
    await sleep(pollMs);
  }
}
