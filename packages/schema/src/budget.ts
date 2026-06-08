import { z } from "zod";
import { Id, Intent } from "./primitives.js";
import { SignalQuality } from "./harness.js";

export const AuthMode = z.enum(["local_session", "api_key", "unknown"]);
export type AuthMode = z.infer<typeof AuthMode>;

export const SubscriptionPressure = z.enum(["low", "medium", "high", "burn", "unknown"]);
export type SubscriptionPressure = z.infer<typeof SubscriptionPressure>;

export const Portfolio = z.enum([
  "daily-rich",
  "balanced",
  "cheapest",
  "strongest",
  "burn",
  "subscription-first",
  "api-overflow",
  "conserve-claude",
  "conserve-codex",
]);
export type Portfolio = z.infer<typeof Portfolio>;

/** A pre-call reservation. Created before work; settled after. Never post-hoc only. */
export const BudgetLease = z.object({
  lease_id: Id,
  task_id: Id,
  attempt_id: Id.optional(),
  intent: Intent,
  harness_id: Id,
  model_hint: z.string().nullable().default(null),
  auth_mode: AuthMode.default("unknown"),
  budget_class: SignalQuality.default("unknown"),
  max_usd: z.number().nullable().default(null),
  max_tokens: z.number().int().nullable().default(null),
  subscription_pressure_limit: SubscriptionPressure.default("unknown"),
  reason: z.array(z.string()).default([]),
  created_at: z.string(),
  state: z.enum(["reserved", "settled", "cancelled"]).default("reserved"),
});
export type BudgetLease = z.infer<typeof BudgetLease>;

/** An observed quota/usage signal (rate-limit error, used-percent, reset hint). */
export const BudgetObservation = z.object({
  harness_id: Id,
  ts: z.string(),
  quality: SignalQuality,
  kind: z.enum(["spend", "rate_limited", "used_percent", "cooldown", "reset_hint", "manual"]),
  usd: z.number().optional(),
  used_percent: z.number().optional(),
  resets_at: z.string().nullable().optional(),
  cooldown_until: z.string().nullable().optional(),
  detail: z.string().optional(),
});
export type BudgetObservation = z.infer<typeof BudgetObservation>;
