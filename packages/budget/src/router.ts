import type {
  BillingKnowledge,
  CredentialRoute,
  EffortHint,
  Intent,
  PaidFallback,
  QualityTierSet,
  RoutingGoal,
} from "@claudexor/schema";
import type { BudgetLedger } from "./ledger.js";

export interface RouterCandidate {
  harnessId: string;
  available: boolean;
  model?: string;
  effort?: EffortHint;
  billingKnowledge?: BillingKnowledge;
  incrementalCostUsd?: number | null;
  credentialRoute?: CredentialRoute;
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

function isIncrementalPaid(candidate: RouterCandidate): boolean {
  return !["proven_zero", "subscription_entitlement"].includes(
    candidate.billingKnowledge ?? "unknown",
  );
}

function eligible(candidates: RouterCandidate[], ctx: RouteContext): RouterCandidate[] {
  const ready = candidates.filter(
    (candidate) =>
      candidate.available &&
      !ctx.ledger.cooldownActive(candidate.harnessId, candidate.credentialRoute),
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
    const aSlack = ctx.ledger.bindingPaceSlack(a.harnessId, a.credentialRoute);
    const bSlack = ctx.ledger.bindingPaceSlack(b.harnessId, b.credentialRoute);
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
