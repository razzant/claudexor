import type {
  AuthVerification,
  BillingKnowledge,
  CredentialRoute,
  EffortHint,
  Intent,
  PaidFallback,
  QualityTierSet,
  RouteRankingEntry,
  RouteRankingRationale,
  RouteRankingReason,
  RoutingGoal,
} from "@claudexor/schema";
import type { BudgetLedger } from "./ledger.js";

/**
 * The typed auth-route evidence a route ran (or would run) under — the doctor's
 * `auth_sources` verification for the credential source plus the concrete
 * `credential_route` receipt. This is the ONLY sanctioned source of billing
 * knowledge (INV-060 / schema `auth.ts`: a credential transport alone never
 * proves entitlement or zero cost, but a VERIFIED native/subscription route is
 * a subscription-entitlement fact). No per-vendor price table is inferred.
 */
export interface RouteAuthEvidence {
  route: CredentialRoute | null;
  verification: AuthVerification;
}

/**
 * Billing knowledge derived STRICTLY from the typed auth route (QA-034). A
 * verified vendor-native route proves `subscription_entitlement`; a managed
 * API-key route is `metered` and is NEVER presumed free; every other route
 * (unverified native, credential-free local, unknown) stays `unknown`. This is
 * the missing production producer the schema/router already knew how to consume.
 */
export function billingKnowledgeForAuthRoute(evidence: RouteAuthEvidence): BillingKnowledge {
  if (evidence.route === "managed_api_key") return "metered";
  if (evidence.route === "vendor_native" && evidence.verification === "passed") {
    return "subscription_entitlement";
  }
  return "unknown";
}

export interface RouterCandidate {
  harnessId: string;
  available: boolean;
  model?: string;
  effort?: EffortHint;
  billingKnowledge?: BillingKnowledge;
  /** Typed auth-route evidence. When present it is AUTHORITATIVE for billing
   * knowledge (derived via billingKnowledgeForAuthRoute), so a verified native
   * route survives paid_fallback:never and ranks with a real economy tuple.
   * Falls back to the explicit billingKnowledge (else unknown) when absent. */
  authRoute?: RouteAuthEvidence;
  incrementalCostUsd?: number | null;
  credentialRoute?: CredentialRoute;
  /** Effective credential subject for quota filtering (release wave round-16
   * #2): a profile id, null for the engine default, undefined when unknown
   * (conservative any-subject matching). Profile A's cooldown must never
   * exclude profile B or the default on the same harness+route. */
  credentialSubjectId?: string | null;
}

export interface RouteContext {
  goal: RoutingGoal;
  paidFallback: PaidFallback;
  intent: Intent;
  qualityTiers: QualityTierSet;
  ledger: BudgetLedger;
}

export class RoutingPreflightError extends Error {
  readonly code = "routing_preflight_refused";
}

function tierIndex(candidate: RouterCandidate, ctx: RouteContext): number | null {
  const tiers = ctx.qualityTiers[ctx.intent] ?? [];
  const index = tiers.findIndex((tier) =>
    tier.some(
      (route) =>
        route.harness === candidate.harnessId &&
        route.model === candidate.model &&
        route.effort === candidate.effort,
    ),
  );
  return index < 0 ? null : index;
}

/** Effective billing knowledge: the typed auth route is authoritative when
 * present (QA-034), else the explicitly supplied value, else unknown. */
function effectiveBilling(candidate: RouterCandidate): BillingKnowledge {
  if (candidate.authRoute) return billingKnowledgeForAuthRoute(candidate.authRoute);
  return candidate.billingKnowledge ?? "unknown";
}

function isIncrementalPaid(candidate: RouterCandidate): boolean {
  return !["proven_zero", "subscription_entitlement"].includes(effectiveBilling(candidate));
}

function eligible(candidates: RouterCandidate[], ctx: RouteContext): RouterCandidate[] {
  const ready = candidates.filter(
    (candidate) =>
      candidate.available &&
      !ctx.ledger.cooldownActive(
        candidate.harnessId,
        candidate.credentialRoute,
        candidate.credentialSubjectId,
      ),
  );
  const free = ready.filter((candidate) => !isIncrementalPaid(candidate));
  if (ctx.paidFallback === "never") return free;
  if (ctx.paidFallback === "when_unavailable" && free.length > 0) return free;
  return ready;
}

/** Order candidates transparently; lower tuple values win. Unknown quota remains eligible. */
export function rankHarnesses(candidates: RouterCandidate[], ctx: RouteContext): RouterCandidate[] {
  const routes = eligible(candidates, ctx);
  if (ctx.goal === "quality" && routes.every((candidate) => tierIndex(candidate, ctx) === null)) {
    throw new RoutingPreflightError(
      `quality routing requires a comparable user-declared tier for intent '${ctx.intent}'`,
    );
  }
  return routes.toSorted((a, b) => {
    const aTier = tierIndex(a, ctx) ?? Number.MAX_SAFE_INTEGER;
    const bTier = tierIndex(b, ctx) ?? Number.MAX_SAFE_INTEGER;
    if (ctx.goal === "quality") return aTier - bTier;
    if (ctx.goal === "economy") {
      const aPaid = isIncrementalPaid(a) ? 1 : 0;
      const bPaid = isIncrementalPaid(b) ? 1 : 0;
      const paidOrder = aPaid - bPaid;
      if (paidOrder !== 0) return paidOrder;
      const aCost = a.incrementalCostUsd ?? Number.POSITIVE_INFINITY;
      const bCost = b.incrementalCostUsd ?? Number.POSITIVE_INFINITY;
      return aCost - bCost || aTier - bTier;
    }
    const aSlack = ctx.ledger.bindingPaceSlack(
      a.harnessId,
      a.credentialRoute,
      a.credentialSubjectId,
    );
    const bSlack = ctx.ledger.bindingPaceSlack(
      b.harnessId,
      b.credentialRoute,
      b.credentialSubjectId,
    );
    if (aSlack !== null || bSlack !== null) {
      return (bSlack ?? Number.NEGATIVE_INFINITY) - (aSlack ?? Number.NEGATIVE_INFINITY);
    }
    return aTier - bTier;
  });
}

export function selectHarness(
  candidates: RouterCandidate[],
  ctx: RouteContext,
): RouterCandidate | null {
  return rankHarnesses(candidates, ctx)[0] ?? null;
}

/**
 * Explain a ranking as a typed record (QA-034): the per-candidate billing/cost
 * tuple, the eligible/dropped split, and the DECISIVE reason. Kept axis-aligned
 * with rankHarnesses so the recorded rationale can never disagree with the
 * order actually taken. Prose-free; a surface projects it, never reconstructs it.
 * The shape is the schema-owned RouteRankingRationale (snake_case) so it can be
 * persisted verbatim as RunTelemetry.routing_rationale.
 */
export function explainRanking(
  candidates: RouterCandidate[],
  ctx: RouteContext,
): RouteRankingRationale {
  const rankedCandidates = rankHarnesses(candidates, ctx);
  const order = rankedCandidates.map((c) => c.harnessId);
  const eligibleIds = new Set(order);
  const entries: RouteRankingEntry[] = candidates.map((c) => ({
    harness_id: c.harnessId,
    billing_knowledge: effectiveBilling(c),
    incremental_cost_usd: c.incrementalCostUsd ?? null,
    eligible: eligibleIds.has(c.harnessId),
  }));
  const dropped = candidates.filter((c) => !eligibleIds.has(c.harnessId)).map((c) => c.harnessId);
  const reason = rankingReason(ctx, rankedCandidates);
  return { goal: ctx.goal, paid_fallback: ctx.paidFallback, order, dropped, reason, entries };
}

/** Do the ranked candidates carry two distinct user-declared tier indices? Only
 * then did the tier comparator (the auto/economy tie-break) actually decide the
 * order; a single candidate or a uniform tier index leaves the declared order. */
function tiersDistinguish(ranked: RouterCandidate[], ctx: RouteContext): boolean {
  const indices = ranked.map((c) => tierIndex(c, ctx) ?? Number.MAX_SAFE_INTEGER);
  return indices.some((value) => value !== indices[0]);
}

/**
 * The DECISIVE comparator axis, mirrored EXACTLY from rankHarnesses so the
 * recorded rationale can never claim a factor the sort did not use (round-2 #1):
 * `expiring_quota_slack` is reported for `auto` ONLY when a binding pace slack
 * was present to order by; with no slack the auto sort falls through to the
 * tier comparator, so the reason is `quality_tier` when tiers separated the
 * pool and `declared_order` when nothing distinguished it.
 */
function rankingReason(ctx: RouteContext, ranked: RouterCandidate[]): RouteRankingReason {
  if (ctx.goal === "quality") return "quality_tier";
  if (ctx.goal === "auto") {
    // The auto branch sorts by binding pace slack whenever any candidate has a
    // non-null slack; otherwise it compares tier indices. Report the axis that
    // was live, never quota-slack unconditionally.
    const slackDecided = ranked.some(
      (c) =>
        ctx.ledger.bindingPaceSlack(c.harnessId, c.credentialRoute, c.credentialSubjectId) !== null,
    );
    if (slackDecided) return "expiring_quota_slack";
    if (tiersDistinguish(ranked, ctx)) return "quality_tier";
    return "declared_order";
  }
  // economy
  if (
    ranked.some((c) => {
      const billing = effectiveBilling(c);
      return billing === "subscription_entitlement" || billing === "proven_zero";
    })
  )
    return "subscription_entitlement_first";
  if (ranked.some((c) => c.incrementalCostUsd != null)) return "lowest_incremental_cash";
  if (ranked.length > 0) return "all_incremental_cash_unknown";
  return "declared_order";
}
