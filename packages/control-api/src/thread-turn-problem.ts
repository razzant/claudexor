import { TRUST_FULL_ACCESS_CODE } from "@claudexor/schema";
import { projectControlProblem, type ProjectedControlProblem } from "./problem-response.js";

export function routeProblem(
  err: unknown,
  fallbackStatus: number,
  fallbackMessage: string,
  context: Record<string, unknown> = {},
): ProjectedControlProblem {
  const projected = projectControlProblem(err, {
    status: fallbackStatus,
    code: (status) => `http_${status}`,
    retryable: false,
    message: fallbackMessage,
  });
  return {
    status: projected.status,
    body: {
      ...projected.body,
      context: { ...projected.body.context, ...context },
    },
  };
}

/** HTTP status for a pre-start terminal turn (W24). Refusal semantics are born
 * AT THE THROW: a typed refusal carries its status (trust=403,
 * requirements=400, journal recovery=503) and the daemon persists it onto the
 * job record — that persisted status wins. Without one, only the known trust
 * code keeps its legacy 403; any OTHER bare `code` (an errno like ENOENT, an
 * ABORT_ERR) is an infra failure and stays 500 so genuine transient failures
 * are still retried — a string code alone never proves a client-actionable
 * refusal.
 */
export function preStartRefusalStatus(errorCode: string | undefined, errorStatus?: number): number {
  if (
    typeof errorStatus === "number" &&
    Number.isInteger(errorStatus) &&
    errorStatus >= 400 &&
    errorStatus <= 599
  ) {
    return errorStatus;
  }
  if (errorCode === TRUST_FULL_ACCESS_CODE) return 403;
  return 500;
}

/** A typed throw's machine code (e.g. the trust gate's), null when absent or
 * non-string (a numeric errno-style `code` must not leak into the typed
 * refusal contract). ONE owner — daemon-server's refusal recorder reuses it. */
export function errCode(err: unknown): string | null {
  try {
    const code =
      err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
    return typeof code === "string" && code ? code : null;
  } catch {
    return null;
  }
}

function errorField(err: unknown, key: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  try {
    return (err as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function hasTypedEnqueueProblem(err: unknown): boolean {
  const status = errorField(err, "status");
  return (
    (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) ||
    typeof errorField(err, "retryable") === "boolean" ||
    errorField(err, "fieldErrors") !== undefined ||
    errorField(err, "requiredActions") !== undefined ||
    errorField(err, "evidenceRefs") !== undefined ||
    errorField(err, "context") !== undefined
  );
}

/**
 * Persist an enqueue failure on a pre-created turn (refused-turn honesty,
 * INV-093). Shared by every pre-create-then-enqueue path OUTSIDE these
 * routes (direct POST /runs with threadId, rerun_with_feedback). Marked
 * retryable=false: these are enqueue-throw paths — no job was recorded, so
 * the retry endpoint has nothing to replay. Best-effort by
 * contract: recording must never mask the original error (callers always
 * return it), and errCode yields null for absent/non-string codes.
 */
export function recordTurnEnqueueFailure(
  setTurnEnqueueError:
    | ((turnId: string, message: string, code: string | null, retryable?: boolean) => void)
    | undefined,
  turnId: string | undefined,
  err: unknown,
): void {
  if (!turnId || !setTurnEnqueueError) return;
  try {
    const projected = projectControlProblem(err, {
      status: 500,
      code: "turn_enqueue_failed",
      retryable: false,
    });
    const rawCode = errCode(err);
    const code =
      rawCode && hasTypedEnqueueProblem(err) && projected.body.code === rawCode ? rawCode : null;
    setTurnEnqueueError(turnId, projected.body.message, code, false);
  } catch {
    /* recording the refusal must not mask the original error */
  }
}
