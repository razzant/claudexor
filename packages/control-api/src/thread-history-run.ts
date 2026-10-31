import { deriveApplyEligibility } from "@claudexor/delivery";
import {
  DecisionRecord,
  ModeKind,
  RunTelemetry,
  ThreadHistoryRun,
  ThreadHistoryOutput,
  THREAD_HISTORY_ANSWER_BYTES,
  THREAD_HISTORY_FAILURE_BYTES,
  THREAD_HISTORY_FACT_BYTES,
  THREAD_HISTORY_EVENT_BYTES,
  outcomeBanner,
  requiredActionsFor,
} from "@claudexor/schema";
import {
  paramsRecord,
  type DaemonRunRecord,
  type ControlOperatorDecisionRecord,
} from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
import {
  readFailure,
  projectAuthRoute,
  strategyFromParams,
  legacyRunOutcomeFacts,
  planProjectionFor,
} from "./run-card-facts.js";
import { budgetSnapshot } from "./run-budget-snapshot.js";
import { readRunEventsWithIntegrity, eventPayload } from "./run-timeline.js";
import { projectRunFactsForDetail, expectedRunFacts } from "./run-facts-projection.js";
import { primaryOutput, outputReadyStateForPrimary, truncateUtf8 } from "./primary-output.js";
import { controlRunResult } from "./run-delivery-state.js";
import { applyEligibilityFor, validRunOperatorDecision } from "./run-apply-projection.js";

/** A bounded receipt read, never summarizeRun/detail/timeline. Canonical owners
 * supply outcome, cash, readiness and delivery; counts retain evidence coverage. */
export function projectHistoryRun(
  record: DaemonRunRecord,
  input: {
    waitingOnUser: boolean;
    operator: ControlOperatorDecisionRecord | null;
    childRunIds: string[];
  },
) {
  const coverageState = { apply: "complete" as "complete" | "unavailable" };
  let operatorDecisionCoverage: "complete" | "unavailable" = "complete";
  // A bounded history preview cannot verify unlimited exact patch bytes, nor a
  // result record it cannot read. Keep the per-run owner's typed refusal intact;
  // only this row loses coverage.
  const boundedApply = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "artifact_read_limit" && code !== "artifact_read_failed") throw error;
      coverageState.apply = "unavailable";
      return null;
    }
  };
  const operator = boundedApply(() =>
    validRunOperatorDecision(record, input.operator, THREAD_HISTORY_FACT_BYTES),
  );
  if (input.operator && !operator && coverageState.apply === "unavailable")
    operatorDecisionCoverage = "unavailable";
  const p = paramsRecord(record);
  const mode = ModeKind.safeParse(p.mode).data;
  const decision = safeReadStructuredArtifact(
    record,
    "arbitration/decision.yaml",
    DecisionRecord,
    THREAD_HISTORY_FACT_BYTES,
  );
  const telemetry = safeReadStructuredArtifact(
    record,
    "final/telemetry.yaml",
    RunTelemetry,
    THREAD_HISTORY_FACT_BYTES,
  );
  const failure = readFailure(record, THREAD_HISTORY_FACT_BYTES);
  const workState =
    telemetry?.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)?.outcome
      .work_state ?? null;
  const result = controlRunResult(record, THREAD_HISTORY_FACT_BYTES);
  const facts = projectRunFactsForDetail(
    record.runDir,
    legacyRunOutcomeFacts(record, decision, failure, workState),
    operator !== null,
    () => {
      // The delivery owner can classify already-delivered work without patch bytes.
      if (result.applyState !== "not_applied")
        return deriveApplyEligibility({
          applyState: result.applyState,
          decision: null,
          workProduct: null,
          patch: "",
          originalRepoRoot: null,
          targetRepoRoot: "",
        });
      // Mutable decisions and legacy receipts use the SAME exact-patch gate.
      // Unknown eligibility is not negative eligibility or permission to apply.
      return boundedApply(() => applyEligibilityFor(record, operator, THREAD_HISTORY_FACT_BYTES));
    },
    expectedRunFacts(record),
    THREAD_HISTORY_FACT_BYTES,
  );
  if (operatorDecisionCoverage === "unavailable") {
    facts.applyEligibility = null;
    facts.requiredActions = requiredActionsFor(facts.outcomeFacts, false);
  }
  const output = primaryOutput(record, mode, failure, facts.runFacts, {
    maxBytes: THREAD_HISTORY_ANSWER_BYTES,
    patchReferenceOnly: true,
    metadataMaxBytes: THREAD_HISTORY_FACT_BYTES,
  });
  const { events, integrity } = readRunEventsWithIntegrity(record, THREAD_HISTORY_EVENT_BYTES);
  const budget = budgetSnapshot(record, decision, events, integrity, THREAD_HISTORY_FACT_BYTES);
  const coverage =
    integrity.absent || integrity.unreadable
      ? "unavailable"
      : integrity.tailTruncated || integrity.malformedLines || integrity.nonObjectLines
        ? "partial"
        : "complete";
  let tools = 0,
    files = 0;
  const seen = new Set<string>();
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.type !== "harness.event" || payload.type !== "tool_call") continue;
    const tool = payload.tool as { kind?: string; use_id?: string } | undefined;
    const key =
      typeof tool?.use_id === "string"
        ? JSON.stringify([payload.attempt_id, payload.harness_id, tool.use_id])
        : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    tools++;
    if (tool?.kind === "file") files++;
  }
  const plan = planProjectionFor(record, mode, THREAD_HISTORY_FACT_BYTES);
  const finalAttempt = telemetry?.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id);
  const failureMessage = failure
    ? truncateUtf8(failure.safeMessage, THREAD_HISTORY_FAILURE_BYTES)
    : null;
  const summarizeOperator = (decision: ControlOperatorDecisionRecord | null) =>
    decision ? { action: decision.action, decidedAt: decision.decidedAt } : null;
  const run = ThreadHistoryRun.parse({
    state: record.state,
    runDir: record.runDir,
    authRoute: projectAuthRoute(telemetry),
    mode,
    strategy: strategyFromParams(p),
    n: p.n,
    harnesses: p.harnesses,
    primaryHarness: p.primaryHarness,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    result,
    ...facts,
    failure: failure ? { ...failure, safeMessage: failureMessage } : null,
    failureMessageInfo: failure
      ? {
          textBytes: Buffer.byteLength(failureMessage!),
          totalTextBytes: Buffer.byteLength(failure.safeMessage),
          truncated: failureMessage !== failure.safeMessage,
        }
      : null,
    budget,
    spendUsd: budget.spendUsd,
    spendEstimated: budget.estimated,
    waitingOnUser: input.waitingOnUser,
    outputReadyState: outputReadyStateForPrimary(record, failure, facts.runFacts, output),
    delegation: telemetry?.delegation ?? null,
    delegatedChildRunIds: input.childRunIds,
    planReadiness: plan.readiness,
    planQuestions: plan.questions,
    outcomeBanner: outcomeBanner(facts.outcomeFacts, {
      applyState: result.applyState,
      hasApplyableChange: facts.applyEligibility !== null,
    }),
    operatorDecision: summarizeOperator(operator),
    operatorDecisionCoverage,
    unverifiedOperatorDecision:
      operatorDecisionCoverage === "unavailable" ? summarizeOperator(input.operator) : null,
    route: finalAttempt
      ? {
          harnessId: finalAttempt.harness_id,
          observedModel: finalAttempt.observed_model,
          requestedModel: typeof p.model === "string" ? p.model : null,
          verified: finalAttempt.observed_model !== null,
        }
      : null,
    toolCount: { value: coverage === "unavailable" ? null : tools, coverage },
    fileCount: { value: coverage === "unavailable" ? null : files, coverage },
    applyEligibilityCoverage: coverageState.apply,
  });
  return {
    run,
    primaryOutput: output
      ? ThreadHistoryOutput.parse({
          ...output,
          textBytes: Buffer.byteLength(output.text ?? ""),
          totalTextBytes:
            !output.truncated && output.text !== null ? Buffer.byteLength(output.text) : null,
        })
      : null,
  };
}
