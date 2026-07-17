import { z } from "zod";
import { BillingKnowledge, CostKnowledge } from "./auth.js";
import { Id, Intent } from "./primitives.js";
import { EffortHint, SignalQuality } from "./harness.js";

export const PaidBudget = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("unlimited") }).strict(),
    z.object({ kind: z.literal("finite"), maxUsd: z.number().nonnegative() }).strict(),
  ])
  .describe("Incremental-cash budget: explicitly unlimited or a finite non-negative USD cap.");
export type PaidBudget = z.infer<typeof PaidBudget>;

export const CostEvidence = z
  .object({
    knowledge: CostKnowledge,
    billing: BillingKnowledge,
    source: z.string().min(1),
    provenance: z.array(z.string().min(1)).min(1),
    estimatedUsd: z.number().nonnegative().nullable().default(null),
  })
  .strict()
  .describe("Incremental-cash cost knowledge with its source and evidence provenance.");
export type CostEvidence = z.infer<typeof CostEvidence>;

export const AuthMode = z
  .enum(["local_session", "api_key", "unknown"])
  .describe("Auth mode a route runs under: a native local session, an API key, or unknown.");
export type AuthMode = z.infer<typeof AuthMode>;

export const RoutingGoal = z
  .enum(["auto", "quality", "economy"])
  .describe(
    "Routing objective: pace expiring quota, choose the highest declared quality tier, or minimize incremental paid spend.",
  );
export type RoutingGoal = z.infer<typeof RoutingGoal>;

export const PaidFallback = z
  .enum(["never", "when_unavailable", "allowed_within_cap"])
  .describe("When a route with incremental paid spend may be used.");
export type PaidFallback = z.infer<typeof PaidFallback>;

export const QualityTierRoute = z
  .object({
    harness: Id,
    model: z.string().min(1),
    effort: EffortHint,
  })
  .strict()
  .describe("An exact harness, model, and effort route declared by the user.");
export type QualityTierRoute = z.infer<typeof QualityTierRoute>;

export const QualityTier = z
  .array(QualityTierRoute)
  .min(1)
  .describe("A group of comparable exact routes at one user-declared quality level.");
export type QualityTier = z.infer<typeof QualityTier>;

export const QualityTierSet = z
  .record(Intent, z.array(QualityTier))
  .default({})
  .describe(
    "Per-intent quality tiers ordered highest to lowest; no provider or benchmark priors are inferred.",
  );
export type QualityTierSet = z.infer<typeof QualityTierSet>;

/** A pre-call reservation. Created before work; settled after. Never post-hoc only. */
export const BudgetLease = z
  .object({
    lease_id: Id.describe("Lease id."),
    task_id: Id.describe("Task the lease belongs to."),
    attempt_id: Id.optional().describe("Attempt the lease covers, when scoped to one."),
    intent: Intent,
    harness_id: Id.describe("Harness the reservation is for."),
    model_hint: z
      .string()
      .nullable()
      .default(null)
      .describe("Requested model for the reserved call; null = harness default."),
    cost: CostEvidence,
    reason: z
      .array(z.string())
      .default([])
      .describe("Human-readable reasons the lease was created."),
    created_at: z.string().describe("When the lease was created."),
    state: z
      .enum(["reserved", "settled", "cancelled"])
      .default("reserved")
      .describe("Lifecycle state: reserved before work, settled after, or cancelled."),
  })
  .describe(
    "A pre-call budget reservation, created before work and settled after; never post-hoc only.",
  );
export type BudgetLease = z.infer<typeof BudgetLease>;

/** An observed quota/usage signal (rate-limit error, used-percent, reset hint). */
export const BudgetObservation = z
  .object({
    harness_id: Id.describe("Harness the observation is about."),
    /** Credential route the signal was observed on (round-17 #2); absent on
     * legacy/synthetic observations. */
    credential_route: z
      .enum(["vendor_native", "managed_api_key", "local"])
      .optional()
      .describe("Credential route the signal was observed on, when known."),
    /** The credential subject the signal belongs to (round-17 #2): a
     * credential-profile id, null for the engine default. Cooldown/pace
     * queries filter by exact subject so profile A's limit never penalizes
     * profile B or the default. */
    subject_id: z
      .string()
      .nullable()
      .optional()
      .describe("Credential-profile subject of the signal; null = engine default."),
    ts: z.string().describe("When the signal was observed."),
    quality: SignalQuality,
    kind: z
      .enum(["spend", "rate_limited", "quota_constraint", "cooldown"])
      .describe(
        "What was observed: spend, a rate-limit hit, one independent quota constraint, or a cooldown.",
      ),
    usd: z.number().optional().describe("Observed spend in USD, for spend observations."),
    constraint_id: z.string().optional(),
    used_ratio: z.number().min(0).max(1).nullable().optional(),
    window_seconds: z.number().positive().nullable().optional(),
    resets_at: z
      .string()
      .nullable()
      .optional()
      .describe("When the rate window resets, when reported."),
    cooldown_until: z
      .string()
      .nullable()
      .optional()
      .describe("Until when the harness is in cooldown, when set."),
    detail: z.string().optional().describe("Redacted human-readable detail."),
  })
  .describe(
    "An observed quota/usage signal (rate-limit error, used-percent, reset hint) recorded in the budget ledger.",
  );
export type BudgetObservation = z.infer<typeof BudgetObservation>;
