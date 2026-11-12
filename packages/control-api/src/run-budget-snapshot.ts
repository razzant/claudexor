import {
  ControlBudgetSnapshot,
  PaidBudget,
  TaskContract,
  type DecisionRecord,
} from "@claudexor/schema";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";
import { projectionRead } from "./projection-context.js";
import { type RunEventsIntegrity, evidenceLevel } from "./run-timeline.js";
import { readRunEventFacts, type RunEventFacts } from "./run-event-facts.js";
import {
  type BudgetEventFold,
  controllableSpend,
  decisionCashAnchor,
  foldBudgetEvents,
  normalizeLegacyBudgetComponents,
} from "./budget-valuation.js";

/** Bounded readers pass their own event snapshot; complete projections pass,
 * or read, the run's folded event facts. */
export function budgetSnapshot(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  events?: Record<string, unknown>[] | RunEventFacts,
  integrity?: RunEventsIntegrity,
  maxBytes?: number,
): ControlBudgetSnapshot {
  return projectionRead(rec.runDir ?? rec.id, `budget:${maxBytes ?? "all"}`, () => {
    const facts = Array.isArray(events) ? undefined : (events ?? readRunEventFacts(rec));
    return computeBudgetSnapshot(
      rec,
      decision,
      facts?.budget ?? foldBudgetEvents(events as Record<string, unknown>[]),
      integrity ?? facts?.integrity ?? readRunEventFacts(rec).integrity,
      maxBytes,
    );
  });
}

function computeBudgetSnapshot(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  fold: BudgetEventFold,
  integrity?: RunEventsIntegrity,
  maxBytes?: number,
): ControlBudgetSnapshot {
  const p = paramsRecord(rec);
  // The ENGINE-EFFECTIVE cap lives in the immutable contract (request input,
  // surface default, or the configured global per-run default); request params
  // alone under-report a config-defaulted cap as "no cap".
  const contractBudget = safeReadStructuredArtifact(
    rec,
    "context/task.yaml",
    TaskContract,
    maxBytes,
  )?.budget.paid_budget;
  const paidBudget = PaidBudget.safeParse(p["paidBudget"]).data ??
    contractBudget ?? { kind: "unlimited" as const };
  const anchor = decisionCashAnchor(decision?.budget_summary);
  let spendUsd = anchor.spendUsd;
  let source: "decision" | "events" | "settings" | "unknown" =
    spendUsd === null ? "unknown" : "decision";
  // Subscription VALUATION (QA-023c/QA-017b) beside cash — computed by the pure
  // event fold so an UNKNOWN valuation stays null, never a fabricated $0.
  const normalized = normalizeLegacyBudgetComponents(decision?.budget_summary ?? null, fold);
  let { valuationUsd, valuationKnowledge } = normalized;
  let estimated = normalized.cashEstimated;
  if (spendUsd === null) {
    // The CASH truth for a decision-less run (plan/ask/explore — they never
    // write a decision record) is the ledger's own `budget.cash` disclosure:
    // cumulative, last-wins, subscription work settles to 0 there (W4.3).
    // budget.observation ticks are vendor VALUATION — for a subscription run
    // they are NON-ZERO while the cash truth is $0.00, so summing them as
    // spend showed valuation under a "real money" label (F4 review lane 1).
    // They remain only as the LEGACY fallback for runs predating budget.cash
    // (every new run settles at least once), disclosed as estimated.
    if (fold.lastCash !== null) {
      spendUsd = fold.lastCash;
      source = "events";
      estimated = fold.lastCashEstimated;
    } else if (fold.sawObservation) {
      spendUsd = fold.observationUsd;
      source = "events";
      estimated = true; // valuation-derived: at best an estimate of cash
    } else if (fold.sawCost) {
      spendUsd = fold.usageCostUsd;
      source = "events";
      estimated = true;
    } else if (fold.sawUsage) {
      source = "events";
    }
    if (fold.observationEstimated && fold.lastCash === null) estimated = true;
  }
  const cashKnowledge = fold.cashKnowledge;
  const controllableSpendUsd = controllableSpend(fold, spendUsd);
  if (cashKnowledge === "unknown" || anchor.totalUnknown) spendUsd = null;
  if (cashKnowledge !== undefined) estimated = cashKnowledge !== "exact";
  const remainingUsd =
    paidBudget.kind === "finite" && controllableSpendUsd !== null
      ? Math.max(0, paidBudget.maxUsd - controllableSpendUsd)
      : null;
  // Disclose when the spend fallback read incomplete/unreadable canonical
  // events (QA-074): a partial event set can silently drop a spend tick, so the
  // projected spend must never present as clean when its evidence was not.
  const evidence = integrity ? evidenceLevel(integrity) : "complete";
  return ControlBudgetSnapshot.parse({
    cashKnowledge,
    paidBudget,
    spendUsd,
    controllableSpendUsd,
    valuationUsd,
    valuationKnowledge,
    remainingUsd,
    estimated,
    source,
    evidence,
  });
}
