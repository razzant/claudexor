import type { CostKnowledge } from "@claudexor/schema";
import type { BudgetSettlement } from "./ledger.js";
import type { ObservedUsageAmounts } from "./usage-evidence.js";

export function usageCostSettlement(
  cashUsd: number,
  estimated: boolean,
  source: string,
  provenance: string[],
): BudgetSettlement {
  return cashUsd > 0
    ? {
        knowledge: measuredKnowledge(estimated),
        cashKnowledge: measuredKnowledge(estimated),
        source,
        provenance,
        cashUsd,
      }
    : { knowledge: "unknown", source: `${source}-missing`, provenance };
}

/** Components a settlement reports: a positive amount, or a zero the usage
 * tracker observed. Stated knowledge alone never counts as a reported amount. */
function reportedComponents(
  amounts: { cashUsd: number; valuationUsd: number; unknownUsd: number },
  seen: ObservedUsageAmounts | undefined,
) {
  const valuationUsd = Math.max(0, amounts.valuationUsd);
  const valuation = valuationUsd > 0 || seen?.valuation === true;
  const unknown = amounts.unknownUsd > 0 || seen?.unknown === true;
  return {
    valuationUsd,
    valuation,
    unknown,
    any: amounts.cashUsd > 0 || seen?.cash === true || valuation || unknown,
  };
}

export function reviewUsageCostSettlement(
  cashUsd: number,
  valuationUsd: number,
  knowledge: {
    cash: CostKnowledge;
    valuation: CostKnowledge;
    allowanceDebitUnobserved?: boolean;
    observedAmounts?: ObservedUsageAmounts;
  },
  provenance: string[],
  unknownUsd = 0,
): BudgetSettlement {
  const reported = reportedComponents(
    { cashUsd, valuationUsd, unknownUsd },
    knowledge.observedAmounts,
  );
  const aggregateKnowledge = mergeKnowledge([
    knowledge.cash,
    ...(reported.valuation || reported.unknown ? [knowledge.valuation] : []),
  ]);
  return {
    knowledge: reported.unknown ? "unknown" : aggregateKnowledge,
    cashKnowledge: knowledge.cash,
    ...(knowledge.allowanceDebitUnobserved ? { allowanceDebitUnobserved: true } : {}),
    ...(reported.valuation || reported.unknown
      ? {
          valuationKnowledge: reported.unknown ? ("unknown" as const) : knowledge.valuation,
        }
      : {}),
    source: reported.any ? "review-usage" : "review-usage-missing",
    provenance,
    cashUsd: Math.max(0, cashUsd),
    ...(reported.valuation ? { valuationUsd: reported.valuationUsd } : {}),
  };
}

function mergeKnowledge(values: readonly CostKnowledge[]): CostKnowledge {
  if (values.includes("unknown")) return "unknown";
  return values.includes("estimated") ? "estimated" : "exact";
}

export function attemptUsageCostSettlement(
  totalUsd: number,
  estimated: boolean,
  attemptId: string,
  harnessId: string,
  authMode?: "local_session" | "api_key" | null,
  split?: {
    cashUsd: number;
    valuationUsd: number;
    unknownUsd: number;
    cashEstimated?: boolean;
    valuationEstimated?: boolean;
    cashKnowledge?: CostKnowledge;
    valuationKnowledge?: CostKnowledge;
    allowanceDebitUnobserved?: boolean;
    observedAmounts?: ObservedUsageAmounts;
  },
): BudgetSettlement {
  if (split) {
    const reported = reportedComponents(split, split.observedAmounts);
    const componentEvidence =
      split.cashKnowledge !== undefined || split.valuationKnowledge !== undefined;
    if (reported.any || componentEvidence) {
      const cashKnowledge =
        split.cashKnowledge ??
        (reported.unknown ? "unknown" : measuredKnowledge(split.cashEstimated === true));
      const valuationKnowledge = reported.unknown
        ? "unknown"
        : (split.valuationKnowledge ?? measuredKnowledge(split.valuationEstimated === true));
      return {
        knowledge: mergeKnowledge([
          cashKnowledge,
          ...(reported.valuation || reported.unknown ? [valuationKnowledge] : []),
        ]),
        cashKnowledge,
        ...(split.allowanceDebitUnobserved ? { allowanceDebitUnobserved: true } : {}),
        ...(reported.valuation || reported.unknown ? { valuationKnowledge } : {}),
        source: reported.any ? "harness-usage-by-route" : "harness-route-usage-missing",
        provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:stream-evidence"],
        cashUsd: split.cashUsd,
        ...(reported.valuation ? { valuationUsd: reported.valuationUsd } : {}),
      };
    }
  }
  if (isSubscriptionValuation(authMode)) {
    return {
      knowledge: measuredKnowledge(estimated),
      cashKnowledge: "exact",
      ...(totalUsd > 0 ? { valuationKnowledge: measuredKnowledge(estimated) } : {}),
      source: "harness-token-valuation",
      provenance: [`attempt:${attemptId}`, `harness:${harnessId}`, "route:vendor_native"],
      ...(totalUsd > 0 ? { valuationUsd: totalUsd } : {}),
    };
  }
  return usageCostSettlement(totalUsd, estimated, "harness-usage", [
    `attempt:${attemptId}`,
    `harness:${harnessId}`,
    ...(authMode ? [`route:${authMode}`] : []),
  ]);
}

function measuredKnowledge(estimated: boolean): CostKnowledge {
  return estimated ? "estimated" : "exact";
}

/** One owner for the W4.3 fact used at settlement AND mid-flight cap checks. */
export function isSubscriptionValuation(authMode?: "local_session" | "api_key" | null): boolean {
  // Vendor-reported cost on a native subscription route is VALUATION,
  // regardless of whether the vendor labels it estimated or exact. It never
  // becomes incremental cash (live-found: Claude reported estimated=false
  // and the UI incorrectly showed ~$0.37 cash for subscription work).
  return authMode === "local_session";
}

export function unknownCostSettlement(source: string, cashUsd?: number): BudgetSettlement {
  return {
    knowledge: "unknown",
    source,
    provenance: [`orchestrator:${source}`],
    ...(cashUsd === undefined ? {} : { cashUsd }),
  };
}
