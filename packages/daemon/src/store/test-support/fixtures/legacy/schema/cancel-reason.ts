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

export function normalizeCancelReasonCode(value: unknown): CancelReasonCode | undefined {
  return typeof value === "string" && (CANCEL_REASON_CODES as readonly string[]).includes(value)
    ? (value as CancelReasonCode)
    : undefined;
}
