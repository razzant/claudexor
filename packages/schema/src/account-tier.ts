import { z } from "zod/v3";
import { EffortHint } from "./effort.js";
import { Id } from "./primitives.js";

/**
 * Account tiers and the complexity route table (INV-135, INV-140: routing
 * picks WHO executes). A tier is a property of an account row of any harness;
 * the table maps a run's stated complexity to ordered route candidates. The
 * selection that reads them is deterministic and harness-agnostic: no branch
 * depends on which vendor an account belongs to, and no model is ever asked.
 */
export const AccountTier = z
  .enum(["primary", "auxiliary"])
  .describe(
    "Routing tier of an account row for runs that state a complexity: auxiliary accounts are used first; a primary account serves only below the configured reserve.",
  );
export type AccountTier = z.infer<typeof AccountTier>;

/** A spend allowance for one account over a fixed repeating period. */
export const UsageAllowance = z
  .object({
    usd: z.number().positive().describe("Allowance in USD for one period."),
    period_start: z
      .string()
      .datetime({ offset: true })
      .describe("Start of the first period; later periods repeat every period_days from it."),
    period_days: z.number().positive().max(366).describe("Length of one period in days."),
  })
  .strict()
  .describe(
    "Configured spend allowance of one account: USD per fixed period. No allowance is built in.",
  );
export type UsageAllowance = z.infer<typeof UsageAllowance>;

/** The allowance period containing `now`; null before the first period starts. */
export function usagePeriodAt(
  allowance: Pick<UsageAllowance, "period_start" | "period_days">,
  now: number,
): { start: number; end: number } | null {
  const first = Date.parse(allowance.period_start);
  const length = allowance.period_days * 86_400_000;
  if (!Number.isFinite(first) || !(length > 0) || now < first) return null;
  const start = first + Math.floor((now - first) / length) * length;
  return { start, end: start + length };
}

export const ComplexityLevel = z
  .enum(["easy", "medium", "hard"])
  .describe("Complexity a run states for itself; selects the route candidates to consider.");
export type ComplexityLevel = z.infer<typeof ComplexityLevel>;

export const ComplexityRoute = z
  .object({
    harness: Id,
    model: z.string().min(1),
    effort: EffortHint.optional(),
  })
  .strict()
  .describe("One route candidate: a harness, an exact model and an optional reasoning effort.");
export type ComplexityRoute = z.infer<typeof ComplexityRoute>;

export const ComplexityRouteTable = z
  .record(ComplexityLevel, z.array(ComplexityRoute).min(1))
  .default({})
  .superRefine((table, ctx) => {
    for (const [level, routes] of Object.entries(table)) {
      const seen = new Set<string>();
      for (const route of routes ?? []) {
        if (seen.has(route.harness))
          ctx.addIssue({
            code: "custom",
            message: `complexity_routes.${level} lists harness ${route.harness} more than once`,
          });
        seen.add(route.harness);
      }
    }
  })
  .describe(
    "Ordered route candidates per complexity level; a harness appears at most once per level. Empty by default: nothing is built in.",
  );
export type ComplexityRouteTable = z.infer<typeof ComplexityRouteTable>;

export const AccountTierPolicy = z
  .object({
    primary_reserve: z
      .object({
        weekly_used_ratio: z
          .number()
          .min(0)
          .max(1)
          .default(0.85)
          .describe(
            "A primary account serves a complexity run only while every long quota window is below this used ratio.",
          ),
        short_window_used_ratio: z
          .number()
          .min(0)
          .max(1)
          .default(0.9)
          .describe("The same ceiling for short quota windows."),
        short_window_max_seconds: z
          .number()
          .positive()
          .default(86_400)
          .describe(
            "A quota window at most this long is short; a longer one, or one of unknown length, is judged by weekly_used_ratio.",
          ),
      })
      .strict()
      .default({})
      .describe("The share of a primary account kept for runs that state no complexity."),
    allowances: z
      .object({ primary: UsageAllowance.optional(), auxiliary: UsageAllowance.optional() })
      .strict()
      .default({})
      .describe("Default spend allowance per tier, for account rows that carry none."),
  })
  .strict()
  .describe("How tiered accounts serve runs that state a complexity.");
export type AccountTierPolicy = z.infer<typeof AccountTierPolicy>;

/** Identity of the quota window a configured allowance period is reported as. */
export const USAGE_PERIOD_CONSTRAINT_ID = "usage_period";

export const ComplexityRouteBlock = z
  .enum([
    "lane_unavailable",
    "account_not_ready",
    "account_exhausted",
    "owner_reserve",
    "primary_quota_unknown",
    "budget_or_cooldown",
    "refused",
  ])
  .describe(
    "Why a route candidate or one of its accounts could not serve a complexity run: the harness lane was unavailable, no account was ready, the provider reports a spent window or cooldown, usage reached the owner's reserve (the primary reserve included), a primary account's quota is unknown, the budget router excluded the lane, or another typed refusal.",
  );
export type ComplexityRouteBlock = z.infer<typeof ComplexityRouteBlock>;

export const ComplexityAccountEvidence = z
  .object({
    profile_id: Id,
    tier: AccountTier.nullable(),
    blocked_by: ComplexityRouteBlock,
    resets_at: z.string().nullable().describe("When this account's block lifts, when known."),
  })
  .describe("One account of a refused route candidate and what blocked it.");
export type ComplexityAccountEvidence = z.infer<typeof ComplexityAccountEvidence>;

export const ComplexityCandidateEvidence = z
  .object({
    harness_id: Id,
    model: z.string().min(1),
    effort: EffortHint.nullable(),
    profile_id: Id.nullable().describe("The account chosen for this candidate, when one was."),
    tier: AccountTier.nullable(),
    quota: z
      .enum(["known_room", "unknown"])
      .nullable()
      .describe("Quota evidence of the chosen account; null for a blocked candidate."),
    resets_at: z
      .string()
      .nullable()
      .describe("Reset of the chosen account's limiting window, or of the earliest block."),
    blocked_by: ComplexityRouteBlock.nullable().describe("Null for a candidate that could serve."),
    detail: z.string().nullable().describe("The refusal's own text for a blocked candidate."),
    accounts: z.array(ComplexityAccountEvidence).default([]),
  })
  .describe("One route candidate of a complexity decision, in table order.");
export type ComplexityCandidateEvidence = z.infer<typeof ComplexityCandidateEvidence>;

export const ComplexityRouteDecision = z
  .object({
    level: ComplexityLevel,
    selected: Id.nullable().describe("Harness of the candidate that serves first; null = refused."),
    candidates: z.array(ComplexityCandidateEvidence),
  })
  .describe(
    "Audit record of a complexity routing decision: every table candidate with the account chosen for it or the typed reason it was blocked. Computed from config and quota evidence only.",
  );
export type ComplexityRouteDecision = z.infer<typeof ComplexityRouteDecision>;
