/**
 * Terminal-state machinery shared by every strategy: typed failure artifacts,
 * the cancelled terminal, and the announced-run safety net. Every run that
 * was ANNOUNCED (run.created after createRun) must end with a terminal event
 * — run.completed, run.blocked, or run.failed — plus failure.yaml/summary
 * artifacts on the failure paths. An escaped throw used to orphan the run
 * dir, leaving events.jsonl without a terminal and SSE tailers waiting
 * forever.
 */
import { join } from "node:path";
import type { ModeKind, RunFailureCode } from "@claudexor/schema";
import { makeOutcomeFacts } from "@claudexor/schema";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import { redactSecrets } from "@claudexor/util";
import type { OrchestratorResult } from "./orchestrator.js";

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
}

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
    nextActions?: string[];
  },
): void {
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
    nextActions: failure.nextActions ?? [],
  });
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
): OrchestratorResult {
  if (writeTelemetry) {
    try {
      writeTelemetry();
    } catch {
      /* partial telemetry is best-effort on the cancel path */
    }
  }
  const cancelReason =
    typeof cancelSignal?.reason === "string" && cancelSignal.reason
      ? cancelSignal.reason
      : undefined;
  const summaryText =
    cancelReason === "wall_clock_exceeded"
      ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
      : "run cancelled";
  // Materialize the diagnostic summary BEFORE announcing it — output.ready must
  // point at a file that exists (partial-output honesty), and it must precede
  // the terminal in every mode (INV-116).
  let summaryWritten = false;
  if (store) {
    try {
      store.writeText(
        join(runDir, "final", "summary.md"),
        `# Run ${runId} (${mode})\n\n- Lifecycle: cancelled\n${cancelReason ? `- Reason: ${cancelReason}\n` : ""}\n${summaryText}\n`,
      );
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
  const cancelFacts = makeOutcomeFacts("cancelled", {
    reason: cancelReason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
  });
  log.emit("run.failed", {
    lifecycle: "cancelled",
    facts: cancelFacts,
    reason: cancelFacts.reason,
    ...(cancelReason ? { cancel_reason: cancelReason } : {}),
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
 * Terminal safety net for an unexpected throw in a post-announce phase.
 * Every run must end with failure.yaml + summary + a terminal run.failed
 * event.
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
): OrchestratorResult {
  const message = redactSecrets(err instanceof Error ? err.message : String(err));
  const failFacts = makeOutcomeFacts("failed", { reason: "harness_failed" });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Lifecycle: failed\n- Phase: ${phase}\n\n${message}\n`,
  );
  writeFailure(store, paths, {
    phase,
    category: "internal",
    safeMessage: message,
    runDir: paths.root,
    nextActions: ["Open diagnostics", "Retry the run"],
  });
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", {
    lifecycle: "failed",
    facts: failFacts,
    reason: failFacts.reason,
    phase,
    error: message,
    failure_ref: "final/failure.yaml",
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

/**
 * Whole-strategy terminal net: run `body`; if it throws AFTER announcing,
 * stamp terminal artifacts instead of orphaning the run. Pre-announce throws
 * keep the loud-request contract (the caller gets the error; no run dir
 * exists). An abort surfaced as a throw is a CANCELLED terminal, not an
 * internal failure.
 */
export async function guardAnnouncedRun(
  signal: AbortSignal | undefined,
  body: (announce: (a: AnnouncedRunContext) => void) => Promise<OrchestratorResult>,
  /**
   * Invoked once with the announced runId when the strategy settles (return OR
   * throw). The single per-run terminalization hook: per-run engine state keyed
   * by runId (e.g. the routing-rationale map) is released HERE so a run that
   * dies before its telemetry writer runs cannot leak it (QA-034 map leak).
   */
  onSettled?: (runId: string) => void,
): Promise<OrchestratorResult> {
  let announced: AnnouncedRunContext | null = null;
  try {
    return await body((a) => {
      announced = a;
    });
  } catch (err) {
    // TS cannot see the closure assignment; the cast is safe (set-once).
    const a = announced as AnnouncedRunContext | null;
    if (!a) throw err;
    // Settled-spend accounting is part of the terminal contract on EVERY
    // path (the orchestrate executor aggregates it); a broken spend snapshot
    // must not mask the original failure, so it degrades to null loudly-typed.
    let spendUsd: number | null = null;
    try {
      spendUsd = a.spend ? a.spend() : null;
    } catch {
      spendUsd = null;
    }
    if (signal?.aborted) {
      return cancelledResult(
        a.log,
        a.runId,
        a.taskId,
        a.mode,
        a.paths.root,
        [],
        undefined,
        spendUsd,
        // A wall-clock abort surfaced as a throw must keep its reason and
        // materialize the diagnostic summary, exactly like the checkpoint paths.
        signal,
        a.store,
      );
    }
    return failTerminally(
      a.log,
      a.store,
      a.paths,
      a.runId,
      a.taskId,
      a.mode,
      a.phase,
      err,
      spendUsd,
    );
  } finally {
    // Release per-run engine state on EVERY terminal path (normal return, failure
    // net, cancel), but only for a run that actually announced a runId.
    const settled = announced as AnnouncedRunContext | null;
    if (settled) onSettled?.(settled.runId);
  }
}
