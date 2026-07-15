import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { BudgetLedger } from "@claudexor/budget";
import {
  toolRisk,
  type DeliveryReceipt,
  type OrchestrateAutonomy,
  type OrchestratePlan,
  type OrchestratePlanCall,
  type OrchestratePlanProgress,
  type OrchestrateStepStatus,
  type RunStatus,
} from "@claudexor/schema";
import {
  deliveryReceiptMutated,
  isSuccessfulOrchestrateTerminal,
  reduceOrchestrateOutcome,
} from "./outcomeReducer.js";

export interface OrchestrateSafeStepResult {
  status: OrchestrateStepStatus;
  terminalStatus: RunStatus | null;
  terminalSource: "subrun" | "review" | "executor";
  evidenceRefs: string[];
  runId: string | null;
  detail: string | null;
  spendUsd?: number | null;
}

export interface OrchestrateApplyStepResult {
  ok: boolean;
  runId: string;
  detail: string;
  receipt: DeliveryReceipt | null;
}

interface ExecuteOrchestratePlanInput {
  plan: OrchestratePlan;
  autonomy: OrchestrateAutonomy;
  maxToolCalls: number | null;
  ledger: BudgetLedger;
  signal?: AbortSignal;
  store: ArtifactStore;
  paths: ReturnType<ArtifactStore["runPaths"]>;
  log: EventLog;
  executeSafeStep(call: OrchestratePlanCall): Promise<OrchestrateSafeStepResult>;
  executeApplyStep(
    call: Extract<OrchestratePlanCall, { tool: "apply" }>,
  ): Promise<OrchestrateApplyStepResult>;
}

export interface OrchestrateExecutionResult {
  terminal: RunStatus;
  note: string;
  readOnly: boolean;
  receiptRefs: string[];
}

/** Ordered executor; terminal truth is delegated to the exhaustive outcome reducer. */
export async function executeOrchestratePlan(
  input: ExecuteOrchestratePlanInput,
): Promise<OrchestrateExecutionResult> {
  const steps: OrchestratePlanProgress["steps"] = input.plan.tool_calls.map((call, index) => ({
    index,
    tool: call.tool,
    risk: toolRisk(call.tool),
    status: "pending",
    required: call.required,
    terminal_status: null,
    terminal_source: null,
    evidence_refs: [],
    run_id: null,
    detail: null,
  }));
  let stoppedReason: string | null = null;
  let forcedTerminal: RunStatus | null = null;
  let readOnly = true;
  const receiptRefs: string[] = [];
  const persist = (): void => {
    input.store.writeYaml(join(input.paths.finalDir, "orchestration_progress.yaml"), {
      steps,
      autonomy: input.autonomy,
      stopped_reason: stoppedReason,
    } satisfies OrchestratePlanProgress);
  };
  persist();
  input.log.emit("output.ready", { kind: "report", path: "final/orchestration_progress.yaml" });

  let executed = 0;
  for (let i = 0; i < input.plan.tool_calls.length; i++) {
    const call = input.plan.tool_calls[i]!;
    const step = steps[i]!;
    if (input.signal?.aborted) {
      Object.assign(step, {
        status: "skipped",
        terminal_status: "cancelled",
        terminal_source: "executor",
        detail: "run cancelled before this step",
      } satisfies Partial<typeof step>);
      stoppedReason = "cancelled";
      forcedTerminal = "cancelled";
      persist();
      break;
    }
    const budgetTerminal = input.ledger.terminal();
    if (budgetTerminal) {
      Object.assign(step, {
        status: "skipped",
        terminal_status: budgetTerminal,
        terminal_source: "budget",
        detail: `root paid budget stopped execution (${budgetTerminal})`,
      } satisfies Partial<typeof step>);
      stoppedReason = `root paid budget stopped after ${executed} step(s)`;
      forcedTerminal = budgetTerminal;
      persist();
      break;
    }
    if (input.maxToolCalls !== null && executed >= input.maxToolCalls) {
      Object.assign(step, {
        status: "skipped",
        terminal_status: "exhausted",
        terminal_source: "budget",
        detail: `budget max_tool_calls=${input.maxToolCalls} reached`,
      } satisfies Partial<typeof step>);
      stoppedReason = `budget max_tool_calls=${input.maxToolCalls} reached after ${executed} step(s)`;
      forcedTerminal = "exhausted";
      persist();
      break;
    }

    if (toolRisk(call.tool) === "risky") {
      if (input.autonomy === "auto_safe") {
        step.status = step.required ? "blocked" : "skipped";
        step.terminal_status = step.required ? "blocked" : null;
        step.terminal_source = "policy";
        step.detail = "risky step requires human approval (auto_safe)";
        if (step.required)
          stoppedReason = `blocked at risky step #${i} (${call.tool}) under auto_safe`;
        input.log.emit("orchestrate.step.blocked", {
          index: i,
          tool: call.tool,
          autonomy: input.autonomy,
        });
        persist();
        if (step.required) break;
        continue;
      }
      step.status = "running";
      persist();
      executed++;
      try {
        const result = await input.executeApplyStep(
          call as Extract<OrchestratePlanCall, { tool: "apply" }>,
        );
        step.status = result.ok ? "done" : "failed";
        step.terminal_status = result.ok ? "success" : "failed";
        step.terminal_source = "delivery";
        step.run_id = result.runId;
        step.detail = result.detail;
        if (result.receipt) {
          const receiptRef = `final/orchestration_delivery_receipt_${i}.yaml`;
          input.store.writeYaml(join(input.paths.root, receiptRef), result.receipt);
          step.evidence_refs = [receiptRef];
          receiptRefs.push(receiptRef);
          readOnly = readOnly && !deliveryReceiptMutated(result.receipt);
        }
        input.log.emit("orchestrate.step.done", {
          index: i,
          tool: call.tool,
          ok: result.ok,
          run_id: result.runId,
        });
        if (!result.ok) {
          if (step.required) stoppedReason = `apply step #${i} failed: ${result.detail}`;
          persist();
          if (step.required) break;
          continue;
        }
      } catch (error) {
        step.status = "failed";
        step.terminal_status = "failed";
        step.terminal_source = "delivery";
        step.detail = error instanceof Error ? error.message : String(error);
        if (step.required) stoppedReason = `apply step #${i} threw: ${step.detail}`;
        persist();
        if (step.required) break;
        continue;
      }
      persist();
      continue;
    }

    step.status = "running";
    persist();
    executed++;
    try {
      const result = await input.executeSafeStep(call);
      step.status = result.status;
      step.terminal_status = result.terminalStatus;
      step.terminal_source = result.terminalSource;
      step.evidence_refs = result.evidenceRefs;
      step.run_id = result.runId;
      step.detail = result.detail;
      input.log.emit("orchestrate.step.done", {
        index: i,
        tool: call.tool,
        status: result.status,
        run_id: result.runId,
      });
      if (
        step.required &&
        (result.status !== "done" || !isSuccessfulOrchestrateTerminal(result.terminalStatus))
      ) {
        stoppedReason = `required safe step #${i} (${call.tool}) did not succeed: ${result.detail}`;
        persist();
        break;
      }
    } catch (error) {
      step.status = "failed";
      step.terminal_status = "failed";
      step.terminal_source = "executor";
      step.detail = error instanceof Error ? error.message : String(error);
      if (step.required) stoppedReason = `safe step #${i} (${call.tool}) threw: ${step.detail}`;
      persist();
      if (step.required) break;
      continue;
    }
    persist();
  }

  const finalBudgetTerminal = input.ledger.terminal();
  if (!forcedTerminal && finalBudgetTerminal) {
    forcedTerminal = finalBudgetTerminal;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      Object.assign(step, {
        status: "skipped",
        terminal_status: finalBudgetTerminal,
        terminal_source: "budget",
        detail: `root paid budget stopped execution (${finalBudgetTerminal})`,
      } satisfies Partial<typeof step>);
    }
    stoppedReason = `root paid budget stopped after ${executed} step(s)`;
  }
  persist();
  const terminal = reduceOrchestrateOutcome([
    ...steps
      .filter((step) => !forcedTerminal || step.status !== "pending")
      .map((step) => ({
        required: step.required,
        executionStatus: step.status,
        terminalStatus: step.terminal_status,
      })),
    ...(forcedTerminal
      ? [{ required: true, executionStatus: "done" as const, terminalStatus: forcedTerminal }]
      : []),
  ]);
  const done = steps.filter((step) => step.status === "done").length;
  const note = `${terminal} (${done}/${steps.length} steps done${stoppedReason ? `; ${stoppedReason}` : ""})`;
  return { terminal, note, readOnly, receiptRefs };
}
