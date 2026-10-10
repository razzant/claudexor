import {
  compareProcessIdentity,
  defaultProcessIdentityService,
  isKnownProcessIdentity,
  type KnownProcessIdentity,
  type ProcessIdentityComparison,
  type ProcessIdentityReader,
  type ProcessIdentityUnknownReason,
} from "./process-identity.js";

declare const processGroupHandleBrand: unique symbol;

export type ProcessGroupHandle = Readonly<{
  schemaVersion: 1;
  pgid: number;
  leader: KnownProcessIdentity;
  [processGroupHandleBrand]: true;
}>;

export type ProcessGroupCapture =
  | { status: "known"; handle: ProcessGroupHandle }
  | { status: "missing"; pid: number }
  | {
      status: "unknown";
      pid: number;
      reason: ProcessIdentityUnknownReason | "identity_pid_mismatch" | "not_process_group_leader";
    };

export type ProcessGroupEmptyProbe =
  | { status: "empty"; pgid: number }
  | { status: "nonempty"; pgid: number }
  | {
      status: "unknown";
      pgid: number;
      reason: "unsupported_platform" | "permission_denied" | "probe_failed";
    };

/** Outcome of the injected win32 tree kill (`taskkill /T /F` in production). */
export type ProcessTreeKillOutcome = "killed" | "not_found" | "failed";

export type ProcessGroupSignalResult =
  | { status: "sent"; pgid: number; signal: NodeJS.Signals }
  | { status: "empty"; pgid: number; signal: NodeJS.Signals }
  | {
      status: "unknown";
      pgid: number;
      signal: NodeJS.Signals;
      reason:
        | "stale_leader"
        | "missing_leader"
        | "identity_unknown"
        | "permission_denied"
        | "signal_failed"
        | "unsupported_platform";
    };

export interface ProcessGroupServiceOptions {
  platform?: string;
  identity?: ProcessIdentityReader;
  probeProcessGroup?: (negativePgid: number) => void;
  signalProcessGroup?: (negativePgid: number, signal: NodeJS.Signals) => void;
  /**
   * OPT-IN win32 terminator (`killWindowsProcessTree` in production). Windows
   * has no process groups and no cooperative signal, so a win32 `signal` is a
   * whole-tree kill of the recorded leader. Absent (the default) keeps win32
   * signalling refused, so no consumer inherits Windows termination it did not
   * ask for. The caller injects it from the tree owner, which keeps this
   * module a leaf.
   */
  killProcessTree?: (pid: number) => ProcessTreeKillOutcome;
}

function handleFromKnownLeader(identity: KnownProcessIdentity): ProcessGroupCapture {
  if (identity.processGroupId !== identity.pid) {
    return { status: "unknown", pid: identity.pid, reason: "not_process_group_leader" };
  }
  return {
    status: "known",
    handle: Object.freeze({
      schemaVersion: 1 as const,
      pgid: identity.pid,
      leader: Object.freeze({ ...identity }),
    }) as ProcessGroupHandle,
  };
}

export function parseProcessGroupHandle(value: unknown): ProcessGroupHandle {
  if (!value || typeof value !== "object")
    throw new Error("process group handle must be an object");
  const candidate = value as { schemaVersion?: unknown; pgid?: unknown; leader?: unknown };
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.pgid) ||
    Number(candidate.pgid) <= 0
  ) {
    throw new Error("process group handle has an invalid schema version or pgid");
  }
  if (!isKnownProcessIdentity(candidate.leader))
    throw new Error("process group handle requires a known leader identity");
  if (
    candidate.leader.pid !== candidate.pgid ||
    candidate.leader.processGroupId !== candidate.pgid
  ) {
    throw new Error("process group leader pid and observed pgid must equal the handle pgid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    pgid: candidate.pgid,
    leader: Object.freeze({ ...candidate.leader }),
  }) as ProcessGroupHandle;
}

export class ProcessGroupService {
  private readonly platform: string;
  private readonly identity: ProcessIdentityReader;
  private readonly probeProcessGroup: (negativePgid: number) => void;
  private readonly signalProcessGroup: (negativePgid: number, signal: NodeJS.Signals) => void;
  private readonly killProcessTree?: (pid: number) => ProcessTreeKillOutcome;

  constructor(options: ProcessGroupServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.identity = options.identity ?? defaultProcessIdentityService;
    this.probeProcessGroup =
      options.probeProcessGroup ?? ((negativePgid) => process.kill(negativePgid, 0));
    this.signalProcessGroup =
      options.signalProcessGroup ?? ((negativePgid, signal) => process.kill(negativePgid, signal));
    this.killProcessTree = options.killProcessTree;
  }

  captureLeader(pid: number): ProcessGroupCapture {
    const identity = this.identity.read(pid);
    if (identity.status === "missing") return { status: "missing", pid };
    if (identity.status === "unknown") return { status: "unknown", pid, reason: identity.reason };
    if (identity.pid !== pid) return { status: "unknown", pid, reason: "identity_pid_mismatch" };
    return handleFromKnownLeader(identity);
  }

  compareLeader(handle: ProcessGroupHandle): ProcessIdentityComparison {
    return compareProcessIdentity(handle.leader, this.identity.read(handle.leader.pid));
  }

  /**
   * Only ESRCH proves the complete group empty; every other error is unknown.
   * On win32 there is no group probe: emptiness is the recorded LEADER's
   * kernel identity being gone (missing, or a different process on a recycled
   * pid) after the tree kill that `signal` performs — a leader-death proof,
   * weaker than the POSIX group proof and disclosed as such by its own owner.
   */
  probeEmpty(handle: ProcessGroupHandle): ProcessGroupEmptyProbe {
    if (this.platform === "win32") {
      const comparison = this.compareLeader(handle);
      if (comparison === "same") return { status: "nonempty", pgid: handle.pgid };
      if (comparison === "missing" || comparison === "different") {
        return { status: "empty", pgid: handle.pgid };
      }
      return { status: "unknown", pgid: handle.pgid, reason: "probe_failed" };
    }
    if (this.platform !== "linux" && this.platform !== "darwin") {
      return { status: "unknown", pgid: handle.pgid, reason: "unsupported_platform" };
    }
    try {
      this.probeProcessGroup(-handle.pgid);
      return { status: "nonempty", pgid: handle.pgid };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return { status: "empty", pgid: handle.pgid };
      if (code === "EPERM" || code === "EACCES")
        return { status: "unknown", pgid: handle.pgid, reason: "permission_denied" };
      return { status: "unknown", pgid: handle.pgid, reason: "probe_failed" };
    }
  }

  /** Refuses to signal unless the exact recorded leader identity still owns the PGID. */
  signal(handle: ProcessGroupHandle, signal: NodeJS.Signals): ProcessGroupSignalResult {
    const comparison = this.compareLeader(handle);
    if (comparison !== "same") {
      const reason =
        comparison === "different"
          ? "stale_leader"
          : comparison === "missing"
            ? "missing_leader"
            : "identity_unknown";
      return { status: "unknown", pgid: handle.pgid, signal, reason };
    }
    if (this.platform === "win32") {
      if (!this.killProcessTree) {
        return { status: "unknown", pgid: handle.pgid, signal, reason: "unsupported_platform" };
      }
      // Windows cannot deliver TERM; both escalation steps are the same tree
      // kill, issued only while the recorded identity still owns the pid.
      const outcome = this.killProcessTree(handle.pgid);
      if (outcome === "not_found") return { status: "empty", pgid: handle.pgid, signal };
      if (outcome === "failed") {
        return { status: "unknown", pgid: handle.pgid, signal, reason: "signal_failed" };
      }
      return { status: "sent", pgid: handle.pgid, signal };
    }
    try {
      this.signalProcessGroup(-handle.pgid, signal);
      return { status: "sent", pgid: handle.pgid, signal };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") return { status: "empty", pgid: handle.pgid, signal };
      if (code === "EPERM" || code === "EACCES") {
        return { status: "unknown", pgid: handle.pgid, signal, reason: "permission_denied" };
      }
      return { status: "unknown", pgid: handle.pgid, signal, reason: "signal_failed" };
    }
  }
}

export const defaultProcessGroupService = new ProcessGroupService();
