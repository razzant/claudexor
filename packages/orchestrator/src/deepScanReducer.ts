import { join } from "node:path";
import type {
  CostEvidence,
  DeepScanSynthesis,
  ExternalContextPolicy,
  HarnessEvent,
  HarnessRunSpec,
} from "@claudexor/schema";
import { attemptUsageCostSettlement, type BudgetLedger } from "@claudexor/budget";
import { AnswerAssembly, withInactivityWatchdog } from "@claudexor/core";
import { appendLine, redactSecrets, safeInvoke } from "@claudexor/util";
import type { RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { buildDeepScanReducerPrompt } from "@claudexor/synthesis";
import { type BudgetDenial, classifyBudgetFailure } from "./budgetFailure.js";
import type { RoutedAdapter } from "./orchestrator.js";
import {
  finalizeAttempt,
  unwrapWorkReportEnvelope,
  type WorkReportEnvelopeMode,
} from "./attemptFinalize.js";
import { redactHarnessEvent, harnessEventPayload, observeBudgetSignals } from "./runSupport.js";
import {
  type AttemptTelemetry,
  createAttemptTelemetry,
  observeAttemptTelemetry,
  setAttemptOutcome,
  telemetrySummary,
  toolWarnings,
} from "./attemptTelemetry.js";

/** Redacted error message (mirrors the orchestrator's module-local helper). */
function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/** The reducer runs under the fixed `synth` attempt id (roster/cost visible). */
export const DEEP_SCAN_REDUCER_ATTEMPT_ID = "synth";

/**
 * #27 / D-6: the HONEST fallback artifact for a deep scan whose bounded
 * synthesis reducer did not run or did not succeed. It is explicitly labeled a
 * raw scout bundle (a marker heading), never presented as a merged synthesis:
 * the per-scout reports are concatenated verbatim with attribution, the roster
 * denominator stays honest, and omissions are preserved. `skipped` (a single
 * width-1 report) and `failed` (reducer error/timeout/budget-denial or no
 * synthesize-capable route) get distinct honest intros.
 */
export function rawScoutBundle(args: {
  succeeded: {
    attemptId: string;
    harnessId: string;
    report: string;
    telemetry: AttemptTelemetry;
  }[];
  unsuccessful: { attemptId: string; harnessId: string; status: string; error: string | null }[];
  status: DeepScanSynthesis | null;
}): string {
  const total = args.succeeded.length + args.unsuccessful.length;
  const intro =
    args.status?.status === "skipped"
      ? [
          "## Raw scout report (single scout — no merge needed)",
          "",
          "Only one scout produced a report, so no synthesis reducer was run.",
        ]
      : [
          "## Raw scout bundle — NOT a merged synthesis",
          "",
          `The bounded synthesis reducer did not produce a merge (${args.status?.reason ?? "synthesis unavailable"}). The scout reports below are raw and unmerged; claims are not deduplicated and disagreements are not reconciled.`,
        ];
  return [
    ...intro,
    "",
    `Explorers succeeded: ${args.succeeded.length}/${total}.`,
    "",
    "## Scout reports (raw, not merged)",
    ...args.succeeded.map((a) => {
      const warnings = toolWarnings(a.telemetry);
      const warningText = warnings.length
        ? `\n\n> Tool warnings: ${warnings.map((e) => `${e.tool}: ${e.summary}`).join("; ")}`
        : "";
      return `\n### ${a.attemptId} / ${a.harnessId}\n\n${a.report}${warningText}`;
    }),
    "",
    "## Omissions / Uncertainty",
    ...(args.unsuccessful.length
      ? args.unsuccessful.map((a) => `- ${a.attemptId} / ${a.harnessId} ${a.status}: ${a.error}`)
      : [
          "- No explorer failures recorded. Claims still need evidence review before edit execution.",
        ]),
  ].join("\n");
}

/** A disposable read-only route context (env + reclaim). */
export interface ReducerHome {
  env: Record<string, string>;
  dispose: () => void;
}

/** The engine-owned bits the reducer needs. `buildSpec` keeps the orchestrator's
 * private route/session/knob machinery on the caller side and hands back only a
 * finished, public `HarnessRunSpec` plus the disclosed web policy/model, so this
 * module stays free of those private types (mirrors the council extraction). */
export interface DeepScanReducerDeps {
  /** Provision a fresh disposable read-only home (auth is home-independent). */
  newReadOnlyHome: () => ReducerHome;
  /** Per-attempt budget cost evidence (finite estimate floor + billing knowledge). */
  costEvidence: (harnessId: string, attemptId: string) => CostEvidence;
  /** Build the finished readonly/synthesize spec bound to the reducer home. */
  buildSpec: (
    routed: RoutedAdapter,
    homeEnv: Record<string, string>,
    prompt: string,
    attemptId: string,
  ) => {
    spec: HarnessRunSpec;
    webPolicy: ExternalContextPolicy;
    effectiveWeb: ExternalContextPolicy;
    model: string | null;
    /** D-16: the WorkReport transport mode compiled onto the reducer spec, so the
     * reducer output is unwrapped + finalized through the SAME contract as every
     * other attempt (never a fourth divergent deliverable predicate). Inactive on
     * a route with no work_report transport (the report passes through untouched). */
    workReportMode: WorkReportEnvelopeMode;
  };
  /** Hard (total) timeout for the single bounded pass. */
  hardTimeoutMs: number;
  /** Inactivity watchdog timeout (shared with the scout lane). */
  inactivityTimeoutMs: number;
  /** Whether the run's contract requires web evidence (telemetry seed). */
  webRequired: boolean;
  /** Optional quota event sink (same owner as the agent loop). */
  quotaEventSink?: (harnessId: string, ev: HarnessEvent) => void;
}

export interface DeepScanReducerArgs {
  taskId: string;
  goal: string;
  routed: RoutedAdapter;
  scoutReports: { attemptId: string; harnessId: string; absPath: string }[];
  ledger: BudgetLedger;
  log: EventLog;
  paths: RunPaths;
  signal?: AbortSignal;
  onHarnessEvent?: (ev: HarnessEvent) => void;
  attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
}

export type DeepScanReducerResult =
  | { status: "success"; report: string }
  | { status: "failed"; error: string }
  | { status: "budget_denied"; denial: BudgetDenial }
  // INV-116: the OUTER run signal aborted mid-reducer. A cancellation is NOT a
  // failed synthesis — no error is manufactured and any partial output is
  // discarded; the caller degrades honestly and the run terminalizes cancelled.
  | { status: "cancelled" };

/**
 * #27 / D-6: the deep-scan bounded synthesis reducer. After the scouts finish,
 * ONE synthesize-intent attempt merges the raw scout reports into a real
 * synthesis. It is READ-ONLY and file-backed (the scout report files are pointed
 * at by absolute path — the argv-size law: reports ride a file, never argv),
 * reserves a budget lease like any attempt, and is bounded by a hard timeout. Its
 * telemetry is pushed to the run roster (cost/route visible). On
 * failure/timeout/budget-denial the caller degrades to an HONEST raw bundle; this
 * function never fabricates a synthesis.
 */
export async function runDeepScanReducer(
  deps: DeepScanReducerDeps,
  args: DeepScanReducerArgs,
): Promise<DeepScanReducerResult> {
  const { ledger, log, paths } = args;
  const attemptId = DEEP_SCAN_REDUCER_ATTEMPT_ID;
  const adapter = args.routed.adapter;
  log.emit("synthesis.started", {
    synthesize: true,
    reason: `deep-scan reducer over ${args.scoutReports.length} scout reports`,
  });
  const lease = ledger.reserve({
    taskId: args.taskId,
    attemptId,
    intent: "synthesize",
    harnessId: adapter.id,
    cost: deps.costEvidence(adapter.id, attemptId),
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
      status: "budget_denied",
      denial: {
        code: lease.denied ?? "hard_cap",
        reason: lease.reason ?? "budget lease denied",
        harnessId: adapter.id,
        attemptId,
      },
    };
  }
  // A fresh disposable read-only home: the scouts' shared route context was
  // already disposed, and auth truth is home-independent (credentials come from
  // the profile/keychain/default store), so a fresh home shares the auth source.
  const reducerHome = deps.newReadOnlyHome();
  const prompt = buildDeepScanReducerPrompt(args.goal, args.scoutReports);
  const built = deps.buildSpec(args.routed, reducerHome.env, prompt, attemptId);
  const spec = built.spec;
  // Hard (total) timeout — one attempt, no failover/transient retry loop.
  const reducerAbort = new AbortController();
  let timedOut = false;
  const hardTimer = setTimeout(() => {
    timedOut = true;
    reducerAbort.abort();
    void adapter.cancel?.(spec.session_id)?.catch(() => {});
  }, deps.hardTimeoutMs);
  spec.extra["abortSignal"] = args.signal
    ? AbortSignal.any([args.signal, reducerAbort.signal])
    : reducerAbort.signal;
  const telemetry = createAttemptTelemetry(
    built.webPolicy,
    deps.webRequired || built.webPolicy === "cached" || built.webPolicy === "live",
    built.effectiveWeb,
    [],
    built.model,
  );
  const answer = new AnswerAssembly();
  const attemptEventsPath = join(paths.attemptsDir, attemptId, "events.jsonl");
  const budgetSignalState = { quotaPressureDisclosed: false };
  let cost = 0;
  let costEstimated = false;
  let harnessError: string | null = null;
  log.emit("harness.started", {
    harness_id: adapter.id,
    attempt_id: attemptId,
    external_context_policy: built.webPolicy,
  });
  try {
    const watched = withInactivityWatchdog(adapter.run(spec), {
      timeoutMs: deps.inactivityTimeoutMs,
      onTimeout: () => {
        reducerAbort.abort();
        void adapter.cancel?.(spec.session_id)?.catch(() => {});
      },
      isSuspended: () => false,
    });
    for await (const ev of watched) {
      if (reducerAbort.signal.aborted) break;
      const safeEv = redactHarnessEvent(ev);
      safeInvoke(args.onHarnessEvent, safeEv);
      log.emit("harness.event", harnessEventPayload(adapter.id, attemptId, safeEv));
      appendLine(attemptEventsPath, JSON.stringify(safeEv));
      observeAttemptTelemetry(telemetry, safeEv);
      observeBudgetSignals(ledger, log, adapter.id, attemptId, safeEv, budgetSignalState);
      deps.quotaEventSink?.(adapter.id, safeEv);
      if (safeEv.type === "usage" && safeEv.usage?.cost_usd) {
        cost += safeEv.usage.cost_usd;
        if (safeEv.usage.estimated) costEstimated = true;
        log.emit("budget.observation", {
          harness_id: adapter.id,
          attempt_id: attemptId,
          kind: "spend",
          usd: safeEv.usage.cost_usd,
          estimated: safeEv.usage.estimated === true,
        });
      }
      answer.observe(safeEv);
      if (safeEv.type === "error")
        harnessError = safeEv.error ? redactSecrets(safeEv.error) : "harness emitted an error";
    }
  } catch (err) {
    harnessError = safeErrorMessage(err);
  } finally {
    clearTimeout(hardTimer);
    reducerHome.dispose();
    ledger.settle(
      lease.lease?.lease_id ?? "",
      attemptUsageCostSettlement(
        cost,
        costEstimated,
        attemptId,
        adapter.id,
        telemetry.authMode,
        telemetry.usageCost,
      ),
    );
  }
  // D-16: unwrap the WorkReport envelope and finalize through the SAME contract as
  // every other attempt — a capable reducer route that broke its WorkReport
  // contract (or reported needs_input/incomplete/context-exhausted) must NEVER be
  // accepted as a clean synthesis; the caller then degrades to an honest raw
  // bundle. On an inactive-transport route the unwrap passes the report through
  // untouched (unchanged behavior for schema-free reducer harnesses).
  const unwrapped = unwrapWorkReportEnvelope(answer.machineText() ?? "", built.workReportMode, {
    sideToolReport: telemetry.sideToolWorkReport ?? undefined,
  });
  const report = redactSecrets(unwrapped.deliverable);
  const finalized = finalizeAttempt({
    deliverableEvidence: report.trim().length > 0,
    harnessErrored: harnessError !== null,
    workReport: unwrapped.workReport,
    workReportSource: unwrapped.source,
    workReportViolation: unwrapped.contractViolation,
    contextTerminalExhausted: telemetry.contextExhausted,
  });
  if (timedOut && !harnessError)
    harnessError = `deep-scan reducer timed out after ${deps.hardTimeoutMs}ms`;
  // A reducer must produce a CLEAN merged synthesis: a broken WorkReport contract,
  // a needs_input/incomplete attestation, or a terminal context exhaustion is a
  // typed reducer failure (degrade to the raw bundle), never a laundered success.
  if (!harnessError && finalized.outcomeClass === "contract_failure") {
    harnessError = `deep-scan reducer work_report contract: ${unwrapped.contractViolation}`;
  } else if (!harnessError && finalized.outcomeClass === "veto") {
    harnessError = `deep-scan reducer reported ${finalized.workState.state} instead of a merged synthesis`;
  } else if (!harnessError && finalized.outcomeClass === "interrupted") {
    harnessError = "deep-scan reducer ran out of context before completing the synthesis";
  }
  const reportPresent = finalized.deliverablePresent && report.trim().length > 0;
  if (!harnessError && !reportPresent) harnessError = "deep-scan reducer produced no synthesis";
  // INV-116: a cancel on the OUTER run signal that landed WHILE this bounded
  // reducer streamed is a cancellation — not a clean synthesis and not a typed
  // failure. Any partial output is discarded (deliverablePresent forced false)
  // so it can never be accepted as a merge, and the run terminalizes cancelled.
  const runCancelled = args.signal?.aborted === true;
  setAttemptOutcome(telemetry, {
    deliverablePresent: reportPresent && !runCancelled,
    gatesPassed: null,
    harnessErrored: harnessError !== null || runCancelled,
    webRequiredUnsatisfied: false,
    workState: finalized.workState,
  });
  // Roster/cost visible: the reducer is a normal attempt in run telemetry.
  args.attemptTelemetries.push({ attemptId, harnessId: adapter.id, telemetry });
  if (runCancelled) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: "cancelled",
      ...telemetrySummary(telemetry),
    });
    return { status: "cancelled" };
  }
  if (harnessError) {
    log.emit("harness.completed", {
      harness_id: adapter.id,
      attempt_id: attemptId,
      status: "failed",
      error: harnessError,
      ...telemetrySummary(telemetry),
    });
    return { status: "failed", error: harnessError };
  }
  log.emit("harness.completed", {
    harness_id: adapter.id,
    attempt_id: attemptId,
    status: "success",
    ...telemetrySummary(telemetry),
  });
  return { status: "success", report };
}

/**
 * #27 / D-6: decide the deep-scan synthesis outcome and, when warranted, run the
 * bounded reducer. Returns the typed `DeepScanSynthesis` telemetry status plus
 * the merged report (non-null only on a clean reducer success; the caller writes
 * an honest raw bundle otherwise). A width-1 (single-report) scan skips the
 * reducer; a budget-stopped/cancelled scan degrades without spending on a merge;
 * a scan with no synthesize-capable route degrades honestly.
 */
export async function resolveDeepScanSynthesis(
  deps: DeepScanReducerDeps,
  args: {
    succeeded: {
      attemptId: string;
      harnessId: string;
      report: string;
      telemetry: AttemptTelemetry;
    }[];
    adapters: RoutedAdapter[];
    budgetStopped: boolean;
    aborted: boolean;
    taskId: string;
    goal: string;
    findingsDir: string;
    ledger: BudgetLedger;
    log: EventLog;
    paths: RunPaths;
    signal?: AbortSignal;
    onHarnessEvent?: (ev: HarnessEvent) => void;
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
  },
): Promise<{ deepScanSynthesis: DeepScanSynthesis; reducedReport: string | null }> {
  if (args.succeeded.length < 2) {
    return {
      deepScanSynthesis: {
        status: "skipped",
        reducer_attempt_id: null,
        reason: "single scout report needs no merge",
      },
      reducedReport: null,
    };
  }
  if (args.budgetStopped || args.aborted) {
    return {
      deepScanSynthesis: {
        status: "failed",
        reducer_attempt_id: null,
        reason: args.aborted
          ? "run cancelled before synthesis"
          : "budget exhausted before synthesis",
      },
      reducedReport: null,
    };
  }
  // Eligible route: a successful scout whose harness manifest supports the
  // synthesize intent. Deep-scan repeats a surviving harness, so any routed slot
  // for that harness id is a valid reducer route.
  const eligible = args.succeeded
    .map((s) => args.adapters.find((a) => a.adapter.id === s.harnessId && a.supportsSynthesize))
    .find((a): a is RoutedAdapter => Boolean(a));
  if (!eligible) {
    return {
      deepScanSynthesis: {
        status: "failed",
        reducer_attempt_id: null,
        reason: "no synthesize-capable route among the scout harnesses",
      },
      reducedReport: null,
    };
  }
  const reduced = await runDeepScanReducer(deps, {
    taskId: args.taskId,
    goal: args.goal,
    routed: eligible,
    scoutReports: args.succeeded.map((s) => ({
      attemptId: s.attemptId,
      harnessId: s.harnessId,
      absPath: join(args.findingsDir, `${s.attemptId}.md`),
    })),
    ledger: args.ledger,
    log: args.log,
    paths: args.paths,
    signal: args.signal,
    onHarnessEvent: args.onHarnessEvent,
    attemptTelemetries: args.attemptTelemetries,
  });
  if (reduced.status === "success") {
    return {
      deepScanSynthesis: {
        status: "succeeded",
        reducer_attempt_id: DEEP_SCAN_REDUCER_ATTEMPT_ID,
        reason: null,
      },
      reducedReport: reduced.report,
    };
  }
  // INV-116: a mid-reducer cancellation degrades with NO merged report (the
  // partial output is discarded). The schema status has no `cancelled` member,
  // so it is disclosed as a failed synthesis whose reason names the cancel; the
  // run's own terminal is routed to `cancelled` by the caller's re-check.
  if (reduced.status === "cancelled") {
    return {
      deepScanSynthesis: {
        status: "failed",
        reducer_attempt_id: DEEP_SCAN_REDUCER_ATTEMPT_ID,
        reason: "run cancelled during synthesis",
      },
      reducedReport: null,
    };
  }
  const reason =
    reduced.status === "budget_denied"
      ? `reducer budget-denied: ${classifyBudgetFailure({ denial: reduced.denial, terminal: args.ledger.terminal() }).safeMessage}`
      : reduced.error;
  return {
    deepScanSynthesis: {
      status: "failed",
      reducer_attempt_id: DEEP_SCAN_REDUCER_ATTEMPT_ID,
      reason,
    },
    reducedReport: null,
  };
}
