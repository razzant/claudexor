import type { HarnessEvent } from "@claudexor/schema";

/**
 * #299: the one typed error an adapter emits when the vendor ended a native
 * turn at the run's max-turns cap before a final answer (claude and grok
 * `error_max_turns`). It is an error, so a consumer that only knows errors
 * never takes the partial narration for an answer, and the run loop treats the
 * CLI's following non-zero exit as the harness's own report, not a crash. The
 * engine reads `turn_limit` and reports `interrupted / turn_limit_reached`; it
 * never resumes or replays the turn under the same cap.
 */
export function turnLimitError(
  sessionId: string,
  ts: string,
  nativeCode: string,
  numTurns: unknown,
): HarnessEvent {
  const turns =
    typeof numTurns === "number" && Number.isInteger(numTurns) && numTurns >= 0 ? numTurns : null;
  return {
    type: "error",
    session_id: sessionId,
    ts,
    error: `max-turns limit reached${turns === null ? "" : ` after ${turns} turns`} before a final answer; the partial work is kept`,
    turn_limit: { native_code: nativeCode, num_turns: turns },
  };
}
