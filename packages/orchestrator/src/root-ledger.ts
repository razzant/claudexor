import { BudgetLedger } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import type { QuotaSnapshot, TaskContract } from "@claudexor/schema";
import type { DelegationBudgetAuthority } from "./delegationBudgetAuthority.js";
import type { RunInput } from "./orchestrator.js";

export function createRootLedger(args: {
  input: RunInput;
  contract: TaskContract;
  log: EventLog;
  authority?: DelegationBudgetAuthority;
  quotaSnapshots: readonly QuotaSnapshot[];
}): BudgetLedger {
  const onCashSettled = (
    cashSpendUsd: number,
    valuationUsd: number,
    cashEstimated: boolean,
    valuationKnowledge: "exact" | "estimated" | "unknown",
  ) =>
    args.log.emit("budget.cash", {
      cash_spend_usd: cashSpendUsd,
      valuation_usd: valuationUsd,
      estimated: cashEstimated,
      valuation_knowledge: valuationKnowledge,
    });
  const ledger = args.input.delegatedFromRunId
    ? args.authority?.attachChild(
        args.input.delegatedFromRunId,
        args.input.delegationAdmissionId ?? "",
        args.input.runId!,
        args.contract.task_id,
        onCashSettled,
      )
    : new BudgetLedger(args.contract.budget.paid_budget, undefined, { onCashSettled });
  if (!ledger) {
    throw Object.assign(
      new Error(
        `delegated run ${args.contract.task_id} has no daemon-lifetime budget authority for parent ${args.input.delegatedFromRunId}`,
      ),
      { code: "delegation_budget_parent_unavailable", status: 409 },
    );
  }
  if (args.input.delegatedFromRunId) args.input.onDelegatedLedgerAttached?.();
  for (const snapshot of args.quotaSnapshots) ledger.observeQuotaSnapshot(snapshot);
  return ledger;
}
