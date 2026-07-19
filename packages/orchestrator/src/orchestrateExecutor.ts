import { join } from "node:path";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { BudgetLedger } from "@claudexor/budget";
import {
  makeOutcomeFacts,
  runOutcomeLabel,
  toolRisk,
  type DeliveryReceipt,
  type OrchestrateAutonomy,
  type OrchestratePlan,
  type OrchestratePlanCall,
  type OrchestratePlanProgress,
  type OrchestrateStepStatus,
  type RunOutcomeFacts,
} from "@claudexor/schema";
import {
  deliveryReceiptMutated,
  isSuccessfulOrchestrateTerminal,
  reduceOrchestrateOutcome,
} from "./outcomeReducer.js";

export interface OrchestrateSafeStepResult {
  status: OrchestrateStepStatus;
  terminalFacts: RunOutcomeFacts | null;
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
  terminal: RunOutcomeFacts;
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
    terminal_facts: null,
    terminal_source: null,
    evidence_refs: [],
    run_id: null,
    detail: null,
  }));
  let stoppedReason: string | null = null;
  let forcedTerminal: RunOutcomeFacts | null = null;
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
        terminal_facts: makeOutcomeFacts("cancelled", { reason: "user_cancelled" }),
        terminal_source: "executor",
        detail: "run cancelled before this step",
      } satisfies Partial<typeof step>);
      stoppedReason = "cancelled";
      forcedTerminal = makeOutcomeFacts("cancelled", { reason: "user_cancelled" });
      persist();
      break;
    }
    const budgetTerminal = input.ledger.terminal();
    if (budgetTerminal) {
      const budgetFacts = makeOutcomeFacts("failed", { reason: budgetTerminal });
      Object.assign(step, {
        status: "skipped",
        terminal_facts: budgetFacts,
        terminal_source: "budget",
        detail: `root paid budget stopped execution (${budgetTerminal})`,
      } satisfies Partial<typeof step>);
      stoppedReason = `root paid budget stopped after ${executed} step(s)`;
      forcedTerminal = budgetFacts;
      persist();
      break;
    }
    if (input.maxToolCalls !== null && executed >= input.maxToolCalls) {
      const exhaustedFacts = makeOutcomeFacts("failed", { reason: "budget_exhausted" });
      Object.assign(step, {
        status: "skipped",
        terminal_facts: exhaustedFacts,
        terminal_source: "budget",
        detail: `budget max_tool_calls=${input.maxToolCalls} reached`,
      } satisfies Partial<typeof step>);
      stoppedReason = `budget max_tool_calls=${input.maxToolCalls} reached after ${executed} step(s)`;
      forcedTerminal = exhaustedFacts;
      persist();
      break;
    }

    if (toolRisk(call.tool) === "risky") {
      if (input.autonomy === "auto_safe") {
        step.status = step.required ? "blocked" : "skipped";
        step.terminal_facts = step.required
          ? makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
          : null;
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
        step.terminal_facts = result.ok
          ? makeOutcomeFacts("succeeded")
          : makeOutcomeFacts("failed", { reason: "harness_failed" });
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
        step.terminal_facts = makeOutcomeFacts("failed", { reason: "harness_failed" });
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
      step.terminal_facts = result.terminalFacts;
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
        (result.status !== "done" || !isSuccessfulOrchestrateTerminal(result.terminalFacts))
      ) {
        stoppedReason = `required safe step #${i} (${call.tool}) did not succeed: ${result.detail}`;
        persist();
        break;
      }
    } catch (error) {
      step.status = "failed";
      step.terminal_facts = makeOutcomeFacts("failed", { reason: "harness_failed" });
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
    const finalBudgetFacts = makeOutcomeFacts("failed", { reason: finalBudgetTerminal });
    forcedTerminal = finalBudgetFacts;
    for (const step of steps) {
      if (step.status !== "pending") continue;
      Object.assign(step, {
        status: "skipped",
        terminal_facts: finalBudgetFacts,
        terminal_source: "budget",
        detail: `root paid budget stopped execution (${finalBudgetTerminal})`,
      } satisfies Partial<typeof step>);
    }
    stoppedReason = `root paid budget stopped after ${executed} step(s)`;
  }
  persist();
  const capturedForcedTerminal = forcedTerminal;
  const terminal = reduceOrchestrateOutcome([
    ...steps
      .filter((step) => !capturedForcedTerminal || step.status !== "pending")
      .map((step) => ({
        required: step.required,
        executionStatus: step.status,
        terminalFacts: step.terminal_facts,
      })),
    ...(capturedForcedTerminal
      ? [
          {
            required: true,
            executionStatus: "done" as const,
            terminalFacts: capturedForcedTerminal,
          },
        ]
      : []),
  ]);
  const done = steps.filter((step) => step.status === "done").length;
  const note = `${runOutcomeLabel(terminal)} (${done}/${steps.length} steps done${stoppedReason ? `; ${stoppedReason}` : ""})`;
  return { terminal, note, readOnly, receiptRefs };
}
