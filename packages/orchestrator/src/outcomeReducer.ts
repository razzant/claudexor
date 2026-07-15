import { join } from "node:path";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  RunStatus as RunStatusSchema,
  type DeliveryReceipt,
  type RunStatus,
} from "@claudexor/schema";

export interface OrchestrateStepOutcome {
  required: boolean;
  executionStatus: "pending" | "running" | "done" | "skipped" | "blocked" | "failed";
  terminalStatus: RunStatus | null;
}

const PRECEDENCE: readonly RunStatus[] = [
  "failed",
  "interrupted_unknown",
  "blocked",
  "cost_unverifiable",
  "exhausted_overshoot",
  "exhausted",
  "not_converged",
  "stuck_no_progress",
  "cancelled",
  "success",
];

function normalizedTerminal(step: OrchestrateStepOutcome): RunStatus | null {
  if (!step.required) return null;
  if (step.executionStatus === "failed") return "failed";
  if (step.executionStatus === "blocked") return "blocked";
  if (step.executionStatus === "skipped") {
    if (
      step.terminalStatus === "cancelled" ||
      step.terminalStatus === "interrupted_unknown" ||
      step.terminalStatus === "cost_unverifiable" ||
      step.terminalStatus === "exhausted_overshoot" ||
      step.terminalStatus === "exhausted"
    )
      return step.terminalStatus;
    return "blocked";
  }
  if (step.executionStatus === "pending" || step.executionStatus === "running") return "blocked";
  if (step.terminalStatus === "no_op") return "success";
  if (step.terminalStatus === "ungated" || step.terminalStatus === "review_not_run")
    return "blocked";
  return step.terminalStatus ?? "blocked";
}

export function isSuccessfulOrchestrateTerminal(status: RunStatus | null): boolean {
  return status === "success" || status === "no_op";
}

/** Parent success is legal only when every required step has a successful terminal. */
export function reduceOrchestrateOutcome(steps: readonly OrchestrateStepOutcome[]): RunStatus {
  const actual = steps.map(normalizedTerminal).filter((status): status is RunStatus => !!status);
  return PRECEDENCE.find((status) => actual.includes(status)) ?? "success";
}

/** Delivery receipts, not the requested autonomy, determine whether execution mutated state. */
export function deliveryReceiptMutated(receipt: DeliveryReceipt): boolean {
  return receipt.treeMutated ?? (receipt.applied && receipt.mode !== "artifact_only");
}

export interface ReferencedRunStatus {
  status: RunStatus | null;
  detail: string;
  evidenceRefs: string[];
}

export function readRunStatus(repoRoot: string, runId: string): ReferencedRunStatus | null {
  const store = new ArtifactStore(repoRoot);
  const paths = store.runPaths(runId);
  const decision = store.readYaml<{ status?: string }>(join(paths.arbitrationDir, "decision.yaml"));
  const workProduct = store.readYaml<{ meta?: Record<string, unknown> }>(
    join(paths.finalDir, "work_product.yaml"),
  );
  if (!decision && !workProduct) return null;
  const status = RunStatusSchema.safeParse(decision?.status);
  const details = [
    decision?.status ? `decision=${decision.status}` : null,
    workProduct?.meta?.["result_kind"]
      ? `result_kind=${String(workProduct.meta["result_kind"])}`
      : null,
    workProduct?.meta?.["apply_state"]
      ? `apply_state=${String(workProduct.meta["apply_state"])}`
      : null,
  ].filter((value): value is string => !!value);
  return {
    status: status.success ? status.data : null,
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

export function orchestrateFailureFor(status: RunStatus): OrchestrateFailureDescriptor | null {
  switch (status) {
    case "blocked":
      return {
        phase: "executor",
        category: "policy",
        safeMessage:
          "orchestrate has required work that did not succeed (including skipped, ungated, missing-review, or risky steps); inspect the typed progress record",
        nextActions: [
          "Inspect final/orchestration_progress.yaml",
          "Resolve or retry the blocked step",
        ],
      };
    case "failed":
    case "interrupted_unknown":
      return {
        phase: "executor",
        category: "internal",
        safeMessage: `orchestrate ended ${status}; inspect the typed progress record`,
        nextActions: ["Inspect final/orchestration_progress.yaml", "Retry the failed step"],
      };
    case "not_converged":
    case "stuck_no_progress":
      return {
        phase: "plan",
        category: "harness_error",
        safeMessage:
          status === "not_converged"
            ? "orchestrate produced no valid typed plan or a required child did not converge"
            : "orchestrate made no progress on a required step",
        nextActions: ["Inspect orchestration artifacts", "Re-run orchestrate"],
      };
    case "cost_unverifiable":
    case "exhausted_overshoot":
    case "exhausted":
      return {
        phase: "executor",
        category: "budget",
        safeMessage: `orchestrate ended ${status}; inspect its budget and progress evidence`,
        nextActions: ["Inspect final/orchestration_progress.yaml", "Adjust the budget and retry"],
      };
    default:
      return null;
  }
}
