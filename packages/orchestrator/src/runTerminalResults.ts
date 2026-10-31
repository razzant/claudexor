import { ProcessingBudgetAdmissionError } from "./processing-dispatch.js";
import { classifyBudgetFailure } from "./budgetFailure.js";
import { join } from "node:path";
import { cancelReasonFromSignalToken } from "./runTerminals.js";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import {
  RunFailure,
  RunFailureCode,
  type ModeKind,
  type RunOutcomeFacts,
  type RunReason,
  type RunResumable,
  type VendorFailureEvidence,
  type PoolAttemptFailure,
  HarnessRequestRefusal,
  QuotaRefusal,
  RawContextShortfall,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { poolFailure, redactVendorFailure } from "./pool-attempt-evidence.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { resumableTerminal, type ContinuityTerminalFacts } from "./continuity-terminal.js";
import { terminalOutcomeFacts } from "./terminalOutcome.js";
import { captureInventorySummary } from "./captureRefusal.js";

export function writeFailure(
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  failure: {
    phase: string;
    category: string;
    /** Machine-readable sub-code (typed budget-denial reason); null/omitted when
     * the category alone is sufficient. Consumed by surfaces to pick remediation
     * without parsing safeMessage (QA-050). */
    code?: RunFailureCode | null;
    safeMessage: string;
    harnessId?: string | null;
    attemptId?: string | null;
    rawDetailRef?: string;
    logRefs?: string[];
    eventRefs?: string[];
    runDir?: string;
    /** Structural reopen time for a windowed refusal (spent subscription
     * quota); null/omitted when the failure has no such time. */
    resetsAt?: string | null;
    /** The vendor's own typed failure for the attempt this record speaks for;
     * null/omitted when no vendor-typed evidence exists. Opaque evidence. */
    vendorFailure?: VendorFailureEvidence | null;
    requestRefusal?: HarnessRequestRefusal;
    /** Typed sizes behind `raw_context_exceeds_window` (#147). */
    rawContextShortfall?: RawContextShortfall;
    captureFailure?: RunFailure["captureFailure"];
    /** Every failed try with its own account, in order (empty = none). */
    poolAttempts?: readonly PoolAttemptFailure[];
    /** Typed basis of a quota-admission refusal (#318); omitted otherwise. */
    quotaRefusal?: QuotaRefusal;
    nextActions?: string[];
  },
): void {
  const vendor = failure.vendorFailure ?? null;
  const outdated =
    failure.requestRefusal?.kind === "vendor_cli_too_old" ? failure.requestRefusal : null;
  const installation = [
    outdated?.binary_path,
    outdated?.installed_version && `(reported version ${outdated.installed_version})`,
  ]
    .filter(Boolean)
    .join(" ");
  store.writeYaml(join(paths.finalDir, "failure.yaml"), {
    phase: failure.phase,
    category: failure.category,
    code: failure.code ?? null,
    harnessId: failure.harnessId ?? null,
    attemptId: failure.attemptId ?? null,
    safeMessage: redactSecrets(failure.safeMessage),
    rawDetailRef: failure.rawDetailRef ?? null,
    logRefs: failure.logRefs ?? [],
    eventRefs: failure.eventRefs ?? [],
    runDir: failure.runDir ?? paths.root,
    resetsAt: failure.resetsAt ?? null,
    ...(failure.requestRefusal ? { requestRefusal: failure.requestRefusal } : {}),
    ...(failure.rawContextShortfall ? { rawContextShortfall: failure.rawContextShortfall } : {}),
    ...(failure.captureFailure ? { captureFailure: failure.captureFailure } : {}),
    ...(failure.quotaRefusal ? { quotaRefusal: failure.quotaRefusal } : {}),
    // Vendor failure text is a diagnostic derivative: masked like safeMessage (INV-146).
    vendorFailure: vendor && redactVendorFailure(vendor),
    poolAttempts: (failure.poolAttempts ?? []).map((row) => ({
      ...row,
      profileDisplayName: row.profileDisplayName && redactSecrets(row.profileDisplayName),
      error: redactSecrets(row.error),
      vendorFailure: row.vendorFailure && redactVendorFailure(row.vendorFailure),
    })),
    nextActions: [
      ...new Set([
        ...(failure.quotaRefusal?.basis === "owner_reserve"
          ? [
              "The account reached your saved quota reserve (headroom_threshold), not a provider limit; wait for the reset, choose another account, or change the reserve in Settings",
            ]
          : []),
        ...(failure.code === "input_too_large"
          ? [
              "Fit the input to the reported transport limit or supply source references",
              "Choose another compatible harness if the complete input must remain inline",
            ]
          : failure.code === "vendor_cli_too_old"
            ? [
                `Update the Claude Code CLI${installation ? ` at ${installation}` : ""}`,
                "Use the update method for that installation, then retry the requested model",
                "Open diagnostics",
              ]
            : failure.code === "credential_source_unconfirmed"
              ? [
                  "Check the vendor's own configuration for a per-model API key or managed policy that replaces session login; Claudexor does not read or change it",
                  "Retry once the vendor reports session login, or choose another model or account",
                ]
              : failure.code === "raw_context_exceeds_window"
                ? [
                    "Choose a model with a larger context window",
                    "Reduce context.mandatory_files in the project's .claudexor/config.yaml",
                    "Or use a harness that reads project files itself",
                  ]
                : (failure.nextActions ?? [])),
        ...(failure.captureFailure ? (failure.nextActions ?? []) : []),
      ]),
    ],
  });
}

/** The typed provenance an error declared about its own terminal. */
export interface DeclaredFailure {
  requestRefusal?: HarnessRequestRefusal;
  quotaRefusal?: QuotaRefusal;
  rawContextShortfall?: RawContextShortfall;
  category?: RunFailure["category"];
  code: RunFailureCode | null;
  resetsAt: string | null;
}

export function requestRefusalFailure(requestRefusal: HarnessRequestRefusal): DeclaredFailure {
  return {
    // Only an oversized input is the request's own fault; the other causes are
    // the installed vendor CLI or its configuration.
    category: requestRefusal.kind === "input_too_large" ? "validation" : "harness_unavailable",
    code: requestRefusal.kind,
    resetsAt: null,
    requestRefusal,
  };
}

/**
 * The typed provenance an ERROR carries about its own terminal.
 *
 * A refusal that knows exactly what it is (a spent quota window, and when it
 * reopens) must not be flattened into `internal` / `code: null` just because it
 * travelled as an exception: the terminal then states less than the thrower
 * knew, and the only remaining signal is prose. `failTerminally` already read
 * `code` this way; category and reset time follow the same rule. Everything is
 * validated against the schema, so an unrelated error carrying a `category`
 * property of its own cannot smuggle in a bogus classification.
 *
 * A candidate attempt that dies on such an error records this on its
 * `CandidateRun`, so the refusal survives the per-slot catch that otherwise
 * reduces it to a message string.
 */
export function declaredFailure(err: unknown): DeclaredFailure {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const code = RunFailureCode.safeParse(record["code"]);
  const category = RunFailure.shape.category.safeParse(record["category"]);
  const resetsAt = RunFailure.shape.resetsAt.safeParse(record["resetsAt"]);
  const refusal = HarnessRequestRefusal.safeParse(record["requestRefusal"]);
  const quota = QuotaRefusal.safeParse(record["quotaRefusal"]);
  const shortfall = RawContextShortfall.safeParse(record["rawContextShortfall"]);
  return {
    ...(typeof record["category"] === "string" && category.success
      ? { category: category.data }
      : {}),
    code: code.success ? code.data : null,
    resetsAt: resetsAt.success ? resetsAt.data : null,
    ...(refusal.success ? { requestRefusal: refusal.data } : {}),
    ...(quota.success ? { quotaRefusal: quota.data } : {}),
    ...(shortfall.success ? { rawContextShortfall: shortfall.data } : {}),
  };
}

/**
 * The one statement of a cancellation, shared by every cancelled terminal: the
 * cancel first (a STRING abort reason, e.g. the maxSeconds deadline, is named),
 * then the run's earlier failed tries; `markdown` is its summary.md.
 */
export function cancellationStatement(
  runId: string,
  mode: ModeKind,
  cancelSignal: AbortSignal | undefined,
  attempts: readonly ContinuityTerminalFacts[],
): {
  cancelReason?: string;
  summary: string;
  markdown: string;
  poolAttempts: PoolAttemptFailure[];
} {
  const cancelReason =
    typeof cancelSignal?.reason === "string" && cancelSignal.reason
      ? cancelSignal.reason
      : undefined;
  const { message, poolAttempts } = poolFailure(
    cancelReason === "wall_clock_exceeded"
      ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
      : "run cancelled",
    attempts,
  );
  return {
    ...(cancelReason ? { cancelReason } : {}),
    summary: message,
    markdown: `# Run ${runId} (${mode})\n\n- Lifecycle: cancelled\n${cancelReason ? `- Reason: ${cancelReason}\n` : ""}\n${message}\n`,
    poolAttempts,
  };
}

/**
 * Terminal result for a cancelled run: emits run.failed with status
 * "cancelled" so every mode ends consistently. `writeTelemetry` carries the
 * PARTIAL attempt telemetry collected before the abort — a cancelled run
 * must still account for what it spent and observed; it used to be
 * written only by convergence.
 */
export function cancelledResult(
  log: EventLog,
  runId: string,
  taskId: string,
  mode: ModeKind,
  runDir: string,
  candidates: { attemptId: string; harnessId: string; status: string }[],
  writeTelemetry?: () => void,
  spendUsd?: number | null,
  /** The abort signal that ended the run: a STRING reason (e.g.
   * `wall_clock_exceeded` from the maxSeconds deadline) is surfaced; a plain
   * user cancel aborts with a DOMException reason and stays a bare cancel. */
  cancelSignal?: AbortSignal,
  /** Materializes the diagnostic summary the output.ready below announces. */
  store?: ArtifactStore,
  /** A prepared result may already carry independent checks/review/work facts
   * when cancellation wins during the Delegate terminal barrier. */
  priorFacts?: RunOutcomeFacts,
  /** The attempt's continuation facts (cause wall_clock/cancelled, carriers), when any. */
  resumable?: RunResumable | null,
  /** The run's attempts: their earlier failed tries stay diagnostic history
   * beside the cancellation (a cancelled try has no row; no failure record). */
  attempts?: readonly ContinuityTerminalFacts[],
): OrchestratorResult {
  if (writeTelemetry) {
    try {
      writeTelemetry();
    } catch {
      /* partial telemetry is best-effort on the cancel path */
    }
  }
  const {
    cancelReason,
    summary: summaryText,
    markdown,
    poolAttempts,
  } = cancellationStatement(runId, mode, cancelSignal, attempts ?? []);
  // Materialize the diagnostic summary BEFORE announcing it — output.ready must
  // point at a file that exists (partial-output honesty), and it must precede
  // the terminal in every mode (INV-116).
  let summaryWritten = false;
  if (store) {
    try {
      store.writeText(join(runDir, "final", "summary.md"), markdown);
      summaryWritten = true;
    } catch {
      /* best-effort: a write failure must not mask the cancel terminal */
    }
  }
  // output.ready is EVIDENCE (release wave sol #3): announce the summary only
  // when the file actually materialized — a failed write still gets its
  // terminal below, just without a pointer to a nonexistent artifact.
  if (summaryWritten) {
    log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  }
  const cancelFacts = terminalOutcomeFacts(
    priorFacts,
    "cancelled",
    cancelReasonFromSignalToken(cancelReason),
  );
  if (resumable && store) store.writeYaml(join(runDir, "final", "resumable.yaml"), resumable);
  log.emit("run.failed", {
    lifecycle: "cancelled",
    facts: cancelFacts,
    reason: cancelFacts.reason,
    ...(cancelReason ? { cancel_reason: cancelReason } : {}),
    ...(attempts ? { pool_attempts: poolAttempts } : {}),
    ...(resumable ? { resumable } : {}),
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: "cancelled",
    facts: cancelFacts,
    winner: null,
    runDir,
    summary: summaryText,
    candidates,
    ...(spendUsd !== undefined ? { spendUsd } : {}),
    ...(cancelReason ? { cancelReason } : {}),
  };
}

/**
 * Shared post-announce failure terminal. Unexpected throws use its internal
 * defaults; known callers may supply narrow typed provenance. Every run ends
 * with failure.yaml + summary + a terminal run.failed event.
 */
export function failTerminally(
  log: EventLog,
  store: ArtifactStore,
  paths: ReturnType<ArtifactStore["runPaths"]>,
  runId: string,
  taskId: string,
  mode: ModeKind,
  phase: string,
  err: unknown,
  spendUsd?: number | null,
  failureMeta: {
    category?: "harness_error" | "internal" | "project";
    captureFailure?: RunFailure["captureFailure"];
    harnessId?: string;
    attemptId?: string;
    rawDetailRef?: string;
    nextActions?: string[];
    /** Actions that follow this terminal's own remedy (an earlier record's capture actions). */
    followUps?: readonly string[];
    priorFacts?: RunOutcomeFacts;
    /** The leading cause's own reason when the phase does not name it (capture refusal). */
    reason?: RunReason;
    continuity?: readonly ContinuityTerminalFacts[];
    /** Every attempt whose failed tries this terminal names (default: `continuity`). */
    attempts?: readonly ContinuityTerminalFacts[];
  } = {},
): OrchestratorResult {
  const budget =
    err instanceof ProcessingBudgetAdmissionError
      ? classifyBudgetFailure({ denial: err.denial, terminal: null })
      : null;
  if (budget) phase = budget.phase;
  const { message, poolAttempts } = poolFailure(
    budget?.safeMessage ?? redactSecrets(err instanceof Error ? err.message : String(err)),
    failureMeta.attempts ?? failureMeta.continuity ?? [],
  );
  const declared = declaredFailure(err);
  const failFacts = terminalOutcomeFacts(
    failureMeta.priorFacts,
    "failed",
    budget?.reason ??
      failureMeta.reason ??
      (phase === "workspace" ? "workspace_unavailable" : "harness_failed"),
  );
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: failed${failFacts.reason ? ` (${failFacts.reason})` : ""}\n- Phase: ${phase}\n\n${message}\n${captureInventorySummary(failureMeta.captureFailure)}`,
  );
  writeFailure(store, paths, {
    phase,
    category: budget?.category ?? declared.category ?? failureMeta.category ?? "internal",
    code: declared.code,
    harnessId: budget?.harnessId ?? failureMeta.harnessId,
    attemptId: budget?.attemptId ?? failureMeta.attemptId,
    safeMessage: message,
    rawDetailRef: failureMeta.rawDetailRef,
    captureFailure: failureMeta.captureFailure,
    runDir: paths.root,
    resetsAt: declared.resetsAt,
    requestRefusal: declared.requestRefusal,
    quotaRefusal: declared.quotaRefusal,
    rawContextShortfall: declared.rawContextShortfall,
    poolAttempts,
    nextActions: [
      ...(budget?.nextActions ?? failureMeta.nextActions ?? ["Open diagnostics", "Retry the run"]),
      ...(failureMeta.followUps ?? []),
    ],
  });
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: "failed",
    facts: failFacts,
    reason: failFacts.reason,
    phase,
    error: message,
    pool_attempts: poolAttempts,
    failure_ref: "final/failure.yaml",
    ...resumableTerminal(store, paths, failureMeta.continuity ?? [], true),
  });
  return {
    runId,
    taskId,
    mode,
    lifecycle: "failed",
    facts: failFacts,
    winner: null,
    runDir: paths.root,
    summary: message,
    candidates: [],
    ...(spendUsd !== undefined ? { spendUsd } : {}),
  };
}
