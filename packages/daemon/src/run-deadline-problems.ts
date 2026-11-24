/**
 * Typed refusals of run-deadline/1 and the one conversion of an absolute
 * instant to the host clock, shared by the registry and the scheduler.
 */
import { RunDeadlineStart } from "@claudexor/schema";
import type { RunDeadlineClock } from "./run-deadline-clock.js";

export function deadlineProblem(
  message: string,
  code: string,
  status = 409,
  retryable = false,
): Error & { code: string; status: number; retryable: boolean } {
  return Object.assign(new Error(message), { code, status, retryable });
}

export const RUN_DEADLINE_EXPIRED = "run_deadline_expired" as const;
export const deadlineExpired = (message = "Run deadline already passed") =>
  deadlineProblem(message, RUN_DEADLINE_EXPIRED);

/** An absolute deadline converted once to the host clock. */
export interface DeadlinePoint {
  at: string;
  target: bigint;
}

/** What a job's record is made of when it is staged. */
export interface DeadlineSpec {
  own: DeadlinePoint | null;
  successorOf: string | null;
  parentJobId: string | null;
}

/** The record could not be written: nothing was confirmed; retry. */
export function recordUnavailable(error: unknown): Error {
  return Object.assign(
    deadlineProblem(
      `the deadline record could not be written: ${(error as Error).message}`,
      "run_deadline_record_unavailable",
      503,
      true,
    ),
    { cause: error },
  );
}

/**
 * A change became visible but could not be confirmed (its durability, or the
 * earlier deadline it would replace, could not be recorded): the caller reads
 * the deadline again (GET) before relying on either.
 */
export function outcomeUnknown(message: string, cause?: unknown): Error {
  return Object.assign(deadlineProblem(message, "run_deadline_outcome_unknown", 503, true), {
    cause,
  });
}

/** Parse an optional `deadline` from a run request; undefined when absent. */
export function requestedDeadline(params: unknown): RunDeadlineStart | undefined {
  if (!params || typeof params !== "object") return undefined;
  const raw = (params as { deadline?: unknown }).deadline;
  if (raw === undefined) return undefined;
  const parsed = RunDeadlineStart.safeParse(raw);
  if (!parsed.success)
    throw deadlineProblem("deadline.at is not a valid instant", "run_deadline_invalid", 400);
  return parsed.data;
}

/** Convert an absolute instant once, now; refuse one that is not in the future. */
export function convertInstant(at: string, clock: RunDeadlineClock): DeadlinePoint {
  const wall = Date.parse(at);
  const now = clock.wallNow();
  if (!Number.isFinite(wall))
    throw deadlineProblem("deadline.at is not a valid instant", "run_deadline_invalid", 400);
  if (wall <= now)
    throw deadlineProblem(
      `deadline.at ${at} is not after the server time ${new Date(now).toISOString()}`,
      "run_deadline_passed",
    );
  return {
    at: new Date(wall).toISOString(),
    target: clock.hostNow() + BigInt(wall - now) * 1_000_000n,
  };
}
