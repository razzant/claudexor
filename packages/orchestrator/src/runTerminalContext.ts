import type { ArtifactStore } from "@claudexor/artifact-store";
import type { BudgetLedger, BudgetTerminal, CashCertainty } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import type { ModeKind } from "@claudexor/schema";
import type { ContinuityTerminalFacts } from "./continuity-terminal.js";

export interface AnnouncedRunContext {
  log: EventLog;
  store: ArtifactStore;
  paths: ReturnType<ArtifactStore["runPaths"]>;
  runId: string;
  taskId: string;
  mode: ModeKind;
  /** Failure phase label when the net has to stamp the terminal. */
  phase: string;
  /** Settled ledger spend snapshot — failure/cancel terminals must account
   * for money already spent exactly like success terminals do. */
  spend?: () => number;
  valuation?: () => number;
  spendEstimated?: () => boolean;
  valuationKnowledge?: () => "exact" | "estimated" | "unknown";
  /** Reported vs cap-governed certainty of `spend`, for the decision record. */
  cashCertainty?: () => CashCertainty;
  /** Re-evaluated after Delegate child drain. A child settlement can make the
   * shared family overshoot or become unverifiable after strategy synthesis. */
  budgetTerminal?: () => BudgetTerminal;
  /** True only while this run owns the effective Delegate family authority.
   * Ordinary runs may already have emitted a non-deferred terminal and must
   * never be terminalized a second time by the post-drain recheck. */
  recheckBudgetAfterBarrier?: () => boolean;
  /** The lane's own attempts once they exist (each with its tries' accounts):
   * a failure this owner stamps after the strategy names their failed tries. */
  attempts?: () => readonly ContinuityTerminalFacts[];
}

type AnnouncedRunIdentity = Pick<
  AnnouncedRunContext,
  "log" | "store" | "paths" | "runId" | "taskId" | "mode" | "phase"
>;

export function announcedRunContext(
  identity: AnnouncedRunIdentity,
  ledger: BudgetLedger,
  hasDelegateAuthority: () => boolean,
): AnnouncedRunContext {
  return {
    ...identity,
    spend: () => ledger.spend(),
    valuation: () => ledger.valuation(),
    spendEstimated: () => ledger.estimated(),
    valuationKnowledge: () => ledger.valuationKnowledge(),
    cashCertainty: () => ledger.cashCertainty(),
    budgetTerminal: () => ledger.terminal(),
    recheckBudgetAfterBarrier: hasDelegateAuthority,
  };
}
