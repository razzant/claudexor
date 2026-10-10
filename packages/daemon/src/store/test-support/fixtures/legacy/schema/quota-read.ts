import { z } from "zod/v3";
import {
  ControlQuotaResponse,
  ControlQuotaSnapshot,
  QuotaConstraint,
  QuotaFreshness,
} from "./quota.js";

/** Response-only schemas: neither persisted evidence nor legacy wire shapes
 * accept constraint freshness. Clients explicitly select the read projection;
 * operation discovery is optional, and old engines may return strict legacy data
 * (3.24) or reject the selector with HTTP 400 (3.25.0/3.25.1). */
export const ControlQuotaReadRequest = z
  .object({ view: z.enum(["resources", "constraint_freshness"]).optional() })
  .strict();
export type ControlQuotaReadRequest = z.infer<typeof ControlQuotaReadRequest>;

export const ControlQuotaFreshnessSnapshot = ControlQuotaSnapshot.extend({
  constraints: z.array(
    QuotaConstraint.extend({
      freshness: QuotaFreshness.describe(
        "Read-time freshness from raw snapshot freshness, observation age (stale after 300000ms), and this constraint's own reset (stale at equality); a reset cutoff stales earlier evidence. Never inferred from aggregate freshness or a sibling reset; no refill is inferred. The compatibility reset_credits row reports its resets facet's freshness instead.",
      ),
    }),
  ),
});
export type ControlQuotaFreshnessSnapshot = z.infer<typeof ControlQuotaFreshnessSnapshot>;

export const ControlQuotaFreshnessResponse = ControlQuotaResponse.extend({
  snapshots: z.array(ControlQuotaFreshnessSnapshot),
}).describe(
  "Opt-in GET /v2/quota?view=constraint_freshness response. Adds constraint freshness while preserving aggregate snapshot freshness and all observed values. No refresh or durable write.",
);
export type ControlQuotaFreshnessResponse = z.infer<typeof ControlQuotaFreshnessResponse>;
