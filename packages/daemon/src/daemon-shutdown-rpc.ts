import { type CancelReasonCode, DaemonStopSender } from "@claudexor/schema";
import type { DaemonLeaseOwner } from "./writer-lease.js";

export class JobAbortController extends AbortController {
  stopSender?: DaemonStopSender;

  shutdown(sender?: DaemonStopSender): void {
    if (this.signal.aborted) return;
    this.stopSender = sender;
    this.abort("host_cancelled" satisfies CancelReasonCode);
  }
}

export interface RuntimeReplacementIdentity {
  version: string;
  buildSha: string;
}

export interface RuntimeReplacementTarget extends RuntimeReplacementIdentity {
  leaseOwner: Pick<DaemonLeaseOwner, "pid" | "token">;
}

/** Exact serving authority configured into one daemon closure. */
export interface RuntimeReplacementAuthority {
  runtimeIdentity?: RuntimeReplacementIdentity;
  runtimeLeaseOwner?: Pick<DaemonLeaseOwner, "pid" | "token">;
}

export type DaemonShutdownRpcReceipt = {
  ok: true;
  fenced?: true;
  targetBound?: true;
};

function activityUnknown(message: string): Error {
  return Object.assign(new Error(message), {
    code: "runtime_activity_unknown",
    status: 503,
    retryable: true,
  });
}

function exactIdentity(value: unknown): RuntimeReplacementIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { version?: unknown; buildSha?: unknown };
  if (
    typeof candidate.version !== "string" ||
    candidate.version.length === 0 ||
    typeof candidate.buildSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(candidate.buildSha)
  ) {
    return null;
  }
  return { version: candidate.version, buildSha: candidate.buildSha };
}

function exactTarget(value: unknown): RuntimeReplacementTarget | null {
  const identity = exactIdentity(value);
  if (!identity || !value || typeof value !== "object") return null;
  const leaseOwner = (value as { leaseOwner?: unknown }).leaseOwner;
  if (!leaseOwner || typeof leaseOwner !== "object") return null;
  const candidate = leaseOwner as { pid?: unknown; token?: unknown };
  if (
    !Number.isSafeInteger(candidate.pid) ||
    Number(candidate.pid) <= 0 ||
    typeof candidate.token !== "string" ||
    candidate.token.length === 0
  ) {
    return null;
  }
  return { ...identity, leaseOwner: { pid: Number(candidate.pid), token: candidate.token } };
}

export function replacementRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === "runtime_replacement_busy" || code === "runtime_activity_unknown";
}

/** Socket shutdown protocol owner. Ordinary operator shutdown stays delayed and
 * forceful. Runtime replacement instead runs one synchronous activity check and
 * composition callback; that callback must check setup then enter the shared
 * shutdown state machine before returning its promise. */
export function dispatchShutdownRpc(
  method: string,
  params: unknown,
  transientActivity: number,
  readRecords: () => Iterable<{ state: string }>,
  requestOperatorShutdown: (sender: DaemonStopSender) => Promise<void>,
  requestRuntimeReplacement?: () => Promise<void>,
  configuredRuntimeIdentity?: RuntimeReplacementIdentity,
  configuredLeaseOwner?: Pick<DaemonLeaseOwner, "pid" | "token">,
): DaemonShutdownRpcReceipt | null {
  if (method === "claudexor.shutdown") {
    const value = params && typeof params === "object" && "sender" in params ? params.sender : null;
    const sender = DaemonStopSender.safeParse(value).data ?? {};
    setTimeout(() => {
      void requestOperatorShutdown(sender).catch(() => {
        // Fail closed: the process and ownership lease remain alive. The
        // composition root records the detailed failure in its private log.
      });
    }, 10);
    return { ok: true };
  }
  if (method !== "claudexor.shutdownForRuntimeReplacement") return null;

  // Bind replacement admission to the exact runtime the caller observed. This
  // comparison shares the same synchronous event-loop turn as the activity
  // check and admission fence below, so a stale handshake can never stop a
  // different serving closure. Missing/unstamped authority fails closed.
  const expected = exactTarget(params);
  const configured = exactIdentity(configuredRuntimeIdentity);
  if (
    !expected ||
    !configured ||
    !configuredLeaseOwner ||
    expected.version !== configured.version ||
    expected.buildSha !== configured.buildSha ||
    expected.leaseOwner.pid !== configuredLeaseOwner.pid ||
    expected.leaseOwner.token !== configuredLeaseOwner.token
  ) {
    throw activityUnknown("runtime replacement serving process identity could not be proven");
  }

  let busy: boolean;
  try {
    busy =
      transientActivity > 0 ||
      [...readRecords()].some((record) => record.state === "queued" || record.state === "running");
  } catch (cause) {
    throw Object.assign(new Error("runtime replacement could not prove daemon activity state"), {
      code: "runtime_activity_unknown",
      status: 503,
      retryable: true,
      cause,
    });
  }
  if (busy) {
    throw Object.assign(new Error("runtime replacement is deferred while daemon work is active"), {
      code: "runtime_replacement_busy",
      status: 409,
      retryable: true,
    });
  }
  if (!requestRuntimeReplacement) {
    throw Object.assign(new Error("runtime replacement admission authority is unavailable"), {
      code: "runtime_activity_unknown",
      status: 503,
      retryable: true,
    });
  }

  // No await or timer separates the daemon activity check from this callback.
  // Its synchronous prefix checks setup and fences setup/control/run admission.
  const operation = requestRuntimeReplacement();
  void operation.catch(() => {
    // An accepted stop may close the response socket. The caller proves the
    // pinned daemon's termination rather than trusting response delivery.
  });
  return { ok: true, fenced: true, targetBound: true };
}
