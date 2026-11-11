import { prepareHarnessProcessing, type PreparedHarnessProcessing } from "@claudexor/core";
import { processingBillingKnowledge } from "@claudexor/budget";
import type { BillingKnowledge, CostEvidence, GlobalConfig, PaidBudget } from "@claudexor/schema";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import type { ReviewerSpec } from "@claudexor/review";

export async function prepareRoutedProcessing(
  routes: RoutedAdapter[],
  input: RunInput,
  cwd: string,
  config: GlobalConfig,
  paidBudget: PaidBudget,
  envFor?: (id: string) => Record<string, string> | undefined,
): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      if (!input.processingPreference && !route.adapter.prepareProcessing) return;
      route.processingAllowPaid =
        config.routing.paid_fallback !== "never" &&
        !(paidBudget.kind === "finite" && paidBudget.maxUsd === 0);
      route.processing = await prepareHarnessProcessing(route.adapter, {
        preference: input.processingPreference,
        model: route.quotaAdmission.model,
        effort: input.efforts?.[route.adapter.id] ?? input.effort ?? route.settings?.effort ?? null,
        cwd,
        env: envFor?.(route.adapter.id),
        credentialProfile: route.quotaAdmission.profile,
        authPreference: input.authPreference,
        allowPaid: route.processingAllowPaid,
        // Exact Retry keeps its source's inherited intent, like a later try does.
        ...(!input.processingPreference && input.processingIntent?.[route.adapter.id]
          ? { chosen: input.processingIntent[route.adapter.id] }
          : {}),
      });
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
