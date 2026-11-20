import {
  type DiagnosticGeneration,
  prepareHarnessProcessing,
  type PreparedHarnessProcessing,
} from "@claudexor/core";
import { billingKnowledgeForAuthRoute, processingBillingKnowledge } from "@claudexor/budget";
import type { BillingKnowledge, CostEvidence, GlobalConfig, PaidBudget } from "@claudexor/schema";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import type { ReviewerSpec } from "@claudexor/review";
import { withheldCostBasis } from "./auth-route-classification.js";

export async function prepareRoutedProcessing(
  routes: RoutedAdapter[],
  input: RunInput,
  cwd: string,
  config: GlobalConfig,
  paidBudget: PaidBudget,
  envFor: ((id: string) => Record<string, string> | undefined) | undefined,
  /** The mode the readiness admission probed under; never re-derived from the budget alone. */
  diagnosticGeneration: DiagnosticGeneration,
): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      if (!input.processingPreference && !route.adapter.prepareProcessing) return;
      route.processingAllowPaid =
        config.routing.paid_fallback !== "never" &&
        !(paidBudget.kind === "finite" && paidBudget.maxUsd === 0) &&
        diagnosticGeneration !== "forbidden";
      route.processing = await prepareHarnessProcessing(route.adapter, {
        preference: input.processingPreference,
        model: route.quotaAdmission.model,
        effort: input.efforts?.[route.adapter.id] ?? input.effort ?? route.settings?.effort ?? null,
        cwd,
        env: envFor?.(route.adapter.id),
        credentialProfile: route.quotaAdmission.profile,
        // A lane pinned to its verified native session prepares for that route.
        authPreference: route.quotaAdmission.pinnedNative ? "subscription" : input.authPreference,
        allowPaid: route.processingAllowPaid,
        diagnosticGeneration,
        // Exact Retry keeps its source's inherited intent, like a later try does.
        ...(!input.processingPreference && input.processingIntent?.[route.adapter.id]
          ? { chosen: input.processingIntent[route.adapter.id] }
          : {}),
      });
      // A withheld $0 Ask reads an "included" class only on the lane's own proof: a named row's
      // vendor verification (the router's own rule) or the verified native pin. The initial lease
      // and the ranking read this; every send repeats it on its own spec (modelGovernance.ts).
      const admission = route.quotaAdmission;
      const entitled = admission.profile
        ? billingKnowledgeForAuthRoute({
            route: admission.route,
            verification: admission.profileVerification ?? "not_run",
          }) === "subscription_entitlement"
        : admission.pinnedNative === true;
      const basis = withheldCostBasis(diagnosticGeneration, entitled, route.processing.costBasis);
      if (basis !== route.processing.costBasis)
        route.processing = { ...route.processing, costBasis: basis };
      // The lane's intent is the earliest typed selection: the Exact Retry
      // original when given, else this routing-time receipt.
      if (!input.processingPreference)
        route.processingIntent =
          input.processingIntent?.[route.adapter.id] ?? route.processing.receipt;
    }),
  );
}

export function processingCostEvidence(
  prepared: PreparedHarnessProcessing | undefined,
  ordinary: BillingKnowledge,
  provenance: string[],
): CostEvidence | undefined {
  if (
    !prepared ||
    prepared.receipt.reason === "processing_control_unavailable" ||
    (prepared.receipt.requested === null &&
      prepared.receipt.submitted === null &&
      prepared.receipt.reason !== "native_explicit" &&
      !prepared.receipt.reason?.startsWith("paid_processing_"))
  )
    return undefined;
  const costBasis =
    prepared.costBasis.kind === "unknown" &&
    prepared.receipt.submitted === "standard" &&
    ordinary === "subscription_entitlement"
      ? { ...prepared.costBasis, kind: "included" as const }
      : prepared.costBasis;
  const billing = processingBillingKnowledge(costBasis, ordinary);
  return {
    billing,
    knowledge:
      billing === "subscription_entitlement" || billing === "proven_zero" ? "exact" : "unknown",
    estimatedUsd: null,
    source: prepared.costBasis.source,
    provenance,
    processing: costBasis,
  };
}

export async function prepareReviewerProcessing(
  reviewers: ReviewerSpec[],
  input: RunInput,
  config: GlobalConfig,
  budget: PaidBudget,
): Promise<ReviewerSpec[]> {
  return Promise.all(
    reviewers.map(async (reviewer) => {
      const preference = reviewer.processingPreference ?? input.processingPreference;
      if (!preference && !reviewer.adapter.prepareProcessing) return reviewer;
      const allowPaid =
        config.routing.paid_fallback !== "never" &&
        !(budget.kind === "finite" && budget.maxUsd === 0);
      const processing = await prepareHarnessProcessing(reviewer.adapter, {
        preference,
        model: reviewer.requestedModel ?? null,
        effort: reviewer.requestedEffort ?? null,
        cwd: input.repoRoot,
        credentialProfile: reviewer.credentialProfile,
        authPreference: reviewer.authPreference ?? undefined,
        allowPaid,
      });
      return {
        ...reviewer,
        processingPreference: preference,
        processing,
        processingAllowPaid: allowPaid,
      };
    }),
  );
}

export function reviewerProcessingCost(reviewers: ReviewerSpec[]): CostEvidence | undefined {
  if (!reviewers.some((r) => r.processing)) return undefined;
  const costs = reviewers.map((r) =>
    processingCostEvidence(r.processing, "unknown", [`harness:${r.adapter.id}`]),
  );
  const included = costs.every(
    (c) => c?.billing === "subscription_entitlement" || c?.billing === "proven_zero",
  );
  return {
    billing: included
      ? "subscription_entitlement"
      : costs.some((c) => c?.billing === "metered")
        ? "metered"
        : "unknown",
    knowledge: included ? "exact" : "unknown",
    estimatedUsd: null,
    source: "review-processing-preflight",
    provenance: costs.flatMap((c) => c?.provenance ?? ["processing:unknown"]),
  };
}
