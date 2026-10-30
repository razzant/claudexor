import {
  bindProcessingAdmission,
  processingAdmissionForLease,
  processingAttemptCostEvidence,
  updateProcessingStreamHold,
  ProcessingBudgetAdmissionError,
} from "./processing-dispatch.js";
import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import {
  AnswerAssembly,
  appendHarnessEvent,
  countsAsAgentProgress,
  type InteractionChannel,
  type ProcessingAdmission,
  withInactivityWatchdog,
} from "@claudexor/core";
import type { EventLog } from "@claudexor/event-log";
import type {
  ExternalContextPolicy,
  ActiveTaskContract,
  HarnessEvent,
  HarnessRunSpec,
  Intent,
} from "@claudexor/schema";
import { redactSecrets, safeInvoke } from "@claudexor/util";
import {
  finalizeAttempt,
  unrecoveredToolErrorFailure,
  webEvidenceFailure,
  type AttemptOutcomeClass,
} from "./attemptFinalize.js";
import {
  unwrapWorkReportEnvelope,
  type UnwrappedAnswer,
  type WorkReportEnvelopeMode,
} from "./workReportEnvelope.js";
import {
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  unrecoveredToolErrors,
  webUnsatisfied,
  type AttemptTelemetry,
} from "./attemptTelemetry.js";
import { settleGrantedAttemptLease } from "./attemptUsageCost.js";
import { observeNativeSessionEvent } from "./credential-profiles.js";
import type { BudgetDenial } from "./budgetFailure.js";
import { declaredFailure, type DeclaredFailure } from "./runTerminalResults.js";
import { endsPendingLimit, pinnedTypedLimit } from "./quota-refusal-scope.js";
import { marksAgentProgress } from "./attemptOutputMarkers.js";
import { runModelGovernedRoute } from "./modelGovernance.js";
import type { RoutedAdapter, RunInput } from "./orchestrator.js";
import {
  harnessEventPayload,
  observeAuthSwitch,
  observeBudgetSignals,
  safeErrorMessage,
} from "./runSupport.js";

/** Result of one planner spawn; caller-specific artifact/fallback bookkeeping
 * remains with solo-plan and Council owners. */
export interface PlannerAttemptOutcome {
  attemptId: string;
  harnessId: string;
  status: "success" | "failed" | "blocked";
  outcomeClass: AttemptOutcomeClass;
  error: string | null;
  /** Original harness failure before a report-contract failure is overlaid. */
  harnessFailedBeforeReport: boolean;
  reportProblem?: UnwrappedAnswer["reportProblem"];
  text: string | null;
  telemetry: AttemptTelemetry | null;
  budgetDenied: boolean;
  budgetDenial?: BudgetDenial | null;
  declaredFailure?: DeclaredFailure;
}

/** Preserve the same typed outcome in solo, Council and merge failure paths. */
export function plannerAttemptSummary(outcome: PlannerAttemptOutcome) {
  return {
    attemptId: outcome.attemptId,
    harnessId: outcome.harnessId,
    status: outcome.status,
    outcomeClass: outcome.outcomeClass,
    error: outcome.error,
    declaredFailure: outcome.declaredFailure,
  };
}

/** Inputs shared by solo fallback, Council drafts, and the Council merge. */
export interface PlannerAttemptArgs {
  input: RunInput;
  contract: ActiveTaskContract;
  taskId: string;
  runId: string;
  log: EventLog;
  store: ArtifactStore;
  paths: RunPaths;
  ledger: BudgetLedger;
  routed: RoutedAdapter;
  attemptId: string;
  laneRun: boolean;
  fallbackHome: Record<string, string>;
  promptBody: string;
  intent: Intent;
  /** Conservative admission floor for a parallel Council member or a real
   * Delegate child that overlaps its still-running parent. */
  reservationEstimateUsd?: number;
}

export interface PreparedPlannerAttempt {
  knobs: {
    webPolicy: ExternalContextPolicy;
    ignored: string[];
    model: string | null;
  };
  effectiveWeb: ExternalContextPolicy;
  spec: HarnessRunSpec;
  plannerAbort: AbortController;
  planInteraction: InteractionChannel | undefined;
  planWorkMode: WorkReportEnvelopeMode;
}

/** Narrow owner boundary: Orchestrator prepares its private route/session
 * fields; this module owns the planner lease, stream, telemetry, and outcome. */
export interface PlannerAttemptDeps {
  prepare(
    args: PlannerAttemptArgs,
    admission: ProcessingAdmission,
    started: () => void,
  ): Promise<PreparedPlannerAttempt>;
  billingKnowledge(
    input: RunInput,
    harnessId: string,
    routed: RoutedAdapter,
  ): "metered" | "subscription_entitlement" | "unknown";
  inactivityTimeoutMs(repoRoot: string): number | null;
  quotaEventSink?: (harnessId: string, event: HarnessEvent) => void;
}

export async function runPlannerAttempt(
  deps: PlannerAttemptDeps,
  args: PlannerAttemptArgs,
): Promise<PlannerAttemptOutcome> {
  const { input, contract, taskId, log, paths, ledger, routed, attemptId } = args;
  const adapter = routed.adapter;
  const lease = ledger.reserve({
    taskId,
    attemptId,
    intent: args.intent,
    harnessId: adapter.id,
    cost: processingAttemptCostEvidence(
      adapter.id,
      attemptId,
      args.reservationEstimateUsd,
      deps.billingKnowledge(input, adapter.id, routed),
      routed.processing,
    ),
  });
  if (!lease.granted) {
    log.emit("budget.lease.created", {
      granted: false,
      reason: lease.reason,
      denied: lease.denied,
      attempt_id: attemptId,
      harness_id: adapter.id,
    });
    return {
      attemptId,
      harnessId: adapter.id,
      status: "failed",
      outcomeClass: "clean",
      error: lease.reason ?? "budget lease denied",
      harnessFailedBeforeReport: false,
      text: null,
      telemetry: null,
      budgetDenied: true,
      budgetDenial: {
        code: lease.denied ?? "hard_cap",
        reason: lease.reason ?? "budget lease denied",
        harnessId: adapter.id,
        attemptId,
      },
    };
  }

  let physicalStarted = false;
  const markStarted = () => {
    physicalStarted = true;
    ledger.markPhysicalDispatchStarted(lease.lease!.lease_id);
  };
  const admission = processingAdmissionForLease(ledger, lease.lease!, adapter.id, attemptId);
  // Preparation belongs to the granted lease. No harness lifecycle event is
  // emitted until every route/session/spec field and telemetry seed exists.
  const preparation = await (async () => {
    const prepared = await deps.prepare(args, admission, markStarted);
    return {
      ...prepared,
      attemptEventsPath: join(paths.attemptsDir, attemptId, "events.jsonl"),
      answer: new AnswerAssembly(),
      telemetry: createAttemptTelemetry(
        prepared.knobs.webPolicy,
        contract.external_context.web_required,
        prepared.effectiveWeb,
        [],
        prepared.knobs.model,
      ),
    };
  })().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (!preparation.ok) {
    if (!physicalStarted) ledger.cancel(lease.lease!.lease_id);
    else
      settleGrantedAttemptLease({
        ledger,
        leaseId: lease.lease?.lease_id ?? "",
        attemptId,
        harnessId: adapter.id,
        costUsd: 0,
        costEstimated: false,
        preStreamFailureSource: "planner-pre-stream",
      });
    return {
      attemptId,
      harnessId: adapter.id,
      status: "failed",
      outcomeClass: "clean",
      error: `planner attempt setup failed: ${safeErrorMessage(preparation.error)}`,
      harnessFailedBeforeReport: true,
      text: null,
      telemetry: null,
      budgetDenied: false,
    };
  }

  const {
    knobs,
    spec,
    plannerAbort,
    planInteraction,
    planWorkMode,
    attemptEventsPath,
    answer,
    telemetry,
  } = preparation.value;
  bindProcessingAdmission(spec, ledger, lease.lease!, adapter.id, attemptId, undefined, admission);
  spec.extra["markPhysicalDispatchStarted"] = markStarted;
  const onAbort = () => {
    void adapter.cancel?.(spec.session_id)?.catch(() => {});
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }
  let cost = 0;
  let costEstimated = false;
  let harnessError: string | null = null;
  let processingDenial: BudgetDenial | null = null;
  let declared: DeclaredFailure | undefined;
  let lastLimit: { resetsAt: string | null; constraintId: string | null } | null = null;
  const budgetSignalState = { quotaPressureDisclosed: false };
  try {
    log.emit("harness.started", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      external_context_policy: knobs.webPolicy,
      ...(knobs.ignored.length > 0 ? { ignored_settings: knobs.ignored } : {}),
    });
    if (!input.signal?.aborted) {
      const watchedPlan = withInactivityWatchdog(runModelGovernedRoute(routed, spec), {
        timeoutMs: deps.inactivityTimeoutMs(input.repoRoot),
        countsAsProgress: countsAsAgentProgress,
        onTimeout: () => {
          plannerAbort.abort();
          void adapter.cancel?.(spec.session_id)?.catch(() => {});
        },
        isSuspended: () => (planInteraction?.pendingCount?.() ?? 0) > 0,
        suspensionVersion: () => planInteraction?.suspensionVersion?.() ?? 0,
        stopSignal: input.signal,
      });
      for await (const ev of watchedPlan) {
        // A read after Stop is evidence only: stored, never shown live.
        const stoppedBefore = input.signal?.aborted === true;
        const shown = !stoppedBefore && ev.payload?.["buffered"] !== true;
        if (shown) safeInvoke(input.onHarnessEvent, ev);
        if (args.laneRun && !stoppedBefore) observeNativeSessionEvent(input, adapter.id, ev);
        observeAuthSwitch(log, adapter.id, attemptId, ev);
        // Re-sampled: the callback above may itself have pressed Stop.
        log.emit(
          "harness.event",
          harnessEventPayload(adapter.id, attemptId, ev),
          shown && !input.signal?.aborted,
        );
        appendHarnessEvent(attemptEventsPath, ev);
        // After Stop the watchdog drains the cancelled source within its
        // cleanup bound: what it still reports is recorded, never used.
        // Rechecked after the callback, which can itself press Stop.
        if (input.signal?.aborted) continue;
        observeAttemptTelemetry(telemetry, ev);
        if (ev.rate_limit)
          lastLimit = {
            resetsAt: ev.rate_limit.resets_at ?? null,
            constraintId: ev.rate_limit.constraint_id ?? null,
          };
        // Agent work after the limit means the vendor's retry recovered, and the
        // vendor's own typed non-quota failure ends the try for its own cause:
        // either way that limit no longer explains how the try ends.
        else if (marksAgentProgress(ev) || endsPendingLimit(ev)) lastLimit = null;
        if (ev.plan_progress) {
          log.emit("plan.progress", {
            attempt_id: attemptId,
            harness_id: adapter.id,
            items: ev.plan_progress.items,
          });
        }
        observeBudgetSignals(ledger, log, adapter.id, attemptId, ev, budgetSignalState);
        deps.quotaEventSink?.(adapter.id, ev);
        if (ev.type === "usage" && ev.usage?.cost_usd) {
          cost += ev.usage.cost_usd;
          if (ev.usage.estimated) costEstimated = true;
          log.emit("budget.observation", {
            harness_id: adapter.id,
            attempt_id: attemptId,
            kind: "spend",
            usd: ev.usage.cost_usd,
            estimated: ev.usage.estimated === true,
          });
        }
        const streamDenial = updateProcessingStreamHold(
          spec,
          telemetry.usageCost,
          ledger,
          lease.lease!.lease_id,
          adapter.id,
          attemptId,
        );
        if (streamDenial) {
          processingDenial = streamDenial;
          harnessError = streamDenial.reason;
          plannerAbort.abort();
          void adapter.cancel?.(spec.session_id)?.catch(() => {});
          break;
        }
        answer.observe(ev);
        if (ev.type === "error")
          harnessError = ev.error ? redactSecrets(ev.error) : "harness emitted an error";
      }
    }
  } catch (error) {
    harnessError = safeErrorMessage(error);
    declared = declaredFailure(error);
    if (error instanceof ProcessingBudgetAdmissionError) processingDenial = error.denial;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (!physicalStarted) ledger.cancel(lease.lease!.lease_id);
    else
      settleGrantedAttemptLease({
        ledger,
        leaseId: lease.lease?.lease_id ?? "",
        attemptId,
        harnessId: adapter.id,
        costUsd: cost,
        costEstimated,
        authMode: telemetry.authMode,
        usageCost: telemetry.usageCost,
        preStreamFailureSource: "planner-pre-stream",
      });
  }

  const planUnwrapped = unwrapWorkReportEnvelope(answer.machineText() ?? "", planWorkMode, {
    sideToolReport: telemetry.sideToolWorkReport ?? undefined,
  });
  const planText = planUnwrapped.deliverable;
  const hasPlanText = planText.trim().length > 0;
  const harnessFailedBeforeReport = harnessError !== null;
  const webBlocked = webUnsatisfied(telemetry);
  if (!harnessError && webBlocked) harnessError = webEvidenceFailure(telemetry.web);
  harnessError ??= unrecoveredToolErrorFailure(unrecoveredToolErrors(telemetry), hasPlanText);
  const finalized = finalizeAttempt({
    deliverableEvidence: hasPlanText,
    harnessErrored: harnessError !== null && !webBlocked,
    workReport: planUnwrapped.workReport,
    workReportSource: planUnwrapped.source,
    workReportViolation: planUnwrapped.contractViolation,
    workReportUnverified: planUnwrapped.unverified ?? null,
    contextTerminalExhausted: telemetry.contextExhausted,
  });
  if (!harnessError && finalized.outcomeClass === "contract_failure") {
    harnessError = `work_report contract: ${planUnwrapped.contractViolation}`;
  }
  if (!harnessError && finalized.outcomeClass === "interrupted") {
    harnessError = "context capacity exhausted before the plan completed";
  }
  const attemptError =
    harnessError ??
    (finalized.deliverablePresent ? null : "planner produced no plan text") ??
    (input.signal?.aborted ? "planner cancelled" : null);
  // A typed vendor limit on a strict pin ends the Plan try typed, like Agent and
  // Ask: a pin never rotates, and code, reset and basis reach failure.yaml. Only
  // a limit still unrecovered when the stream itself failed counts. Context
  // exhaustion, an empty plan, a work_report contract failure, a later typed
  // request refusal or non-quota API failure, or a thrown terminal keeps its
  // own cause, and cancellation stays cancellation.
  const pinnedId = input.credentialProfileId;
  if (
    harnessFailedBeforeReport &&
    !telemetry.contextExhausted &&
    lastLimit &&
    pinnedId != null &&
    !webBlocked &&
    !processingDenial &&
    !telemetry.requestRefusal &&
    !input.signal?.aborted &&
    declared === undefined
  )
    declared = declaredFailure(
      pinnedTypedLimit(
        spec.credential_profile?.profile_id ?? pinnedId,
        adapter.id,
        lastLimit,
        telemetry.outputMarkers.sawAgentProgress,
      ),
    );
  setAttemptOutcome(telemetry, {
    deliverablePresent: finalized.deliverablePresent,
    gatesPassed: null,
    harnessErrored: (harnessError !== null && !webBlocked) || finalized.harnessErrored,
    webRequiredUnsatisfied: webBlocked,
    workState: finalized.workState,
  });
  if (attemptError) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: webBlocked ? "blocked" : "failed",
      error: attemptError,
      ...telemetrySummary(telemetry),
    });
    return {
      attemptId,
      harnessId: adapter.id,
      status: webBlocked ? "blocked" : "failed",
      outcomeClass: finalized.outcomeClass,
      error: attemptError,
      harnessFailedBeforeReport,
      reportProblem: planUnwrapped.reportProblem,
      text: hasPlanText ? planText : null,
      telemetry,
      budgetDenied: processingDenial !== null,
      ...(processingDenial ? { budgetDenial: processingDenial } : {}),
      ...(declared?.category || declared?.code ? { declaredFailure: declared } : {}),
    };
  }
  const text = planText || "(no output)";
  log.emit("harness.completed", {
    harness_id: adapter.id,
    attempt_id: attemptId,
    status: "success",
    ...telemetrySummary(telemetry),
  });
  return {
    attemptId,
    harnessId: adapter.id,
    status: "success",
    outcomeClass: finalized.outcomeClass,
    error: null,
    harnessFailedBeforeReport,
    reportProblem: planUnwrapped.reportProblem,
    text,
    telemetry,
    budgetDenied: false,
  };
}
