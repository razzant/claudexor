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
import type { ModeKind } from "@claudexor/schema";
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
    safeMessage: string;
    harnessId?: string;
    attemptId?: string;
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
    typeof cancelSignal?.reason === "string" && cancelSignal.reason ? cancelSignal.reason : undefined;
  const summaryText =
    cancelReason === "wall_clock_exceeded"
      ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
      : "run cancelled";
  // Materialize the diagnostic summary BEFORE announcing it — output.ready must
  // point at a file that exists (partial-output honesty), and it must precede
  // the terminal in every mode (INV-116).
  if (store) {
    try {
      store.writeText(
        join(runDir, "final", "summary.md"),
        `# Run ${runId} (${mode})\n\n- Status: cancelled\n${cancelReason ? `- Reason: ${cancelReason}\n` : ""}\n${summaryText}\n`,
      );
    } catch {
      /* best-effort: a write failure must not mask the cancel terminal */
    }
  }
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  log.emit("run.failed", { status: "cancelled", ...(cancelReason ? { reason: cancelReason } : {}) });
  return {
    runId,
    taskId,
    mode,
    status: "cancelled",
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
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (${mode})\n\n- Status: failed\n- Phase: ${phase}\n\n${message}\n`,
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
    status: "failed",
    phase,
    error: message,
    failure_ref: "final/failure.yaml",
  });
  return {
    runId,
    taskId,
    mode,
    status: "failed",
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
  }
}
