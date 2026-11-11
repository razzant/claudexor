import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { BudgetLedger, CashCertainty } from "@claudexor/budget";
import { DecisionRecord, type RunOutcomeFacts } from "@claudexor/schema";

export interface SettledBudgetSnapshot {
  /** Known settled cash (the run result's figure); the decision applies `cashCertainty`. */
  spendUsd: number | null;
  valuationUsd: number | null;
  estimated: boolean;
  valuationKnowledge: "exact" | "estimated" | "unknown";
  cashCertainty?: CashCertainty;
}

interface BudgetSnapshotSource {
  spend?: () => number;
  valuation?: () => number;
  spendEstimated?: () => boolean;
  valuationKnowledge?: () => "exact" | "estimated" | "unknown";
  cashCertainty?: () => CashCertainty;
}

/** Decision cash fields. An unknown reported total is never presented as its
 * known subtotal; the cap-governed part stays visible beside it, like the run
 * budget's `spendUsd` / `controllableSpendUsd`. Without certainty (ledgerless
 * or legacy callers) the known amount is kept unchanged. */
function decisionCash(spendUsd: number | null, certainty: CashCertainty | undefined) {
  if (!certainty) return { spend_usd: spendUsd, cash_usd: spendUsd };
  const total = certainty.reported === "unknown" ? null : spendUsd;
  return {
    spend_usd: total,
    cash_usd: total,
    controllable_cash_usd: certainty.controllable === "unknown" ? null : spendUsd,
  };
}

export function settledBudgetSnapshot(source: BudgetSnapshotSource): SettledBudgetSnapshot {
  const read = (value: (() => number) | undefined): number | null => {
    try {
      const result = value?.();
      return typeof result === "number" && Number.isFinite(result) ? result : null;
    } catch {
      return null;
    }
  };
  let estimated = false;
  let valuationKnowledge: "exact" | "estimated" | "unknown" = "unknown";
  try {
    estimated = source.spendEstimated?.() === true;
  } catch {
    estimated = true;
  }
  try {
    valuationKnowledge = source.valuationKnowledge?.() ?? "unknown";
  } catch {
    valuationKnowledge = "unknown";
  }
  let cashCertainty: CashCertainty | undefined;
  try {
    cashCertainty = source.cashCertainty?.();
  } catch {
    cashCertainty = { reported: "unknown", controllable: "unknown" };
  }
  return {
    spendUsd: read(source.spend),
    valuationUsd: read(source.valuation),
    estimated,
    valuationKnowledge,
    ...(cashCertainty ? { cashCertainty } : {}),
  };
}

/** Reconcile a Delegate family's post-drain cash/valuation truth without
 * stripping forward-compatible decision extensions. */
export function reconcileDecisionBudget(
  context: { store: ArtifactStore; paths: { arbitrationDir: string } },
  budget: SettledBudgetSnapshot,
  terminal?: { facts: RunOutcomeFacts; why: string },
): void {
  const path = join(context.paths.arbitrationDir, "decision.yaml");
  const current = context.store.readYaml<unknown>(path);
  if (!current || typeof current !== "object" || Array.isArray(current)) return;
  const record = current as Record<string, unknown>;
  const priorBudget =
    record["budget_summary"] && typeof record["budget_summary"] === "object"
      ? (record["budget_summary"] as Record<string, unknown>)
      : {};
  const reconciled = {
    ...record,
    ...(terminal
      ? {
          facts: terminal.facts,
          why_winner: terminal.why,
          apply_recommendation: "continue",
        }
      : {}),
    budget_summary: {
      ...priorBudget,
      ...decisionCash(budget.spendUsd, budget.cashCertainty),
      valuation_usd: budget.valuationUsd,
      estimated: budget.estimated,
      valuation_knowledge: budget.valuationKnowledge,
    },
  };
  DecisionRecord.parse(reconciled);
  context.store.writeYaml(path, reconciled);
}

export function decisionBudgetSummary(ledger: BudgetLedger) {
  return {
    ...decisionCash(ledger.spend(), ledger.cashCertainty()),
    estimated: ledger.estimated(),
    valuation_usd: ledger.valuation(),
    valuation_knowledge: ledger.valuationKnowledge(),
  } as const;
}

export function arbitrationBudgetOptions(ledger: BudgetLedger) {
  const cash = decisionCash(ledger.spend(), ledger.cashCertainty());
  return {
    spendUsd: cash.spend_usd,
    estimatedSpend: ledger.estimated(),
    cashUsd: cash.cash_usd,
    controllableCashUsd: cash.controllable_cash_usd ?? null,
    valuationUsd: ledger.valuation(),
    valuationKnowledge: ledger.valuationKnowledge(),
  } as const;
}
