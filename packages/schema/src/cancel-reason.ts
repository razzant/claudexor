/** The closed cancellation-class vocabulary a run control may carry.
 *
 * Every hop of the cancel chain types against it, and BOTH ingress boundaries
 * validate: RunControl's zod enum at the HTTP route and
 * `normalizeCancelReasonCode` at the raw daemon RPC — an unvalidated string
 * reaching AbortController.abort() forged wall_clock_exceeded terminals and
 * leaked raw text into final/summary.md. Absent code coerces downstream to
 * user_cancelled (wire compatibility).
 */
export const CANCEL_REASON_CODES = ["user_cancelled", "host_cancelled", "owner_task_gone"] as const;
export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

/** Abort tokens of the engine's own clocks: the maxSeconds / time-limit clock
 * and the server-enforced run deadline (run-deadline/1). Daemon-internal, never
 * client input, so neither ingress can forge them; each is its run's terminal
 * reason as it stands. */
export const ENGINE_CLOCK_ABORT_REASONS = ["wall_clock_exceeded", "run_deadline_expired"] as const;
export type EngineClockAbortReason = (typeof ENGINE_CLOCK_ABORT_REASONS)[number];

export function engineClockAbortReason(value: unknown): EngineClockAbortReason | undefined {
  return typeof value === "string" &&
    (ENGINE_CLOCK_ABORT_REASONS as readonly string[]).includes(value)
    ? (value as EngineClockAbortReason)
    : undefined;
}

/** The cancelled terminal's summary for an abort token. */
export function cancelSummaryOf(reason: unknown): string {
  switch (engineClockAbortReason(reason)) {
    case "wall_clock_exceeded":
      return "run cancelled: wall-clock deadline (maxSeconds) exceeded";
    case "run_deadline_expired":
      return "run cancelled: its server-enforced deadline (run-deadline/1) was reached";
    default:
      return "run cancelled";
  }
}

export function normalizeCancelReasonCode(value: unknown): CancelReasonCode | undefined {
  return typeof value === "string" && (CANCEL_REASON_CODES as readonly string[]).includes(value)
    ? (value as CancelReasonCode)
    : undefined;
}
