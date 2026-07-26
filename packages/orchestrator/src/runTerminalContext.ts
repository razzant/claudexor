import type { ArtifactStore } from "@claudexor/artifact-store";
import type { BudgetLedger, BudgetTerminal } from "@claudexor/budget";
import type { EventLog } from "@claudexor/event-log";
import type { ModeKind } from "@claudexor/schema";

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
  /** Re-evaluated after Delegate child drain. A child settlement can make the
   * shared family overshoot or become unverifiable after strategy synthesis. */
  budgetTerminal?: () => BudgetTerminal;
  /** True only while this run owns the effective Delegate family authority.
   * Ordinary runs may already have emitted a non-deferred terminal and must
   * never be terminalized a second time by the post-drain recheck. */
  recheckBudgetAfterBarrier?: () => boolean;
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
    budgetTerminal: () => ledger.terminal(),
    recheckBudgetAfterBarrier: hasDelegateAuthority,
  };
}
