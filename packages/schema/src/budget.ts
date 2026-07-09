import { z } from "zod";
import { Id, Intent } from "./primitives.js";
import { SignalQuality } from "./harness.js";

export const AuthMode = z
  .enum(["local_session", "api_key", "unknown"])
  .describe("Auth mode a route runs under: a native local session, an API key, or unknown.");
export type AuthMode = z.infer<typeof AuthMode>;

export const Portfolio = z
  .enum([
    "daily-rich",
    "balanced",
    "cheapest",
    "strongest",
    "burn",
    "subscription-first",
    "api-overflow",
    "conserve-claude",
    "conserve-codex",
  ])
  .describe(
    "Budget portfolio weighting the harness router's quality/cost/latency and subscription-vs-API preferences (e.g. cheapest minimizes spend, burn maximizes quality, conserve-* deprioritizes one vendor).",
  );
export type Portfolio = z.infer<typeof Portfolio>;

/** A pre-call reservation. Created before work; settled after. Never post-hoc only. */
export const BudgetLease = z
  .object({
    lease_id: Id.describe("Lease id."),
    task_id: Id.describe("Task the lease belongs to."),
    attempt_id: Id.optional().describe("Attempt the lease covers, when scoped to one."),
    intent: Intent,
    harness_id: Id.describe("Harness the reservation is for."),
    model_hint: z.string().nullable().default(null).describe("Requested model for the reserved call; null = harness default."),
    max_usd: z.number().nullable().default(null).describe("USD cap reserved for the call; null = no cap."),
    reason: z.array(z.string()).default([]).describe("Human-readable reasons the lease was created."),
    created_at: z.string().describe("When the lease was created."),
    state: z
      .enum(["reserved", "settled", "cancelled"])
      .default("reserved")
      .describe("Lifecycle state: reserved before work, settled after, or cancelled."),
  })
  .describe("A pre-call budget reservation, created before work and settled after; never post-hoc only.");
export type BudgetLease = z.infer<typeof BudgetLease>;

/** An observed quota/usage signal (rate-limit error, used-percent, reset hint). */
export const BudgetObservation = z
  .object({
    harness_id: Id.describe("Harness the observation is about."),
    ts: z.string().describe("When the signal was observed."),
    quality: SignalQuality,
    kind: z
      .enum(["spend", "rate_limited", "used_percent", "cooldown", "manual"])
      .describe("What was observed: spend, a rate-limit hit, a used-percent reading, a cooldown, or a manual entry."),
    usd: z.number().optional().describe("Observed spend in USD, for spend observations."),
    used_percent: z.number().optional().describe("Consumed share of the rate window (0-100), for used_percent observations."),
    resets_at: z.string().nullable().optional().describe("When the rate window resets, when reported."),
    cooldown_until: z.string().nullable().optional().describe("Until when the harness is in cooldown, when set."),
    detail: z.string().optional().describe("Redacted human-readable detail."),
  })
  .describe("An observed quota/usage signal (rate-limit error, used-percent, reset hint) recorded in the budget ledger.");
export type BudgetObservation = z.infer<typeof BudgetObservation>;
