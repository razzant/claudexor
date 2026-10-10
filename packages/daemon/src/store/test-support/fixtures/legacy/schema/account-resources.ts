import { z } from "zod/v3";
import { ControlQuotaResponse } from "./quota.js";
import { ControlQuotaFreshnessResponse } from "./quota-read.js";

import { AccountTarget } from "./account-target.js";
export { AccountTarget } from "./account-target.js";
const instant = z.string().datetime({ offset: true }).nullable();
export const resourceFacet = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      value: value.nullable(),
      source: z.string().nullable(),
      observed_at: instant,
      freshness: z.enum(["fresh", "stale", "unknown"]),
      last_attempt_at: instant,
      last_error: z.string().nullable(),
    })
    .strict();
export const AccountBalance = z
  .object({
    id: z.string(),
    label: z.string(),
    amount: z.string().nullable(),
    unit: z.string(),
    currency: z.string().nullable(),
    decimal_places: z.number().int().nonnegative().nullable(),
    has_balance: z.boolean().nullable(),
    unlimited: z.boolean().nullable(),
  })
  .strict();
export const AccountSpending = z
  .object({
    id: z.string(),
    label: z.string(),
    enabled: z.boolean().nullable(),
    used: z.string().nullable(),
    limit: z.string().nullable(),
    unit: z.string(),
    currency: z.string().nullable(),
    decimal_places: z.number().int().nonnegative().nullable(),
    resets_at: instant,
    reason: z.string().nullable(),
  })
  .strict();
export const AccountResetGrant = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string().nullable(),
    available_count: z.number().int().nonnegative().nullable(),
    total_count: z.number().int().nonnegative().nullable(),
    usable_now: z.boolean().nullable(),
    starts_at: instant,
    expires_at: instant,
    clears: z.array(z.string()),
  })
  .strict();
export const AccountResetOffer = z
  .object({
    id: z.string(),
    kind: z.enum(["granted_reset", "session_refill"]),
    label: z.string(),
    description: z.string().nullable(),
    available_count: z.number().int().nonnegative().nullable(),
    eligible: z.boolean().nullable(),
    usable_now: z.boolean().nullable(),
    reason: z.string().nullable(),
    resets_at: instant,
    weekly_limit_applies: z.boolean(),
    grants: z.array(AccountResetGrant).nullable(),
  })
  .strict();
export type AccountResetOffer = z.infer<typeof AccountResetOffer>;
export const AccountResourceSnapshot = z
  .object({
    target: AccountTarget,
    balances: resourceFacet(z.array(AccountBalance)),
    spending: resourceFacet(z.array(AccountSpending)),
    resets: resourceFacet(z.array(AccountResetOffer)),
    diagnostics: resourceFacet(
      z.array(z.object({ code: z.string(), detail: z.string().nullable() }).strict()),
    ),
  })
  .strict();
export type AccountResourceSnapshot = z.infer<typeof AccountResourceSnapshot>;
export const AccountResourceObservation = AccountResourceSnapshot.partial()
  .required({ target: true })
  .extend({
    // Producer-only coverage: these programs were read, present or absent.
    // The merged public snapshot and its journal record never carry it.
    resets_resolved_ids: z.array(z.string()).optional(),
  });
export type AccountResourceObservation = z.infer<typeof AccountResourceObservation>;
export const AccountResourcesInvalidated = z
  .object({
    version: z.literal(1),
    target: AccountTarget,
    observed_at: z.string().datetime({ offset: true }),
  })
  .strict();
export const AccountResourcesObserved = z
  .object({ version: z.literal(1), observation: AccountResourceObservation })
  .strict();
export const ControlAccountResourcesResponse = ControlQuotaResponse.extend({
  resources: z.array(AccountResourceSnapshot),
}).strict();
export type ControlAccountResourcesResponse = z.infer<typeof ControlAccountResourcesResponse>;
/** Whole-response union of every strict quota read shape. A caller validates
 * the complete payload; a partial view is never stripped down to legacy. */
export const ControlQuotaQueryResponse = z.union([
  ControlQuotaResponse,
  ControlAccountResourcesResponse,
  ControlQuotaFreshnessResponse,
]);
export const ControlAccountResetRequest = z
  .object({
    target: AccountTarget,
    offer_id: z.string().min(1),
    grant_id: z.string().min(1).optional(),
  })
  .strict();
export type ControlAccountResetRequest = z.infer<typeof ControlAccountResetRequest>;
export const ControlAccountResetResponse = z
  .object({
    id: z.string(),
    request: ControlAccountResetRequest,
    state: z.enum(["running", "completed"]),
    created_at: z.string().datetime({ offset: true }),
    completed_at: instant,
    outcome: z.enum([
      "pending",
      "reset",
      "already_redeemed",
      "already_used",
      "nothing_to_reset",
      "no_credit",
      "not_eligible",
      "cooldown",
      "unavailable",
      "unknown",
    ]),
    detail: z.string().nullable(),
    readback: z
      .object({
        state: z.enum(["pending", "fresh", "failed"]),
        attempted_at: instant,
        detail: z.string().nullable(),
      })
      .strict(),
    resources: ControlAccountResourcesResponse.nullable(),
  })
  .strict();
export type ControlAccountResetResponse = z.infer<typeof ControlAccountResetResponse>;

export const ACCOUNT_RESOURCE_FACETS = ["balances", "spending", "resets", "diagnostics"] as const;
export function emptyResourceFacet() {
  return {
    value: null,
    source: null,
    observed_at: null,
    freshness: "unknown" as const,
    last_attempt_at: null,
    last_error: null,
  };
}
export function observedResourceFacet<T>(value: T, source: string, at: Date) {
  return {
    value,
    source,
    observed_at: at.toISOString(),
    freshness: "fresh" as const,
    last_attempt_at: at.toISOString(),
    last_error: null,
  };
}
