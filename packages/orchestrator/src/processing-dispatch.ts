import {
  attemptCostEvidence,
  routeCostEvidence,
  RoutingPreflightError,
  type BudgetLedger,
} from "@claudexor/budget";
import type { PreparedHarnessProcessing, ProcessingAdmission } from "@claudexor/core";
import type {
  BillingKnowledge,
  BudgetLease,
  CostEvidence,
  HarnessRunSpec,
} from "@claudexor/schema";
import type { ReviewerSpec } from "@claudexor/review";
import type { AttemptUsageCost } from "./attemptUsageCost.js";
import type { BudgetDenial } from "./budgetFailure.js";
import { processingCostEvidence } from "./processing-routing.js";

/** Compose initial lease evidence once from the admitted account and processing. */
export function processingAttemptCostEvidence(
  harnessId: string,
  attemptId: string,
  estimatedUsd: number | undefined,
  billing: BillingKnowledge,
  processing: PreparedHarnessProcessing | undefined,
): CostEvidence {
  return attemptCostEvidence(
    harnessId,
    attemptId,
    estimatedUsd,
    billing,
    processingCostEvidence(processing, billing, [`harness:${harnessId}`]),
  );
}

/** A budget refusal before native dispatch, never an adapter or auth failure. */
export class ProcessingBudgetAdmissionError extends Error {
  readonly retryable = false;
  readonly category = "budget";
  readonly code: BudgetDenial["code"];
  constructor(readonly denial: BudgetDenial) {
    super(denial.reason);
    this.code = denial.code;
    this.name = "ProcessingBudgetAdmissionError";
  }
}

function preparedCost(spec: HarnessRunSpec, harnessId: string): CostEvidence | undefined {
  const resolver = spec.extra["routeBillingKnowledge"];
  const resolved =
    typeof resolver === "function"
      ? (resolver as (actual: HarnessRunSpec) => unknown)(spec)
      : resolver;
  const ordinary =
    spec.credential_profile?.credential_kind === "api_key"
      ? "metered"
      : resolved === "metered" || resolved === "subscription_entitlement" || resolved === "unknown"
        ? resolved
        : spec.credential_profile
          ? "unknown"
          : spec.auth_preference === "api_key"
            ? "metered"
            : spec.auth_preference === "subscription"
              ? "subscription_entitlement"
              : "unknown";
  const provenance = [
    `harness:${harnessId}`,
    `profile:${spec.credential_profile?.profile_id ?? "default"}`,
  ];
  const processing =
    spec.processing && spec.processing_cost_basis
      ? processingCostEvidence(
          {
            model: spec.model_hint,
            receipt: spec.processing,
            costBasis: spec.processing_cost_basis,
          },
          ordinary,
          provenance,
        )
      : undefined;
  // Ordinary dispatches also re-admit the exact row after a rotation, and a withheld $0 send its
  // own concrete profileless verdict (admitCurrentProfileDispatch), so no earlier lease stands for
  // it. No processing controls are required to consume account billing evidence.
  return (
    processing ??
    (resolver !== undefined && (spec.credential_profile || typeof resolver !== "function")
      ? routeCostEvidence({
          billing: ordinary,
          knowledge: ordinary === "subscription_entitlement" ? "exact" : "unknown",
          source: spec.credential_profile
            ? "credential-profile-verification"
            : "native-pin-verification",
          provenance,
        })
      : undefined)
  );
}

function reprice(
  ledger: BudgetLedger,
  leaseId: string,
  cost: CostEvidence,
  harnessId: string,
  attemptId: string | null,
  onDenied?: (denial: BudgetDenial) => void,
): void {
  const result = ledger.repriceReservedLease(leaseId, cost);
  if (result.granted) return;
  const denial: BudgetDenial = {
    code: result.denied!,
    reason: result.reason!,
    harnessId,
    attemptId,
  };
  onDenied?.(denial);
  throw new ProcessingBudgetAdmissionError(denial);
}

/** Bind once when the logical lease and spec meet. Copies/retries preserve the
 * callback, which receives each actual prepared profile/model before spawn. */
export function processingAdmissionForLease(
  ledger: BudgetLedger,
  lease: BudgetLease,
  harnessId: string,
  attemptId: string | null,
  onDenied?: (denial: BudgetDenial) => void,
): ProcessingAdmission {
  // A positive reservation floor is independent of account entitlement. Never
  // carry an old included/zero verdict into a newly unknown or metered route.
  const estimate = lease.cost.estimatedUsd;
  return (actual) => {
    const prepared = preparedCost(actual, harnessId);
    if (!prepared) return;
    const cost: CostEvidence =
      prepared.knowledge === "unknown" &&
      prepared.estimatedUsd === null &&
      estimate != null &&
      estimate > 0
        ? { ...prepared, estimatedUsd: estimate, knowledge: "estimated" }
        : prepared;
    if (
      actual.extra["paidFallback"] === "never" &&
      cost.billing !== "subscription_entitlement" &&
      cost.billing !== "proven_zero"
    ) {
      // Rotation must preserve the original paid-fallback policy as well as
      // the monetary cap. Reuse the routing refusal taxonomy, not auth failure.
      throw Object.assign(
        new RoutingPreflightError(
          `paid_fallback: never refused ${harnessId} profile ${actual.credential_profile?.profile_id ?? "default"} with ${cost.billing} billing before dispatch`,
        ),
        { category: "config_error" },
      );
    }
    reprice(ledger, lease.lease_id, cost, harnessId, attemptId, onDenied);
  };
}

export function bindProcessingAdmission(
  spec: HarnessRunSpec,
  ledger: BudgetLedger,
  lease: BudgetLease,
  harnessId: string,
  attemptId: string | null,
  onDenied?: (denial: BudgetDenial) => void,
  admission?: ProcessingAdmission,
): ProcessingAdmission {
  const bound =
    admission ?? processingAdmissionForLease(ledger, lease, harnessId, attemptId, onDenied);
  spec.extra["processingAdmission"] = bound;
  spec.extra["markPhysicalDispatchStarted"] = () =>
    ledger.markPhysicalDispatchStarted(lease.lease_id);
  return bound;
}

/** One panel owns one lease. A later slot must not erase another slot's paid
 * prospective class; observed panel hold/debt stays in the same ledger. */
export function reviewerProcessingAdmission(
  ledger: BudgetLedger,
  leaseId: string,
  reviewers: ReviewerSpec[],
  attemptId: string | null,
  onDenied?: (denial: BudgetDenial) => void,
): (index: number, spec: HarnessRunSpec) => void {
  const costs = reviewers.map((reviewer) =>
    processingCostEvidence(reviewer.processing, "unknown", [`harness:${reviewer.adapter.id}`]),
  );
  let paidOrUnknownSeen = false;
  return (index, spec) => {
    const current = preparedCost(spec, reviewers[index]!.adapter.id);
    if (!current) return;
    costs[index] = current;
    const currentPaid =
      current.billing !== "proven_zero" && current.billing !== "subscription_entitlement";
    paidOrUnknownSeen ||= currentPaid;
    // A later included route must not erase the paid/unknown class already
    // admitted for this panel lease. The marker remains until settle/cancel.
    if (!currentPaid && paidOrUnknownSeen) return;
    // No receipt on an unvisited ordinary row is not unknown-price evidence.
    // Keep every declared Processing cost and every actual dispatch observation.
    const knownCosts = costs.filter((cost): cost is CostEvidence => cost !== undefined);
    const included = knownCosts.every(
      (cost) => cost.billing === "subscription_entitlement" || cost.billing === "proven_zero",
    );
    const cost: CostEvidence = {
      billing: included
        ? "subscription_entitlement"
        : knownCosts.some((c) => c.billing === "metered")
          ? "metered"
          : "unknown",
      knowledge: included ? "exact" : "unknown",
      estimatedUsd: null,
      source: "review-processing-dispatch",
      provenance: knownCosts.flatMap((c) => c.provenance),
    };
    reprice(ledger, leaseId, cost, "review-panel", attemptId, onDenied);
  };
}

/** Streamed amounts share the same lease as admission. Included subscription
 * valuation never becomes a paid hold; unresolved potentially paid amounts do. */
export function updateProcessingStreamHold(
  spec: HarnessRunSpec,
  usage: AttemptUsageCost,
  ledger: BudgetLedger,
  leaseId: string,
  harnessId: string,
  attemptId: string,
): BudgetDenial | null {
  if (!spec.processing) return null;
  const amount = usage.cashUsd + (usage.unknownPaidUsd ?? usage.unknownUsd);
  if (!(amount > 0)) return null;
  ledger.updateHold(leaseId, amount);
  return ledger.tier() === "hard"
    ? {
        code: "hard_cap",
        reason: "The paid budget cap was reached during processing",
        harnessId,
        attemptId,
      }
    : null;
}
