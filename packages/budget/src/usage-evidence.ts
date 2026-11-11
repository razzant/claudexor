import type {
  CostKnowledge,
  HarnessEvent,
  ProcessingCostBasis,
  ProcessingReceipt,
  UsageCostBasis,
} from "@claudexor/schema";

type AuthMode = "local_session" | "api_key" | null;
type ProcessingEvidence = Pick<HarnessEvent, "processing" | "processing_cost_basis">;

export interface UsageCostTotals {
  cashUsd: number;
  valuationUsd: number;
  unknownUsd: number;
  cashEstimated: boolean;
  valuationEstimated: boolean;
}

/** Which meanings usage events actually reported an amount for, zero included.
 * This is not certainty: included work knows its controllable cash exactly
 * without any receipt, and a later receipt leaves an earlier unpriced interval
 * unknown. */
export interface ObservedUsageAmounts {
  cash: boolean;
  valuation: boolean;
  unknown: boolean;
}

export function anyUsageAmountObserved(observed: ObservedUsageAmounts | undefined): boolean {
  return observed?.cash === true || observed?.valuation === true || observed?.unknown === true;
}

/** The amount a usage event reported: finite and nonnegative, zero included.
 * Undefined means it reported none, which is never the same as zero. */
export function reportedUsageCostUsd(event: {
  usage?: { cost_usd?: number | null } | null;
}): number | undefined {
  const usd = event.usage?.cost_usd;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}

/** Observed amount meaning is independent from prospective billing. A native
 * premium tariff alone never turns a token estimate into a debit receipt. */
export function usageAmountKind(
  route: AuthMode,
  amount: UsageCostBasis | undefined,
  processing?: ProcessingReceipt,
  billing?: ProcessingCostBasis,
): UsageCostBasis["kind"] {
  if (amount) return amount.kind;
  if (route === "api_key") return "cash";
  return ordinaryIncluded(route, processing, billing) ? "valuation" : "unknown";
}

function ordinaryIncluded(
  route: AuthMode,
  processing?: ProcessingReceipt,
  billing?: ProcessingCostBasis,
): boolean {
  if (route !== "local_session") return false;
  if (billing?.kind === "included") return true;
  if (
    processing?.reason === "processing_control_unavailable" &&
    (billing === undefined || billing.kind === "unknown")
  )
    return true;
  if (
    ((processing?.submitted === "standard" &&
      processing.observed !== "fast" &&
      processing.observed !== "mixed") ||
      (processing?.requested === null &&
        processing.submitted === null &&
        processing.reason !== "native_explicit" &&
        !processing.reason?.startsWith("paid_processing_"))) &&
    (billing === undefined || billing.kind === "unknown")
  )
    return true;
  return processing === undefined && billing === undefined;
}

/** Included work whose route reports no actual debit: admitted and outside the
 * finite cap, but never evidence of zero cash (unlike a paid unknown). */
function allowanceDebitUnobserved(
  route: AuthMode,
  processing?: ProcessingReceipt,
  billing?: ProcessingCostBasis,
): boolean {
  return billing?.debit === "unobserved" && ordinaryIncluded(route, processing, billing);
}

/** Event-local accounting evidence shared by attempts and reviewers. The
 * BudgetLedger remains the sole authority for family spend and reservations. */
export class UsageCostTracker {
  readonly totals: UsageCostTotals;
  unknownPaidUsd = 0;
  /** Meaning of the latest reported amount, for the row disclosing that amount. */
  lastAmountKind: UsageCostBasis["kind"] | null = null;
  private processing?: ProcessingReceipt;
  private billing?: ProcessingCostBasis;
  private active = false;
  private activeSawEvent = false;
  private activePaid = false;
  private activeCashReceipt = false;
  private activeAllowance = false;
  private intervalKey: string | null = null;
  private sawRoute = false;
  private sawCashReceipt = false;
  private sawUnknownUsage = false;
  private sawValuation = false;
  private unresolvedPaid = false;
  private unknownPaidAmount = false;
  private allowanceUnobserved = false;

  constructor(totals?: UsageCostTotals) {
    this.totals = totals ?? {
      cashUsd: 0,
      valuationUsd: 0,
      unknownUsd: 0,
      cashEstimated: false,
      valuationEstimated: false,
    };
  }

  startAttempt(evidence: ProcessingEvidence = {}): void {
    if (this.active) this.finishAttempt();
    this.active = true;
    this.activeSawEvent = false;
    this.activePaid = false;
    this.activeCashReceipt = false;
    this.activeAllowance = false;
    this.intervalKey = null;
    this.processing = evidence.processing;
    this.billing = evidence.processing_cost_basis;
  }

  observeEvent(route: AuthMode, evidence: ProcessingEvidence = {}): void {
    this.processing = evidence.processing ?? this.processing;
    this.billing = evidence.processing_cost_basis ?? this.billing;
    if (!this.active) return;
    this.activeSawEvent = true;
    this.sawRoute ||= route !== null;
    if (route === null) return;
    const key = `${route}:${this.billing?.kind ?? (this.processing ? "unknown" : "legacy")}:${this.billing?.debit ?? ""}`;
    if (this.intervalKey !== null && key !== this.intervalKey) {
      this.unresolvedPaid ||= this.activePaid && !this.activeCashReceipt;
      this.allowanceUnobserved ||= this.activeAllowance && !this.activeCashReceipt;
      this.activePaid = false;
      this.activeCashReceipt = false;
      this.activeAllowance = false;
    }
    this.intervalKey = key;
    this.activePaid ||= !ordinaryIncluded(route, this.processing, this.billing);
    this.activeAllowance ||= allowanceDebitUnobserved(route, this.processing, this.billing);
  }

  observeUsage(route: AuthMode, usd: number, estimated: boolean, event?: HarnessEvent): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    const kind = usageAmountKind(
      route,
      event?.usage?.cost_basis,
      event?.processing ?? this.processing,
      event?.processing_cost_basis ?? this.billing,
    );
    this.lastAmountKind = kind;
    if (kind === "cash") {
      this.sawCashReceipt = true;
      this.activeCashReceipt = true;
      this.totals.cashUsd += usd;
      this.totals.cashEstimated ||= estimated;
    } else if (kind === "valuation") {
      this.sawValuation = true;
      this.totals.valuationUsd += usd;
      this.totals.valuationEstimated ||= estimated;
    } else {
      this.sawUnknownUsage = true;
      const paid = !ordinaryIncluded(
        route,
        event?.processing ?? this.processing,
        event?.processing_cost_basis ?? this.billing,
      );
      this.unknownPaidAmount ||= paid;
      if (paid) this.unknownPaidUsd += usd;
      this.totals.unknownUsd += usd;
    }
  }

  finishAttempt(): void {
    this.unresolvedPaid ||=
      this.activeSawEvent &&
      (this.intervalKey === null || (this.activePaid && !this.activeCashReceipt));
    this.allowanceUnobserved ||=
      this.activeSawEvent && this.activeAllowance && !this.activeCashReceipt;
    this.active = false;
  }

  /** `cashKnowledge` is Claudexor-controllable cash, the finite cap's evidence.
   * An unobserved allowance debit makes only the reported total unknown. */
  snapshot(): {
    cashKnowledge: CostKnowledge;
    valuationKnowledge: CostKnowledge;
    allowanceDebitUnobserved: boolean;
    observedAmounts: ObservedUsageAmounts;
  } {
    const cashUnknown =
      this.unknownPaidAmount ||
      this.unresolvedPaid ||
      (this.activeSawEvent && this.activePaid && !this.activeCashReceipt) ||
      !this.sawRoute;
    return {
      cashKnowledge: cashUnknown ? "unknown" : this.totals.cashEstimated ? "estimated" : "exact",
      valuationKnowledge:
        this.sawUnknownUsage || !this.sawValuation
          ? "unknown"
          : this.totals.valuationEstimated
            ? "estimated"
            : "exact",
      allowanceDebitUnobserved:
        this.allowanceUnobserved ||
        (this.activeSawEvent && this.activeAllowance && !this.activeCashReceipt),
      observedAmounts: {
        cash: this.sawCashReceipt,
        valuation: this.sawValuation,
        unknown: this.sawUnknownUsage,
      },
    };
  }
}

/** Reported cash certainty: controllable knowledge, unless an included route
 * reported no actual debit. The finite cap keeps using the controllable fact. */
export function reportedCashKnowledge(
  controllable: CostKnowledge,
  allowanceDebitUnobserved: boolean | undefined,
): CostKnowledge {
  return allowanceDebitUnobserved ? "unknown" : controllable;
}
