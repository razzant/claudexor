import { QuotaRequestKind } from "./quota.js";
import { z } from "zod/v3";
import { Id } from "./primitives.js";

/** Typed rate-limit/quota signal produced from native adapter evidence. */
export const RateLimitSignal = z.object({
  constraint_id: Id.optional().describe(
    "Vendor-owned rate-window identity, when the adapter can map it from a typed field.",
  ),
  applies_to_request_kinds: z.array(QuotaRequestKind).min(1).optional(),
  applies_to_models: z
    .array(Id)
    .nullable()
    .optional()
    .describe(
      "Canonical model ids/aliases this rejection applies to; omitted/null (with no prefixes) means every model.",
    ),
  applies_to_model_prefixes: z
    .array(Id)
    .optional()
    .describe(
      "Producer-declared model-family prefixes this rejection also applies to, as on QuotaConstraint.",
    ),
  resets_at: z
    .string()
    .nullable()
    .default(null)
    .describe("When the rate window resets, when reported."),
  retry_delay_ms: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .default(null)
    .describe("Suggested retry delay in milliseconds, when reported."),
  reopening: z
    .enum(["unknown"])
    .optional()
    .describe(
      "unknown: the vendor's own typed code refused further usage on this account and named no reopening time, and the refusal is not known to be a timed window (Codex usage_limit_exceeded and AGY's structured `Individual quota reached` also cover refusals whose scope is not a timed window). No reset is derived from it; the vendor's original failure evidence remains alongside the signal. Admission/continuation consumers decide whether the account is retried, and a typed refusal must not be mistaken for a transport failure. Absent: resets_at, retry_delay_ms and the vendor's window say when to come back, as before.",
    ),
});
export type RateLimitSignal = z.infer<typeof RateLimitSignal>;

/**
 * End of a vendor-reported DAY-granular reset day as a UTC instant — the
 * honest cooldown bound when a vendor names the reset day but no instant
 * (cursor's "your monthly cycle ends on M/D/YYYY", carried by the adapter as
 * `payload.vendor_reset_day = "YYYY-MM-DD"` precisely because fabricating a
 * midnight `resets_at` would overclaim). Next-midnight UTC covers the whole
 * named day; null for an absent, malformed, or non-calendar value.
 */
export function vendorResetDayCooldownEnd(payload: unknown): string | null {
  const day =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)["vendor_reset_day"]
      : null;
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  // Date.parse rolls invalid calendar days over (Feb 31 -> Mar 3); the
  // round-trip check rejects a value that names no real day.
  if (!Number.isFinite(start) || !new Date(start).toISOString().startsWith(day)) return null;
  return new Date(start + 24 * 60 * 60_000).toISOString();
}
