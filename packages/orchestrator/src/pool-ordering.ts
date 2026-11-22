import {
  BudgetLedger,
  billingKnowledgeForAuthRoute,
  explainRanking,
  loadHarnessMetrics,
  rankHarnesses,
  type RouterCandidate,
} from "@claudexor/budget";
import { globalConfigDir } from "@claudexor/config";
import type {
  AuthPreference,
  AuthSourceReadiness,
  ComplexityRouteDecision,
  GlobalConfig,
  Intent,
  RouteRankingRationale,
  RoutingGoal,
} from "@claudexor/schema";
import {
  authModeForCredentialRoute,
  authModeForPreference,
  authRouteEvidenceFor,
} from "./auth-route-classification.js";
import type { ComplexityTrace } from "./complexity-routing.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import { processingCostEvidence } from "./processing-routing.js";

/**
 * Order the eligible pool by the selected routing goal (budget router): an
 * explicit user pool keeps the user's order; an explicit primary harness is
 * always pinned first. Split from the orchestrator god-file (INV-124). The
 * returned rationale describes the FINAL order, including request constraints
 * that intentionally override the underlying cost/quota ranking (QA-034).
 */
export function orderRoutedPool(args: {
  pool: RoutedAdapter[];
  input: RunInput;
  intent: Intent;
  statusById: Map<
    string,
    { manifest?: { auth_modes?: string[] } | null; authSources?: AuthSourceReadiness[] }
  >;
  ledger?: BudgetLedger;
  config: GlobalConfig;
  defaultGoal?: RoutingGoal;
  authPreferenceForHarness: (harnessId: string) => AuthPreference;
  headroomThreshold: (harnessId: string) => number;
  /** Present only for a run that states a complexity. */
  trace?: ComplexityTrace;
}): { ordered: RoutedAdapter[]; rationale: RouteRankingRationale | null } {
  const { pool, input, intent, statusById, ledger, trace } = args;
  let ordered = pool;
  let rationale: RouteRankingRationale | null = null;
  let selectionReason: RouteRankingRationale["reason"] | null = null;
  if (pool.length > 0) {
    const routeLedger = ledger ?? new BudgetLedger();
    const config = args.config;
    const goal = input.routingGoal ?? args.defaultGoal ?? config.routing.goal;
    const byId = new Map(pool.map((r) => [r.adapter.id, r]));
    // Settled cost is evidence for economy routing, never a provider quality prior.
    const metrics = loadHarnessMetrics(globalConfigDir());
    const remaining: RouterCandidate[] = pool.map((r) => {
      const status = statusById.get(r.adapter.id);
      const authModes = status?.manifest?.auth_modes ?? [];
      const metric = metrics[r.adapter.id];
      // Auth mode for routing: prefer the ROUTE EVIDENCE from the
      // last settled attempt (adapter-disclosed, persisted in metrics) over
      // the manifest capability guess — auth_modes lists what a harness CAN
      // use, not what it actually runs under.
      const guessedAuthMode = authModes.includes("local_session")
        ? ("local_session" as const)
        : authModes.includes("api_key")
          ? ("api_key" as const)
          : ("unknown" as const);
      // The FROZEN quota-admission route decides outright (round-18 #2):
      // the admitted profile's credential_kind when a profile exists, else
      // the config-aware estimate — an api_key lane must never inherit a
      // subscription classification from the default store's metric. With
      // no route fact, the RESOLVED preference (per-run > per-harness
      // config > global config) speaks, never the raw run input (#121);
      // only then the last settled metric / manifest guess.
      const authMode =
        authModeForCredentialRoute(r.quotaAdmission.route) ??
        authModeForPreference(args.authPreferenceForHarness(r.adapter.id)) ??
        metric?.last_auth_mode ??
        guessedAuthMode;
      // The exact quota subject selected before ranking: profile id or the
      // engine default. Profile A's cooldown never excludes profile B or the
      // default on the same harness and route.
      const credentialSubjectId = r.quotaAdmission.profile?.profile_id ?? null;
      // QA-034: the typed auth-route evidence (the admitted profile's own
      // verification, else doctor source verification, x the resolved route)
      // is AUTHORITATIVE for billing knowledge in the router — a VERIFIED
      // native route proves subscription_entitlement, so it survives
      // paid_fallback:never and ranks with a real economy tuple instead of
      // reading as unknown/paid. Absent (unknown route) falls back to the
      // metric-derived billingKnowledge below.
      const authRoute = authRouteEvidenceFor(
        authMode,
        status?.authSources ?? [],
        r.quotaAdmission.profileVerification,
      );
      const processingCost = processingCostEvidence(
        r.processing,
        authRoute ? billingKnowledgeForAuthRoute(authRoute) : "unknown",
        [`harness:${r.adapter.id}`, `profile:${credentialSubjectId ?? "default"}`],
      );
      return {
        harnessId: r.adapter.id,
        available: true,
        model: r.quotaAdmission.model,
        effort:
          input.efforts?.[r.adapter.id] ??
          input.effort ??
          config.harnesses[r.adapter.id]?.effort ??
          undefined,
        billingKnowledge: authMode === "api_key" ? "metered" : "unknown",
        costEvidence: processingCost,
        incrementalCostUsd: processingCost
          ? processingCost.estimatedUsd
          : authMode === "api_key"
            ? (metric?.avg_cost_usd ?? null)
            : null,
        credentialRoute:
          r.quotaAdmission.route ??
          (authMode === "api_key"
            ? "managed_api_key"
            : authMode === "local_session"
              ? "vendor_native"
              : undefined),
        ...(authRoute ? { authRoute } : {}),
        credentialSubjectId,
      };
    });
    const routeCtx = {
      goal,
      paidFallback: config.routing.paid_fallback,
      intent,
      qualityTiers: config.routing.quality_tiers,
      ledger: routeLedger,
      now: Date.now(), // ONE instant for the sort AND the rationale below
    };
    const ranked = rankHarnesses(remaining, routeCtx)
      .map((candidate) => byId.get(candidate.harnessId))
      .filter((candidate): candidate is RoutedAdapter => Boolean(candidate));
    rationale = explainRanking(remaining, routeCtx);
    ordered = ranked;
  }
  // A run that states a complexity orders its surviving lanes by account tier
  // across harnesses (complexity-routing.ts) and records the whole decision.
  let decision: ComplexityRouteDecision | null = null;
  if (trace && rationale) {
    trace.routerDropped(rationale.dropped);
    const lanes = trace.order(
      ordered.map((route) => ({
        route,
        harnessId: route.adapter.id,
        profile: route.quotaAdmission.profile,
        model: route.quotaAdmission.model,
        headroomThreshold: args.headroomThreshold(route.adapter.id),
      })),
    );
    if (lanes.some((lane, index) => lane.route !== ordered[index]))
      selectionReason = "complexity_account_tier";
    ordered = lanes.map((lane) => lane.route);
    decision = trace.decision(lanes);
  }
  if (input.delegate === true && input.primaryHarnessExplicit !== true) {
    const delegateFirst = [
      ...ordered.filter((lane) => lane.delegationRequirement.effective),
      ...ordered.filter((lane) => !lane.delegationRequirement.effective),
    ];
    if (delegateFirst.some((lane, index) => lane !== ordered[index])) {
      ordered = delegateFirst;
      selectionReason = "delegate_effective_first";
    }
  }
  if (input.primaryHarness) {
    const primary = ordered.find((r) => r.adapter.id === input.primaryHarness);
    if (primary && primary !== ordered[0]) {
      ordered = [primary, ...ordered.filter((r) => r !== primary)];
      selectionReason = "explicit_primary";
    }
  }
  // QA-034: persist the FINAL selected order, including request constraints
  // that intentionally override the underlying cost/quota ranking. This is
  // what keeps route evidence aligned with the lane actually executed.
  return {
    ordered,
    rationale: rationale && {
      ...rationale,
      order: ordered.map((lane) => lane.adapter.id),
      reason: selectionReason ?? rationale.reason,
      ...(decision
        ? { complexity: { ...decision, selected: ordered[0]?.adapter.id ?? null } }
        : {}),
    },
  };
}
