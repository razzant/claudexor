import { isTerminalLifecycle } from "./status-projection.js";

/**
 * The ONE admission rule of the `continueFrom` run chain (INTERFACES §1),
 * shared by the daemon (the atomic guard inside the enqueue RPC, where the
 * accepted successor command is the durable claim) and the control API (the
 * same verdict answered with its typed context before enqueue). Both the
 * daemon's `JobRecord` and the control plane's `DaemonRunRecord` satisfy the
 * minimal record shape, so neither package depends on the other.
 */
export interface ContinuationRecord {
  id: string;
  state: string;
  runId?: string;
  params?: unknown;
}

export type ContinuationRefusalCode =
  | "continue_from_with_thread"
  | "predecessor_unknown"
  | "predecessor_live"
  | "continuation_superseded"
  | "continue_from_unsupported";

export interface ContinuationRefusal {
  code: ContinuationRefusalCode;
  status: 400 | 404 | 409;
  message: string;
  requiredAction: string;
  context?: { runId: string; state?: string; head?: string };
}

function stringParam(params: unknown, key: string): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The predecessor a request continues (`continueFrom`), or null. */
export function continuedRunOf(params: unknown): string | null {
  return stringParam(params, "continueFrom");
}

/** The record `continueFrom` names (by run id or job id), or undefined. */
export function continuationPredecessor<R extends ContinuationRecord>(
  from: string,
  records: readonly R[],
): R | undefined {
  return records.find((record) => record.runId === from || record.id === from);
}

/** The successor holding `predecessor`'s claim, or null. A successor that
 * settled before its run started (a typed refusal before spawn) touched none
 * of the predecessor's work and holds no claim. */
function successorOf<R extends ContinuationRecord>(
  predecessor: R,
  records: readonly R[],
): R | null {
  return (
    records.find((record) => {
      const from = continuedRunOf(record.params);
      if (from === null || (from !== predecessor.runId && from !== predecessor.id)) return false;
      return !(isTerminalLifecycle(record.state) && !record.runId);
    }) ?? null
  );
}

/** The newest link of a continuation chain: what a caller continues instead
 * of a superseded predecessor (a run id, or the job id while still queued). */
function chainHead<R extends ContinuationRecord>(successor: R, records: readonly R[]): string {
  let head = successor;
  const seen = new Set<string>([head.id]);
  for (let next = successorOf(head, records); next && !seen.has(next.id);) {
    head = next;
    seen.add(head.id);
    next = successorOf(head, records);
  }
  return head.runId ?? head.id;
}

const THREAD_ACTION =
  "Continue a thread through POST /v2/threads/:id/turns; continueFrom continues one-shot runs.";

/** The run shape a successor request names, when its first try cannot carry
 * the predecessor's work: the engine plans one session for the first
 * candidate attempt of an Agent or Ask run, so several racing candidates, a
 * repair loop, a research sweep or a plan would run without it. */
function unsupportedShape(request: unknown): string | null {
  const p = (request ?? {}) as Record<string, unknown>;
  if (p["mode"] === "plan") return "plan";
  if (typeof p["n"] === "number" && p["n"] > 1) return "best-of";
  if (typeof p["attempts"] === "number" || p["untilClean"] === true) return "repair-loop";
  if (p["deepScan"] === true) return "deep-scan";
  return p["council"] === true ? "council" : null;
}

/**
 * Why `request` may not be admitted as a successor now, or null when it may
 * (or when it is no continuation at all). One accepted successor per
 * predecessor: a second request is refused with the chain head it should
 * continue instead; an exact idempotent replay never reaches this rule
 * because replay lookup precedes admission on every ingress.
 */
export function continuationRefusal<R extends ContinuationRecord>(
  request: unknown,
  records: readonly R[],
): ContinuationRefusal | null {
  const from = continuedRunOf(request);
  if (from === null) return null;
  if (stringParam(request, "threadId") !== null) {
    return {
      code: "continue_from_with_thread",
      status: 400,
      message: "continueFrom and threadId are mutually exclusive",
      requiredAction: THREAD_ACTION,
    };
  }
  const shape = unsupportedShape(request);
  if (shape !== null) {
    return {
      code: "continue_from_unsupported",
      status: 400,
      message: `continueFrom continues single-candidate Agent and Ask runs, not a ${shape} run`,
      requiredAction:
        "Continue with a single-candidate Agent or Ask run (omit n, attempts, untilClean, deepScan and council; pass mode explicitly when the predecessor was a plan), or start a new run.",
    };
  }
  const predecessor = continuationPredecessor(from, records);
  // A queued job has no run yet but will: it is live, not unknown.
  if (predecessor && !isTerminalLifecycle(predecessor.state)) {
    const runId = predecessor.runId ?? predecessor.id;
    return {
      code: "predecessor_live",
      status: 409,
      message: `run ${runId} is still ${predecessor.state}; it can be continued once it is terminal`,
      requiredAction: "Wait for the run to finish or cancel it, then continue it.",
      context: { runId, state: predecessor.state },
    };
  }
  if (!predecessor?.runId) {
    return {
      code: "predecessor_unknown",
      status: 404,
      message: `no run ${from} owned by this daemon can be continued`,
      requiredAction: "Pass the id of a run this daemon started (GET /v2/runs lists them).",
    };
  }
  const runId = predecessor.runId;
  if (stringParam(predecessor.params, "threadId") !== null) {
    return {
      code: "continue_from_with_thread",
      status: 400,
      message: `run ${runId} is a thread turn`,
      requiredAction: THREAD_ACTION,
      context: { runId },
    };
  }
  const successor = successorOf(predecessor, records);
  if (!successor) return null;
  const head = chainHead(successor, records);
  return {
    code: "continuation_superseded",
    status: 409,
    message: `run ${runId} was already continued; continue its head ${head} instead`,
    requiredAction: `Continue ${head}, the newest run of this continuation chain.`,
    context: { runId, head },
  };
}

/** The typed error a surface throws for a refusal (problem-response shape). */
export function continuationRefusalError(refusal: ContinuationRefusal): Error {
  return Object.assign(new Error(refusal.message), {
    code: refusal.code,
    status: refusal.status,
    retryable: false,
    requiredActions: [refusal.requiredAction],
    ...(refusal.context ? { context: refusal.context } : {}),
  });
}
