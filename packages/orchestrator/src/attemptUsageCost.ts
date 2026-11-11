import type {
  CostKnowledge,
  HarnessEvent,
  UsageCostBasis,
  UsageCostSummary,
} from "@claudexor/schema";
import {
  attemptUsageCostSettlement,
  reportedCashKnowledge,
  reportedUsageCostUsd,
  unknownCostSettlement,
  UsageCostTracker,
  type BudgetLedger,
  type BudgetSettlement,
  type ObservedUsageAmounts,
} from "@claudexor/budget";
import type { AppliedAttemptFacts } from "./delegatedHome.js";

export interface AttemptUsageCost {
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
  cashEstimated: boolean;
  valuationEstimated: boolean;
  readonly cashKnowledge?: CostKnowledge;
  readonly valuationKnowledge?: CostKnowledge;
  readonly unknownPaidUsd?: number;
  /** Included work whose route reported no actual debit (reported cash unknown). */
  readonly allowanceDebitUnobserved?: boolean;
  /** Meanings a usage event reported an amount for, zero included. */
  readonly observedAmounts?: ObservedUsageAmounts;
  /** Meaning of the latest reported amount. */
  readonly lastAmountKind?: UsageCostBasis["kind"] | null;
}

const usageTrackers = new WeakMap<AttemptUsageCost, UsageCostTracker>();

export interface AttemptFailureCost {
  totalUsd: number;
  estimated: boolean;
  settlement: BudgetSettlement;
}

/**
 * Settle a granted attempt lease exactly where its owning outer finally runs.
 * Before telemetry exists, the honest settlement is unknown (no fabricated
 * zero); after preparation, the normal route-aware usage settlement applies.
 */
export function settleGrantedAttemptLease(args: {
  ledger: Pick<BudgetLedger, "settle">;
  leaseId: string;
  attemptId: string;
  harnessId: string;
  costUsd: number;
  costEstimated: boolean;
  authMode?: "local_session" | "api_key" | null;
  usageCost?: AttemptUsageCost;
  preStreamFailureSource: string;
}): void {
  args.ledger.settle(
    args.leaseId,
    args.usageCost
      ? attemptUsageCostSettlement(
          args.costUsd,
          args.costEstimated,
          args.attemptId,
          args.harnessId,
          args.authMode ?? null,
          args.usageCost,
        )
      : unknownCostSettlement(args.preStreamFailureSource),
  );
}

export class AttemptPostStreamError extends Error {
  constructor(
    cause: unknown,
    readonly attemptCost: AttemptFailureCost,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AttemptPostStreamError";
  }
}

/** Preserve already-observed route-specific spend across fallible persistence. */
export function withAttemptFailureCost<T>(work: () => T, attemptCost: AttemptFailureCost): T {
  try {
    return work();
  } catch (error) {
    throw new AttemptPostStreamError(error, attemptCost);
  }
}

/** Settle every lease owner from the same post-stream error truth. */
export function attemptFailureCost(
  error: unknown,
  fallbackSource: string,
  fallbackCashUsd?: number,
): AttemptFailureCost {
  if (error instanceof AttemptPostStreamError) return error.attemptCost;
  const carriedCashUsd =
    typeof (error as { costUsd?: unknown })?.costUsd === "number" &&
    Number.isFinite((error as { costUsd: number }).costUsd) &&
    (error as { costUsd: number }).costUsd >= 0
      ? (error as { costUsd: number }).costUsd
      : fallbackCashUsd;
  return {
    totalUsd: carriedCashUsd ?? 0,
    // An ordinary zero-cost setup failure keeps the legacy exact-zero card.
    // A positive scalar with UNKNOWN settlement knowledge must never look exact.
    estimated: (carriedCashUsd ?? 0) > 0,
    settlement: unknownCostSettlement(fallbackSource, carriedCashUsd),
  };
}

/** One durable failure shape for race and convergence artifact fallbacks. */
export function attemptFailureRecord(
  attemptId: string,
  harnessId: string,
  cost: AttemptFailureCost,
  phase: "workspace" | "harness",
  message: string,
  /** What the attempt ACTUALLY ran under. REQUIRED (no default): the success
   * record carries these, and a failure record that quietly omitted them would
   * leave a delegated caller unable to tell a confined attempt that crashed
   * from an unconfined one that did. */
  applied: AppliedAttemptFacts,
): Record<string, unknown> {
  return {
    attempt_id: attemptId,
    harness_id: harnessId,
    cost_usd: cost.totalUsd,
    cost_estimated: cost.estimated,
    errored: true,
    phase,
    errors: [message],
    ...applied,
  };
}

export function newAttemptUsageCost(): AttemptUsageCost {
  const cost: AttemptUsageCost = {
    cashUsd: 0,
    valuationUsd: 0,
    unknownUsd: 0,
    cashEstimated: false,
    valuationEstimated: false,
  };
  const tracker = new UsageCostTracker(cost);
  usageTrackers.set(cost, tracker);
  Object.defineProperties(cost, {
    cashKnowledge: { enumerable: false, get: () => tracker.snapshot().cashKnowledge },
    valuationKnowledge: { enumerable: false, get: () => tracker.snapshot().valuationKnowledge },
    unknownPaidUsd: { enumerable: false, get: () => tracker.unknownPaidUsd },
    allowanceDebitUnobserved: {
      enumerable: false,
      get: () => tracker.snapshot().allowanceDebitUnobserved,
    },
    observedAmounts: { enumerable: false, get: () => tracker.snapshot().observedAmounts },
    lastAmountKind: { enumerable: false, get: () => tracker.lastAmountKind },
  });
  return cost;
}

/** Attempt-record projection. Reported cash stays unknown when an included
 * route reported no actual debit, while settlement keeps the controllable fact. */
export function attemptUsageCostSummary(cost: AttemptUsageCost): UsageCostSummary {
  return {
    cashUsd: cost.cashUsd,
    valuationUsd: cost.valuationUsd,
    unknownUsd: cost.unknownUsd,
    cashKnowledge: reportedCashKnowledge(
      cost.cashKnowledge ?? "unknown",
      cost.allowanceDebitUnobserved,
    ),
    valuationKnowledge: cost.valuationKnowledge ?? "unknown",
  };
}

/** One clean attempt's routing cost sample. Null means unpriced and clears the
 * average. The only zero sample is a reported cash receipt with a known total:
 * included work without a receipt, a zero valuation and an earlier unpriced
 * interval are not evidence that the route is free. */
export function attemptRoutingCostSample(costUsd: number, usage: AttemptUsageCost): number | null {
  if (costUsd > 0) return costUsd;
  const receipt = usage.observedAmounts?.cash === true && usage.cashUsd === 0;
  const total = reportedCashKnowledge(
    usage.cashKnowledge ?? "unknown",
    usage.allowanceDebitUnobserved,
  );
  return receipt && total !== "unknown" ? 0 : null;
}

/** Observe one event and return the route to carry into the next event. */
export function observeAttemptUsageEvent(
  cost: AttemptUsageCost,
  event: HarnessEvent,
  previousMode: "local_session" | "api_key" | null,
): "local_session" | "api_key" | null {
  const tracker = trackerFor(cost);
  let mode = event.type === "started" ? null : previousMode;
  if (event.type === "started") tracker.startAttempt();
  if (event.credential_route === "vendor_native") mode = "local_session";
  else if (event.credential_route === "managed_api_key") mode = "api_key";
  if (event.type === "message" && event.payload?.["auth_switched"] === true) {
    if (event.payload["to_auth_mode"] === "subscription") mode = "local_session";
    else if (event.payload["to_auth_mode"] === "api_key") mode = "api_key";
  }
  tracker.observeEvent(mode, event);
  const usd = reportedUsageCostUsd(event);
  if (usd !== undefined) {
    const receiptMode =
      event.credential_route === "vendor_native"
        ? "local_session"
        : event.credential_route === "managed_api_key"
          ? "api_key"
          : mode;
    tracker.observeUsage(receiptMode, usd, event.usage?.estimated === true, event);
  }
  if (event.type === "completed") tracker.finishAttempt();
  return mode;
}

function trackerFor(cost: AttemptUsageCost): UsageCostTracker {
  let tracker = usageTrackers.get(cost);
  if (!tracker) {
    tracker = new UsageCostTracker(cost);
    usageTrackers.set(cost, tracker);
  }
  return tracker;
}
