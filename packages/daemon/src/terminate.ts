import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  type ProcessIdentity,
  type ProcessIdentityReader,
  type ProcessObservation,
} from "@claudexor/core";
import {
  classifyDaemonLeaseOwner,
  inspectDaemonWriterLease,
  processIsAlive,
  type DaemonLeaseOwner,
  type DaemonLeaseOwnerCapability,
  type DaemonWriterLeaseStatus,
} from "./writer-lease.js";

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
  /** Whether this caller has authority to escalate to SIGKILL (default false).
   * Runtime
   * replacement grants that authority only after an explicit fenced admission
   * receipt; an ambiguous RPC failure may observe death but never cause it. */
  allowSigkill?: boolean;
  /** Exact daemon process instance selected before the stop RPC. Without this
   * the waiter could pin a same-build successor that acquired the lease while
   * the admission response was in flight. */
  expectedOwner?: DaemonLeaseOwner;
  /** Runtime replacement refuses a successor observed during this termination
   * proof. The separately-adjudicated post-return/pointer-swap gap is outside
   * this waiter's observation window. */
  requireNoSuccessor?: boolean;
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
 * Strict writer-lease authority used by termination. This is deliberately a
 * separate argument rather than new optional members on DaemonTerminationDeps:
 * downstream dependency objects may already use these names for unrelated
 * private or runtime state.
 */
export interface DaemonTerminationLeaseAuthority {
  inspect(socketPath: string): DaemonWriterLeaseStatus;
  classify(owner: DaemonLeaseOwner): DaemonLeaseOwnerCapability;
}

const DEFAULT_LEASE_AUTHORITY: DaemonTerminationLeaseAuthority = {
  inspect: (socketPath) => inspectDaemonWriterLease(socketPath),
  classify: (owner) => classifyDaemonLeaseOwner(owner),
};

function compatibilityObservation(identity: ProcessIdentity): ProcessObservation {
  return { identity, linuxState: null };
}

function compatibilityUnknownObservation(owner: DaemonLeaseOwner): ProcessObservation {
  return compatibilityObservation({
    status: "unknown",
    pid: owner.pid,
    platform: process.platform,
    reason: "unsupported_platform",
  });
}

function classifyCompatibilityIdentity(
  owner: DaemonLeaseOwner,
  identity: ProcessIdentityReader,
): DaemonLeaseOwnerCapability {
  if (!owner.identity) {
    return {
      status: "capable",
      reason: "legacy_process_present",
      observation: compatibilityUnknownObservation(owner),
    };
  }

  const observed = identity.read(owner.pid);
  const observation = compatibilityObservation(observed);
  if (observed.status === "missing") {
    return { status: "proven_stale", reason: "process_missing", observation };
  }
  if (observed.status === "known") {
    return compareProcessIdentity(owner.identity, observed) === "same"
      ? { status: "capable", reason: "identity_match", observation }
      : { status: "proven_stale", reason: "identity_mismatch", observation };
  }
  return { status: "unknown", reason: "identity_unavailable", observation };
}

/**
 * Patch-compatible dependency adapter for callers that supplied the old
 * identity/isAlive test seams. It is unreachable from normal production and
 * from the explicit strict fourth-argument authority. Filesystem inspection
 * remains strict; only a valid owner's injected process capability follows the
 * old isAlive-before-identity order. The shared termination loop still owns
 * target pinning, successor refusal, and explicit-owner-only signal authority.
 */
function createCompatibilityLeaseAuthority(
  identity: ProcessIdentityReader,
  isAlive: (pid: number) => boolean,
): DaemonTerminationLeaseAuthority {
  const classify = (owner: DaemonLeaseOwner): DaemonLeaseOwnerCapability => {
    if (!isAlive(owner.pid)) {
      return {
        status: "proven_stale",
        reason: "process_missing",
        observation: compatibilityObservation({
          status: "missing",
          pid: owner.pid,
          platform: process.platform,
        }),
      };
    }
    return classifyCompatibilityIdentity(owner, identity);
  };

  return {
    inspect: (socketPath) => {
      const current = inspectDaemonWriterLease(socketPath);
      return current.status === "owned"
        ? {
            ...current,
            // Inspection proves only that a valid record is present. The
            // shared loop classifies the pinned target exactly once; this
            // placeholder also preserves old successor refusal semantics.
            capability: {
              status: "capable",
              reason: "legacy_process_present",
              observation: compatibilityUnknownObservation(current.owner),
            },
          }
        : current;
    },
    classify,
  };
}

function sameOwner(left: DaemonLeaseOwner, right: DaemonLeaseOwner): boolean {
  return left.pid === right.pid && left.token === right.token;
}

function staleOwnerDetail(owner: DaemonLeaseOwner, capability: DaemonLeaseOwnerCapability): string {
  if (capability.status !== "proven_stale") return `daemon pid ${owner.pid} exited`;
  switch (capability.reason) {
    case "process_missing":
      return `daemon pid ${owner.pid} is gone`;
    case "identity_mismatch":
      return `pid ${owner.pid} was recycled by another process (never signalled)`;
    case "linux_zombie":
      return `daemon pid ${owner.pid} is a Linux zombie (never signalled)`;
    case "lease_predates_boot":
      return `the daemon's lease was written before this system booted, so pid ${owner.pid} is another process (never signalled)`;
  }
}

function staleOwnerOutcome(
  owner: DaemonLeaseOwner,
  capability: DaemonLeaseOwnerCapability,
  current: DaemonWriterLeaseStatus,
  requireNoSuccessor: boolean | undefined,
  killed: boolean,
): DaemonTerminationOutcome {
  const successor = current.status === "owned" && !sameOwner(current.owner, owner) ? current : null;
  if (requireNoSuccessor) {
    if (current.status === "unknown") {
      return {
        outcome: "still_alive",
        detail: `daemon pid ${owner.pid} exited but writer-lease activity is unknown (${current.reason})`,
      };
    }
    if (successor && successor.capability.status !== "proven_stale") {
      return {
        outcome: "still_alive",
        detail: `daemon pid ${owner.pid} exited but successor pid ${successor.owner.pid} owns the writer lease`,
      };
    }
  }
  const successorDetail = successor
    ? ` (writer lease now records stale pid ${successor.owner.pid})`
    : "";
  return {
    outcome: killed ? "killed" : "exited",
    detail: `${staleOwnerDetail(owner, capability)}${successorDetail}`,
  };
}

/**
 * Await the CONFIRMED death of the daemon owning `socketPath`'s writer lease
 * (W3.5): "stop requested" is not "stopped" — a disposer that removes state
 * under a still-live daemon manufactures orphans.
 *
 * The target is PINNED at entry (`terminateAndWait(exactIdentity, deadline)`):
 * the lease owner is snapshotted once and every later observation is judged
 * against THAT owner. Re-reading the lease each poll would follow whoever
 * currently holds it, so a replacement daemon started during the confirmation
 * window (the app auto-starts one) could be waited on — and SIGKILLed — in
 * place of the process we were asked to stop.
 *
 * Confirmed death = the pinned owner released its lease, or the canonical
 * classifier proves its pid missing, recycled, or a Linux zombie. A takeover
 * alone does not prove that the old owner exited. Past the graceful window a
 * SIGKILL is sent ONLY when an explicitly supplied pinned birth identity still
 * matches the process in that same iteration; without that proof this fails
 * closed to an honest `still_alive`.
 */
export async function awaitDaemonTermination(
  socketPath: string,
  options: AwaitDaemonTerminationOptions = {},
  deps: DaemonTerminationDeps = {},
  leaseAuthority?: DaemonTerminationLeaseAuthority,
): Promise<DaemonTerminationOutcome> {
  const deadlineMs = options.deadlineMs ?? 20_000;
  const killAfterMs = options.killAfterMs ?? 17_000;
  const allowSigkill = options.allowSigkill ?? false;
  const pollMs = options.pollMs ?? 150;
  // Legacy execution dependencies retain their one-read accessor behavior.
  const configuredKill = deps.kill;
  const configuredSleep = deps.sleep;
  const configuredNow = deps.now;
  const kill = configuredKill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep =
    configuredSleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = configuredNow ?? Date.now;
  let authority: DaemonTerminationLeaseAuthority;
  let classifySignalTarget: (owner: DaemonLeaseOwner) => DaemonLeaseOwnerCapability;
  if (leaseAuthority) {
    authority = leaseAuthority;
    classifySignalTarget = (owner) => leaseAuthority.classify(owner);
  } else {
    // Do not even inspect the old policy getters when an explicit fourth
    // authority is present. Without one, capture each exactly once and enable
    // compatibility only when the caller actually supplied that seam.
    const configuredIdentity = deps.identity;
    const configuredIsAlive = deps.isAlive;
    if (configuredIdentity !== undefined || configuredIsAlive !== undefined) {
      const identity = configuredIdentity ?? defaultProcessIdentityService;
      authority = createCompatibilityLeaseAuthority(identity, configuredIsAlive ?? processIsAlive);
      classifySignalTarget = (owner) => classifyCompatibilityIdentity(owner, identity);
    } else {
      authority = DEFAULT_LEASE_AUTHORITY;
      classifySignalTarget = (owner) => DEFAULT_LEASE_AUTHORITY.classify(owner);
    }
  }

  const start = now();
  let killed = false;
  let noKillReason: string | null = null;
  let current = authority.inspect(socketPath);
  // The ONE owner this call is about. Everything below judges the world
  // against this snapshot — never against whoever holds the lease later.
  let owner = options.expectedOwner;
  if (!owner) {
    if (current.status === "absent") {
      return { outcome: "exited", detail: "no daemon owns the writer lease" };
    }
    if (current.status === "unknown") {
      return {
        outcome: "still_alive",
        detail: `daemon activity is unknown (${current.reason})`,
      };
    }
    if (current.capability.status === "proven_stale") {
      return { outcome: "exited", detail: staleOwnerDetail(current.owner, current.capability) };
    }
    owner = current.owner;
  }

  const explicitOwner = options.expectedOwner !== undefined;
  for (;;) {
    if (current.status === "absent") {
      return {
        outcome: killed ? "killed" : "exited",
        detail: killed ? "daemon exited after SIGKILL escalation" : "daemon released its lease",
      };
    }

    // The current lease record may have the same pid/token but different
    // identity bytes. Classify the immutable pinned target itself every time;
    // a current record's capability may describe only a successor/current
    // generation and can never lend signal authority to the target.
    const targetCapability = authority.classify(owner);

    if (targetCapability.status === "proven_stale") {
      return staleOwnerOutcome(
        owner,
        targetCapability,
        current,
        options.requireNoSuccessor,
        killed,
      );
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
      if (!allowSigkill) {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (caller has no signal authority)`;
      } else if (!explicitOwner) {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (no explicit expected owner)`;
      } else if (current.status === "unknown") {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (writer-lease authority unknown)`;
      } else if (!owner.identity) {
        noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (no recorded birth identity)`;
      } else {
        // Time and injected dependencies may advance between the loop's exit
        // classification and this escalation point. Only a second proof made
        // immediately before delivery can authorize a signal.
        const signalCapability = classifySignalTarget(owner);
        if (signalCapability.status === "proven_stale") {
          // Runtime replacement must also refuse a successor that appeared
          // during the pre-signal identity recheck. The loop's `current`
          // snapshot predates `now()` and this second classification, so it
          // cannot prove the no-successor condition at this return boundary.
          // Other callers preserve their existing inspection/call counts.
          const requireNoSuccessor = options.requireNoSuccessor;
          const exitCurrent = requireNoSuccessor ? authority.inspect(socketPath) : current;
          return staleOwnerOutcome(
            owner,
            signalCapability,
            exitCurrent,
            requireNoSuccessor,
            killed,
          );
        }
        if (signalCapability.status === "capable" && signalCapability.reason === "identity_match") {
          try {
            kill(owner.pid, "SIGKILL");
            killed = true;
          } catch {
            /* delivery raced its exit; the next poll observes the truth */
          }
        } else {
          noKillReason = `daemon pid ${owner.pid} is still alive; SIGKILL withheld (identity unverifiable)`;
        }
      }
    }
    await sleep(pollMs);
    current = authority.inspect(socketPath);
  }
}
