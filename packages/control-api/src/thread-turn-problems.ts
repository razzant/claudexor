/** Typed refused-turn problems shared by every thread-turn producer (INV-093). */
import { TRUST_FULL_ACCESS_CODE } from "@claudexor/schema";
import type { TurnEnqueueProblem } from "@claudexor/schema";
import {
  safeProblemContext,
  safeProblemMessage,
  safeProblemRequiredActions,
} from "@claudexor/util";

/** The engine's refusal of a reference to a released managed resource (#249). Other
 * replay refusals leave a turn replayable; no replay of these params can ever pass. */
export const RESOURCE_RELEASED = "resource_released";

export function errStatus(err: unknown, fallback = 400): number {
  return err && typeof err === "object" && "status" in err
    ? Number((err as { status: number }).status)
    : fallback;
}

/**
 * HTTP status for a pre-start terminal turn (W24). Refusal semantics are born
 * AT THE THROW: a typed refusal carries its status (trust=403,
 * requirements=400, journal recovery=503) and the daemon persists it onto the
 * job record — that persisted status wins. Without one, only the known trust
 * code keeps its legacy 403; any OTHER bare `code` (an errno like ENOENT, an
 * ABORT_ERR) is an infra failure and stays 500 so genuine transient failures
 * are still retried — a string code alone never proves a client-actionable
 * refusal.
 */
export function preStartRefusalStatus(errorCode: string | undefined, errorStatus?: number): number {
  if (typeof errorStatus === "number" && errorStatus >= 400 && errorStatus <= 599) {
    return errorStatus;
  }
  if (errorCode === TRUST_FULL_ACCESS_CODE) return 403;
  return 500;
}

/** A typed throw's machine code (e.g. the trust gate's), null when absent or
 * non-string (a numeric errno-style `code` must not leak into the typed
 * refusal contract). ONE owner — daemon-server's refusal recorder reuses it. */
export function errCode(err: unknown): string | null {
  const code =
    err && typeof err === "object" && "code" in err ? (err as { code: unknown }).code : null;
  return typeof code === "string" && code ? code : null;
}

/**
 * Persist an enqueue failure on a pre-created turn (refused-turn honesty,
 * INV-093). Shared by every pre-create-then-enqueue path OUTSIDE these
 * routes (direct POST /runs with threadId, rerun_with_feedback). A typed refusal
 * recorded no job (retryable=false); a lost answer (retryable transport failure)
 * may hide an accepted job, so retry resolves it from the journal. Best-effort by
 * contract: recording must never mask the original error (callers always
 * return it), and errCode yields null for absent/non-string codes.
 */
export function recordTurnEnqueueFailure(
  setTurnEnqueueError: ((turnId: string, problem: TurnEnqueueProblem) => void) | undefined,
  turnId: string | undefined,
  err: unknown,
): TurnEnqueueProblem {
  const problem = problemFromError(err, Object(err).retryable === true);
  if (!turnId || !setTurnEnqueueError) return problem;
  try {
    setTurnEnqueueError(turnId, problem);
  } catch {
    /* recording the refusal must not mask the original error */
  }
  return problem;
}

export function problemFromError(err: unknown, retryable: boolean): TurnEnqueueProblem {
  const source = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  return {
    // This exact object feeds BOTH setTurnEnqueueError and the HTTP response.
    // Sanitize once here so the durable and wire views cannot diverge.
    message: safeProblemMessage(err),
    code: errCode(err),
    retryable,
    required_actions: safeProblemRequiredActions(source["requiredActions"]),
    context: safeProblemContext(source["context"]),
  };
}

/**
 * Project the same typed refusal used by durable thread storage onto the HTTP
 * problem boundary. Durable storage uses snake_case while ControlProblem uses
 * camelCase; keeping this conversion here prevents one surface from silently
 * dropping remediation or recovery context.
 */
export function turnEnqueueProblemResponse(
  problem: TurnEnqueueProblem,
  identifiers: { threadId?: string; turnId?: string },
): Record<string, unknown> {
  return {
    error: problem.message,
    ...(problem.code ? { code: problem.code } : {}),
    retryable: problem.retryable,
    requiredActions: problem.required_actions,
    context: {
      ...problem.context,
      ...(identifiers.threadId ? { threadId: identifiers.threadId } : {}),
      ...(identifiers.turnId ? { turnId: identifiers.turnId } : {}),
    },
  };
}
