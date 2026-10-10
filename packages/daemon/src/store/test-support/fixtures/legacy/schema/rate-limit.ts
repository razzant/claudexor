import { z } from "zod/v3";
import { Id } from "./primitives.js";

/** Typed rate-limit/quota signal produced from native adapter evidence. */
export const RateLimitSignal = z.object({
  constraint_id: Id.optional().describe(
    "Vendor-owned rate-window identity, when the adapter can map it from a typed field.",
  ),
  applies_to_models: z
    .array(Id)
    .nullable()
    .optional()
    .describe(
      "Canonical model ids/aliases this rejection applies to; omitted/null means every model.",
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
