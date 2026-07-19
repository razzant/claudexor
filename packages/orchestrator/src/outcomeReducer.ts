import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import type { DeliveryReceipt, RunOutcomeFacts, RunReason } from "@claudexor/schema";
import { RunOutcomeFacts as RunOutcomeFactsSchema, makeOutcomeFacts } from "@claudexor/schema";

export interface OrchestrateStepOutcome {
  required: boolean;
  executionStatus: "pending" | "running" | "done" | "skipped" | "blocked" | "failed";
  /** The child/delivery terminal outcome AXES for this step (D8). */
  terminalFacts: RunOutcomeFacts | null;
}

/** A terminal whose lifecycle succeeded but which is waiting on a human
 * decision (accepted review blockers or failed checks) — the axes replacement
 * for the ex-"blocked" run status. Surfaced so the parent reducer treats it as
 * a needs-decision terminal, never a clean success. */
function needsDecisionFacts(facts: RunOutcomeFacts): boolean {
  return (
    facts.lifecycle === "succeeded" && (facts.review === "blocked" || facts.checks === "failed")
  );
}

/** A required step is a successful parent terminal only when its child
 * lifecycle succeeded AND it is not waiting on a human decision. no_changes
 * (the ex no_op) is still a clean success. */
export function isSuccessfulOrchestrateTerminal(facts: RunOutcomeFacts | null): boolean {
  return !!facts && facts.lifecycle === "succeeded" && !needsDecisionFacts(facts);
}

/** Parent lifecycle precedence: a genuine process failure outranks a
 * needs-decision terminal (V8 semantic change — the ex-lattice put "blocked"
 * above budget failures; lifecycle-first is more honest: a required budget/
 * harness failure must not read as "succeeded · needs review"). */
const LIFECYCLE_PRECEDENCE = ["failed", "interrupted", "cancelled", "succeeded"] as const;

/** Reason precedence within a failed parent (most-specific budget/convergence
 * reason wins over a generic harness_failed). */
const REASON_PRECEDENCE: readonly RunReason[] = [
  "cost_unverifiable",
  "budget_overshoot",
  "budget_exhausted",
  "not_converged",
  "stuck_no_progress",
  "checks_failed",
  "crash_interrupted",
  "wall_clock_exceeded",
  "user_cancelled",
  "harness_failed",
  "review_blocked",
];

/** Project one step to the parent-relevant terminal facts (null = not
 * required, so it never blocks the parent). */
function normalizedTerminal(step: OrchestrateStepOutcome): RunOutcomeFacts | null {
  if (!step.required) return null;
  if (step.executionStatus === "failed")
    return makeOutcomeFacts("failed", { reason: "harness_failed" });
  // A risky step blocked awaiting a human, or an incomplete/skipped step, is a
  // needs-decision terminal (succeeded + review blocked) UNLESS the executor
  // already stamped a harder terminal (budget/cancel) onto it.
  if (step.executionStatus === "blocked") {
    return makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" });
  }
  if (step.executionStatus === "skipped") {
    if (step.terminalFacts && step.terminalFacts.lifecycle !== "succeeded")
      return step.terminalFacts;
    return makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" });
  }
  if (step.executionStatus === "pending" || step.executionStatus === "running") {
    return makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" });
  }
  // done: the child facts are the terminal.
  return (
    step.terminalFacts ??
    makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
  );
}

function pickReason(reasons: (RunReason | null)[]): RunReason | null {
  for (const r of REASON_PRECEDENCE) if (reasons.includes(r)) return r;
  return reasons.find((r): r is RunReason => r !== null) ?? null;
}

/** Parent success is legal only when every required step has a successful
 * terminal. Reduces required step facts into ONE parent RunOutcomeFacts. */
export function reduceOrchestrateOutcome(
  steps: readonly OrchestrateStepOutcome[],
): RunOutcomeFacts {
  const facts = steps.map(normalizedTerminal).filter((f): f is RunOutcomeFacts => f !== null);
  if (facts.length === 0) return makeOutcomeFacts("succeeded");
  const lifecycle =
    LIFECYCLE_PRECEDENCE.find((lc) => facts.some((f) => f.lifecycle === lc)) ?? "succeeded";
  if (lifecycle !== "succeeded") {
    const reason = pickReason(facts.filter((f) => f.lifecycle === lifecycle).map((f) => f.reason));
    return makeOutcomeFacts(lifecycle, { reason });
  }
  // All required steps succeeded — but surface a needs-decision if any is
  // review-blocked / checks-failed, so the parent fires run.blocked.
  const decisionPending = facts.some(needsDecisionFacts);
  if (decisionPending) {
    return makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" });
  }
  return makeOutcomeFacts("succeeded", { noChanges: facts.every((f) => f.noChanges) });
}

/** Delivery receipts, not the requested autonomy, determine whether execution mutated state. */
export function deliveryReceiptMutated(receipt: DeliveryReceipt): boolean {
  return receipt.treeMutated ?? receipt.applied;
}

export interface ReferencedRunFacts {
  facts: RunOutcomeFacts | null;
  detail: string;
  evidenceRefs: string[];
}

export function readRunStatus(repoRoot: string, runId: string): ReferencedRunFacts | null {
  const store = new ArtifactStore(repoRoot);
  const paths = store.runPaths(runId);
  const decision = store.readYaml<{ facts?: unknown }>(join(paths.arbitrationDir, "decision.yaml"));
  const workProduct = store.readYaml<{ meta?: Record<string, unknown> }>(
    join(paths.finalDir, "work_product.yaml"),
  );
  if (!decision && !workProduct) return null;
  const facts = RunOutcomeFactsSchema.safeParse(decision?.facts);
  const details = [
    facts.success ? `lifecycle=${facts.data.lifecycle}` : null,
    workProduct?.meta?.["result_kind"]
      ? `result_kind=${String(workProduct.meta["result_kind"])}`
      : null,
    workProduct?.meta?.["apply_state"]
      ? `apply_state=${String(workProduct.meta["apply_state"])}`
      : null,
  ].filter((value): value is string => !!value);
  return {
    facts: facts.success ? facts.data : null,
    detail: details.join(", ") || `run ${runId}: artifacts present`,
    evidenceRefs: [
      ...(decision ? [`run:${runId}/arbitration/decision.yaml`] : []),
      ...(workProduct ? [`run:${runId}/final/work_product.yaml`] : []),
    ],
  };
}

export interface OrchestrateFailureDescriptor {
  phase: "plan" | "executor";
  category: "policy" | "internal" | "harness_error" | "budget";
  safeMessage: string;
  nextActions: string[];
}

/** Map a non-clean parent terminal (lifecycle + reason) to a typed failure
 * descriptor. A succeeded-but-needs-decision parent is NOT a failure (it fires
 * run.blocked, not run.failed) so this returns null for it. */
export function orchestrateFailureFor(facts: RunOutcomeFacts): OrchestrateFailureDescriptor | null {
  if (facts.lifecycle === "succeeded") return null;
  const reason = facts.reason;
  if (
    reason === "budget_exhausted" ||
    reason === "budget_overshoot" ||
    reason === "cost_unverifiable"
  ) {
    return {
      phase: "executor",
      category: "budget",
      safeMessage: `orchestrate ended ${facts.lifecycle} (${reason.replaceAll("_", " ")}); inspect its budget and progress evidence`,
      nextActions: ["Inspect final/orchestration_progress.yaml", "Adjust the budget and retry"],
    };
  }
  if (reason === "not_converged" || reason === "stuck_no_progress") {
    return {
      phase: "plan",
      category: "harness_error",
      safeMessage:
        reason === "not_converged"
          ? "orchestrate produced no valid typed plan or a required child did not converge"
          : "orchestrate made no progress on a required step",
      nextActions: ["Inspect orchestration artifacts", "Re-run orchestrate"],
    };
  }
  if (facts.lifecycle === "cancelled") {
    return {
      phase: "executor",
      category: "internal",
      safeMessage: `orchestrate was cancelled${reason ? ` (${reason.replaceAll("_", " ")})` : ""}; inspect the typed progress record`,
      nextActions: ["Inspect final/orchestration_progress.yaml", "Re-run orchestrate"],
    };
  }
  return {
    phase: "executor",
    category: "internal",
    safeMessage: `orchestrate ended ${facts.lifecycle}${reason ? ` (${reason.replaceAll("_", " ")})` : ""}; inspect the typed progress record`,
    nextActions: ["Inspect final/orchestration_progress.yaml", "Retry the failed step"],
  };
}
