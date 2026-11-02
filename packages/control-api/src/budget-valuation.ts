import { eventPayload } from "./run-timeline.js";

type Knowledge = "exact" | "estimated" | "unknown";

const knowledgeOf = (value: unknown): Knowledge | undefined =>
  value === "exact" || value === "estimated" || value === "unknown" ? value : undefined;

/**
 * Every budget fact a run's events contribute, folded one event at a time in
 * file order, so a complete read and an appended-suffix read agree exactly.
 * decision.yaml, the contract and settings combine with it per projection.
 */
export interface BudgetEventFold {
  /** The last finite `budget.cash` spend and its ledger estimate flag. */
  lastCash: number | null;
  lastCashEstimated: boolean;
  /** The last finite `budget.cash` valuation, with its knowledge. */
  ledgerValuation: { usd: number | null; knowledge: Knowledge } | null;
  /** Some `budget.cash` named a component-aware valuation knowledge. */
  componentAware: boolean;
  cashKnowledge?: Knowledge;
  controllableCashKnowledge?: Knowledge;
  /** Summed nonzero `budget.observation` spend, the legacy cash and valuation fallback. */
  observationUsd: number;
  sawObservation: boolean;
  /** A zero spend row named its amount as cash, before any settlement says so. */
  cashZeroObserved: boolean;
  /** Certainty of the zero spend rows that named their amount as valuation. */
  valuationZeroKnowledge?: Knowledge;
  /** An estimated observation or harness usage report. */
  observationEstimated: boolean;
  usageCostUsd: number;
  sawCost: boolean;
  sawUsage: boolean;
}

export function emptyBudgetFold(): BudgetEventFold {
  return {
    lastCash: null,
    lastCashEstimated: false,
    ledgerValuation: null,
    componentAware: false,
    observationUsd: 0,
    sawObservation: false,
    cashZeroObserved: false,
    observationEstimated: false,
    usageCostUsd: 0,
    sawCost: false,
    sawUsage: false,
  };
}

export function addBudgetEvent(fold: BudgetEventFold, ev: Record<string, unknown>): void {
  const payload = eventPayload(ev);
  if (ev["type"] === "budget.cash") {
    const cash = payload["cash_spend_usd"];
    if (typeof cash === "number" && Number.isFinite(cash)) {
      fold.lastCash = cash;
      fold.lastCashEstimated = cashEstimatedFromLedgerEvent(payload);
    }
    const knowledge = knowledgeOf(payload["valuation_knowledge"]);
    if (knowledge) fold.componentAware = true;
    const val = payload["valuation_usd"];
    if (typeof val === "number" && Number.isFinite(val)) {
      // Legacy budget.cash had no valuation-specific knowledge. A positive
      // token valuation is safely estimated; zero alone cannot prove that
      // valuation evidence existed.
      fold.ledgerValuation = knowledge
        ? { usd: knowledge === "unknown" ? null : val, knowledge }
        : { usd: val > 0 ? val : null, knowledge: val > 0 ? "estimated" : "unknown" };
    }
    fold.cashKnowledge = knowledgeOf(payload["cash_knowledge"]) ?? fold.cashKnowledge;
    fold.controllableCashKnowledge =
      knowledgeOf(payload["controllable_cash_knowledge"]) ?? fold.controllableCashKnowledge;
    return;
  }
  if (ev["type"] === "budget.observation" && payload["kind"] === "spend") {
    const usd = payload["usd"];
    if (typeof usd === "number" && Number.isFinite(usd)) {
      if (usd !== 0) {
        fold.observationUsd += usd;
        fold.sawObservation = true;
      } else if (payload["amount_kind"] === "cash") {
        fold.cashZeroObserved = true;
      } else if (payload["amount_kind"] === "valuation") {
        // Zero alone proves no valuation, like a legacy budget.cash zero; only
        // a row naming its meaning does.
        fold.valuationZeroKnowledge =
          payload["estimated"] === true ? "estimated" : (fold.valuationZeroKnowledge ?? "exact");
      }
    }
    if (payload["estimated"] === true) fold.observationEstimated = true;
    return;
  }
  if (ev["type"] !== "harness.event") return;
  const usage = payload["usage"];
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  fold.sawUsage = true;
  const cost = (usage as Record<string, unknown>)["cost_usd"];
  if (typeof cost === "number" && Number.isFinite(cost)) {
    fold.usageCostUsd += cost;
    fold.sawCost = true;
  }
  if ((usage as Record<string, unknown>)["estimated"] === true) fold.observationEstimated = true;
}

export function foldBudgetEvents(events: readonly Record<string, unknown>[]): BudgetEventFold {
  const fold = emptyBudgetFold();
  for (const ev of events) addBudgetEvent(fold, ev);
  return fold;
}

/**
 * Pure subscription-VALUATION view (QA-023c/QA-017b), independent of the cash
 * truth. The owner-locked ledger settles native-subscription work to cash $0
 * while accumulating its token valuation on `budget.cash.valuation_usd`
 * (last-wins, cumulative). An UNKNOWN valuation (no usage ever reported — e.g.
 * a Cursor draft) stays NULL and is never coerced to a fake $0. Before the first
 * settlement, and for runs predating budget.cash, the fallback is the summed
 * nonzero `budget.observation` spend, then a zero row naming itself valuation; a
 * cash zero is no valuation at all.
 */
export function budgetValuation(fold: BudgetEventFold): {
  valuationUsd: number | null;
  valuationKnowledge: Knowledge;
} {
  if (fold.ledgerValuation)
    return {
      valuationUsd: fold.ledgerValuation.usd,
      valuationKnowledge: fold.ledgerValuation.knowledge,
    };
  if (fold.sawObservation)
    return { valuationUsd: fold.observationUsd, valuationKnowledge: "estimated" };
  if (fold.valuationZeroKnowledge)
    return { valuationUsd: 0, valuationKnowledge: fold.valuationZeroKnowledge };
  return { valuationUsd: null, valuationKnowledge: "unknown" };
}

export function normalizeLegacyBudgetComponents(
  budget: {
    estimated?: boolean;
    spend_usd?: number | null;
    valuation_usd?: number | null;
    valuation_knowledge?: Knowledge;
  } | null,
  fold: BudgetEventFold,
): ReturnType<typeof budgetValuation> & { cashEstimated: boolean } {
  let cashEstimated = budget?.estimated ?? false;
  let { valuationUsd, valuationKnowledge } = budgetValuation(fold);
  const knowledge = budget?.valuation_knowledge;
  const valuation = budget?.valuation_usd;
  if (knowledge && typeof valuation === "number" && Number.isFinite(valuation)) {
    valuationKnowledge = knowledge;
    valuationUsd = knowledge === "unknown" ? null : valuation;
  } else if (valuationUsd === null && typeof valuation === "number" && valuation > 0) {
    valuationUsd = valuation;
    valuationKnowledge = "estimated";
  }
  if (
    knowledge === undefined &&
    !fold.componentAware &&
    cashEstimated &&
    budget?.spend_usd === 0 &&
    typeof valuation === "number" &&
    valuation > 0
  ) {
    cashEstimated = false;
  }
  return { valuationUsd, valuationKnowledge, cashEstimated };
}

export function cashEstimatedFromLedgerEvent(payload: Record<string, unknown>): boolean {
  const estimated = payload["estimated"] === true;
  const legacyExactZero =
    payload["valuation_knowledge"] === undefined &&
    estimated &&
    payload["cash_spend_usd"] === 0 &&
    typeof payload["valuation_usd"] === "number" &&
    payload["valuation_usd"] > 0;
  return estimated && !legacyExactZero;
}

/** Cash the finite cap governs. A new component-aware ledger receipt
 * distinguishes unknown from estimated zero; absence preserves historical
 * projection behavior. The controllable key is the cap-governed part; older
 * receipts carry only the reported total. An included route without a debit
 * receipt leaves the reported total unknown while this part stays known. */
export function controllableSpend(fold: BudgetEventFold, spendUsd: number | null): number | null {
  return (fold.controllableCashKnowledge ?? fold.cashKnowledge) === "unknown" ? null : spendUsd;
}

/** A current decision keeps an unknown total null beside its known cap-governed
 * part; that part still anchors the run budget projection. */
export function decisionCashAnchor(
  budget: { spend_usd?: number | null; controllable_cash_usd?: number | null } | undefined,
): { spendUsd: number | null; totalUnknown: boolean } {
  return {
    spendUsd: budget?.spend_usd ?? budget?.controllable_cash_usd ?? null,
    totalUnknown: budget?.spend_usd === null && typeof budget.controllable_cash_usd === "number",
  };
}
