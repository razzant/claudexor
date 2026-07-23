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

/** User-declared tier index the comparators order by (missing => MAX). Shared
 * by the sort and the traced comparator so a "tier" claim is never re-derived. */
function tierValueOf(candidate: RouterCandidate, ctx: RouteContext): number {
  return tierIndex(candidate, ctx) ?? Number.MAX_SAFE_INTEGER;
}

/** Binding pace slack the `auto` comparator orders by; null = none observed. */
function autoSlack(candidate: RouterCandidate, ctx: RouteContext): number | null {
  return ctx.ledger.bindingPaceSlack(
    candidate.harnessId,
    candidate.credentialRoute,
    candidate.credentialSubjectId,
  );
}

/** null slack collapses to this so a slack-carrying candidate always outranks a
 * slack-less one, exactly as the comparator subtraction does. */
const AUTO_SLACK_ABSENT = Number.NEGATIVE_INFINITY;

type AutoRankAxis = "expiring_quota_slack" | "quality_tier";

/**
 * The SINGLE traced comparator for `auto` (round-4 #3 — this rationale has been
 * wrong three times). It returns both the pair ORDER and the AXIS that produced
 * it, and is the only place the auto ordering is defined. `rankHarnesses` sorts
 * by `.order`; `rankingReason` reads `.axis`. Deriving the recorded reason from
 * the very comparator that ordered the pool makes it structurally impossible for
 * the rationale to claim a factor the sort did not use (the axis-registry
 * pattern used in arbitration, specialized to auto's conditional slack axis).
 *
 * The slack axis is in force whenever EITHER candidate has a non-null slack; the
 * subtraction of the (null => -Infinity) effective values is what decides — so
 * two EQUAL non-null slacks yield order 0 and a null axis (declared order, and
 * the sort does NOT fall through to tiers). Only when BOTH slacks are absent
 * does the comparator compare tier indices.
 */
function compareAutoTraced(
  a: RouterCandidate,
  b: RouterCandidate,
  ctx: RouteContext,
): { order: number; axis: AutoRankAxis | null } {
  const aSlack = autoSlack(a, ctx);
  const bSlack = autoSlack(b, ctx);
  if (aSlack !== null || bSlack !== null) {
    const order = (bSlack ?? AUTO_SLACK_ABSENT) - (aSlack ?? AUTO_SLACK_ABSENT);
    return { order, axis: order !== 0 ? "expiring_quota_slack" : null };
  }
  const order = tierValueOf(a, ctx) - tierValueOf(b, ctx);
  return { order, axis: order !== 0 ? "quality_tier" : null };
}

/** Order candidates transparently; lower tuple values win. Unknown quota remains eligible. */
export function rankHarnesses(candidates: RouterCandidate[], ctx: RouteContext): RouterCandidate[] {
  const routes = eligible(candidates, ctx);
  if (ctx.goal === "quality" && routes.every((candidate) => tierIndex(candidate, ctx) === null)) {
    throw new RoutingPreflightError(
      `quality routing requires a comparable user-declared tier for intent '${ctx.intent}'`,
    );
  }
  if (ctx.goal === "auto") {
    return routes.toSorted((a, b) => compareAutoTraced(a, b, ctx).order);
  }
  return routes.toSorted((a, b) => {
    const aTier = tierValueOf(a, ctx);
    const bTier = tierValueOf(b, ctx);
    if (ctx.goal === "quality") return aTier - bTier;
    // economy
    const aPaid = isIncrementalPaid(a) ? 1 : 0;
    const bPaid = isIncrementalPaid(b) ? 1 : 0;
    const paidOrder = aPaid - bPaid;
    if (paidOrder !== 0) return paidOrder;
    const aCost = a.incrementalCostUsd ?? Number.POSITIVE_INFINITY;
    const bCost = b.incrementalCostUsd ?? Number.POSITIVE_INFINITY;
    return aCost - bCost || aTier - bTier;
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
  const reason = rankingReason(ctx, rankedCandidates, candidates);
  return { goal: ctx.goal, paid_fallback: ctx.paidFallback, order, dropped, reason, entries };
}

/** Do the ranked candidates carry two distinct user-declared tier indices? Only
 * then did the tier comparator (the auto/economy tie-break) actually decide the
 * order; a single candidate or a uniform tier index leaves the declared order. */
function tiersDistinguish(ranked: RouterCandidate[], ctx: RouteContext): boolean {
  const indices = ranked.map((c) => tierIndex(c, ctx) ?? Number.MAX_SAFE_INTEGER);
  return indices.some((value) => value !== indices[0]);
}

/** Do the ranked candidates carry two distinct incremental costs (with the SAME
 * missing-cost fallback the economy sort uses)? Only then did the cost
 * comparator — not the paid/free split above it or the tier tie-break below —
 * actually decide the order. */
function costsDistinguish(ranked: RouterCandidate[]): boolean {
  const costs = ranked.map((c) => c.incrementalCostUsd ?? Number.POSITIVE_INFINITY);
  return costs.some((value) => value !== costs[0]);
}

/**
 * The DECISIVE comparator axis. For `auto` the reason is read directly off the
 * SAME traced comparator that ordered the pool (`compareAutoTraced`) — never
 * re-derived from a separately-recomputed condition (round-4 #3, the third
 * recurrence of a rationale that disagreed with `rankHarnesses`): the reason is
 * whichever axis actually separated an adjacent ranked pair, and `declared_order`
 * when the comparator broke no pair (e.g. equal non-null slacks — which do NOT
 * fall through to tiers).
 */
function rankingReason(
  ctx: RouteContext,
  ranked: RouterCandidate[],
  candidates: RouterCandidate[],
): RouteRankingReason {
  if (ctx.goal === "quality") return "quality_tier";
  if (ctx.goal === "auto") {
    // Walk the ranked order through the very comparator that produced it. Since
    // the pool is sorted, any two distinct axis values leave a differing
    // adjacent pair, so this sees every axis the sort actually used.
    const axes = new Set<AutoRankAxis>();
    for (let i = 0; i + 1 < ranked.length; i++) {
      const traced = compareAutoTraced(ranked[i]!, ranked[i + 1]!, ctx);
      if (traced.axis) axes.add(traced.axis);
    }
    if (axes.has("expiring_quota_slack")) return "expiring_quota_slack";
    if (axes.has("quality_tier")) return "quality_tier";
    return "declared_order";
  }
  // economy: mirror the economy sort tuple EXACTLY — (isIncrementalPaid,
  // incrementalCostUsd, tierIndex) — and report the FIRST axis that actually
  // SEPARATED the pool. Reporting entitlement whenever ANY route is entitled was
  // wrong when they are ALL entitled and cost/tier did the deciding (the same
  // correction made for `auto` in 1d6a2a50).
  const someEntitled = ranked.some((c) => !isIncrementalPaid(c));
  // Entitlement decided when the pool actually WEIGHED an entitled route against
  // a paid one — whether the paid route was ranked BELOW (sort axis 1) or DROPPED
  // by paid_fallback (both are the entitled-preferred-over-paid outcome). When
  // every route CONSIDERED is entitled, entitlement did not decide — cost/tier
  // did (the round-3 correction; matches the pool-wide `auto` mirror in
  // 1d6a2a50). The full candidate set (not just the eligible pool) is consulted
  // so a paid route dropped by paid_fallback:never still attributes the outcome.
  const anyPaidConsidered = candidates.some((c) => isIncrementalPaid(c));
  if (someEntitled && anyPaidConsidered) return "subscription_entitlement_first";
  if (costsDistinguish(ranked)) return "lowest_incremental_cash";
  if (tiersDistinguish(ranked, ctx)) return "quality_tier";
  // Nothing separated the pool: distinguish "we could not compare cash at all"
  // from a genuine declared-order tie.
  if (ranked.length > 0 && ranked.some((c) => c.incrementalCostUsd == null))
    return "all_incremental_cash_unknown";
  return "declared_order";
}
