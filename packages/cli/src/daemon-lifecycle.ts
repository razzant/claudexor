/**
 * Daemon process-lifecycle wiring: pre-start crash GC (orphan
 * reap + workspace sweep), live-children bookkeeping, and graceful shutdown
 * signals. Kept out of claudexord's main() so the entrypoint stays a thin
 * composition root. OS signals are just one TRIGGER of the single shutdown
 * state machine (DaemonRuntimeShutdown, W3.5) — the escalation ladder lives
 * there so a socket-RPC stop gets the same bounded termination.
 */
import { join } from "node:path";
import { isDelayedLoopWindow, LOOP_FACTS_WINDOW_MS, startLoopFacts } from "@claudexor/daemon";
import { loopStallMessage } from "./daemon-rare-history.js";
import { logLine } from "./log-line.js";
import { PidsSnapshotWriter, reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";
import { preparationQuietFor } from "./thread-preparation-scope.js";
import type { RunScopeEntry } from "./run-scope-index-rows.js";
import type {
  DaemonStartupDiagnosticRecord,
  DaemonStartupDiagnostics,
} from "./startup-diagnostics.js";

interface LifecycleDeps {
  daemonDir: string;
  /** Compatibility fallback until the shared composition root wires the sink. */
  logPath?: string;
  /** Narrow post-authority diagnostic port; it never controls lifecycle. */
  diagnostics?: Pick<DaemonStartupDiagnostics, "record">;
  /** Enter the shutdown state machine (DaemonRuntimeShutdown.beginShutdown). */
  beginShutdown: (reason: string) => Promise<void>;
  signals?: Pick<NodeJS.Process, "on" | "off">;
  /** The final, synchronous snapshot written by the finalizer. */
  snapshot?: (path: string) => void;
  /** The periodic, change-only asynchronous snapshots. */
  pidsWriter?: Pick<PidsSnapshotWriter, "refresh" | "settled">;
  /**
   * The run-scope index's capture pass, ridden on the same tick as the pids
   * snapshot (no new timer): records each live run's descendants while the
   * parent chain is intact, so a `setsid` shell and its tools can be ended at
   * the run's barrier even where the kernel hides their environment.
   */
  scopeCapture?: { captureTick(): Promise<void> };
}

export { logLine } from "./log-line.js";
export { daemonRunScopeIndex } from "./run-scope-index.js";

function lifecycleDiagnostic(
  deps: Pick<LifecycleDeps, "diagnostics" | "logPath">,
  record: DaemonStartupDiagnosticRecord,
): void {
  if (deps.diagnostics) {
    try {
      void deps.diagnostics.record(record);
    } catch {
      /* lifecycle safety must not depend on diagnostic I/O */
    }
    return;
  }
  if (deps.logPath) logLine(deps.logPath, record.message);
}

/** Pre-start: kill surviving children of a previous daemon life, then GC
 * envelopes/branches/tmp-homes nothing owns anymore. */
export async function runStartupCrashGc(
  deps: Pick<LifecycleDeps, "daemonDir" | "diagnostics" | "logPath"> & {
    /** Scope roots of the stage-2 prepared global command projection. */
    knownProjectRoots: () => readonly string[];
    knownExecutionRoots?: () => readonly string[];
    /** The run-scope index: unresolved scopes of dead daemon generations are
     * settled or disclosed here, BEFORE the workspace sweep. */
    runScopes?: { settleDeadOwners(): Promise<string[]>; list?(): RunScopeEntry[] };
  },
): Promise<void> {
  const pidsPath = join(deps.daemonDir, "pids.json");
  for (const action of reapRecordedOrphans(pidsPath)) {
    lifecycleDiagnostic(deps, { stage: "crash_gc_reaper", message: `reaper: ${action}` });
  }
  if (deps.runScopes) {
    try {
      for (const action of await deps.runScopes.settleDeadOwners()) {
        lifecycleDiagnostic(deps, { stage: "crash_gc_scopes", message: `scopes: ${action}` });
      }
    } catch (err) {
      lifecycleDiagnostic(deps, {
        stage: "crash_gc_scopes",
        message: `scopes FAILED: ${err instanceof Error ? err.message : String(err)}`,
        error: err,
      });
    }
  }
  try {
    const sweepActions = await sweepOrphanWorkspaces({
      knownProjectRoots: deps.knownProjectRoots,
      ...(deps.runScopes?.list
        ? { quiet: preparationQuietFor({ list: () => deps.runScopes?.list?.() ?? [] }) }
        : {}),
      ...(deps.knownExecutionRoots ? { knownExecutionRoots: deps.knownExecutionRoots } : {}),
    });
    for (const action of sweepActions) {
      lifecycleDiagnostic(deps, { stage: "crash_gc_sweep", message: `sweep: ${action}` });
    }
  } catch (err) {
    lifecycleDiagnostic(deps, {
      stage: "crash_gc_sweep",
      message: `sweep FAILED: ${err instanceof Error ? err.message : String(err)}`,
      error: err,
    });
  }
}

/**
 * Post-start: periodic live-children snapshots (the reap list a crash leaves
 * behind; written off the event loop and only when the children changed),
 * windowed event-loop facts for daemon status (a measurably delayed window is
 * also a `loop_stall` diagnostic), and SIGTERM/SIGINT -> the
 * shutdown state machine (abort children, persist, close, bounded escalation).
 * Returns the finalizer for main()'s tail; it awaits any in-flight periodic
 * write before the final snapshot, so the final snapshot is the last word.
 *
 * The snapshot timer is NOT armed here: with zero live children a snapshot
 * DELETES pids.json, and until stage-4 crash-GC has consumed the previous
 * life's file that file is the only record of surviving children (C2). The
 * composition root calls `beginPidSnapshots()` once admission is normal;
 * recovery-only serving leaves the previous pids.json byte-untouched, and the
 * finalizer writes a final snapshot only when snapshots were armed.
 */
export function armDaemonLifecycle(deps: LifecycleDeps): {
  beginPidSnapshots: () => void;
  finalize: () => Promise<void>;
} {
  const pidsPath = join(deps.daemonDir, "pids.json");
  const signals = deps.signals ?? process;
  const snapshot = deps.snapshot ?? writePidsSnapshot;
  const pidsWriter = deps.pidsWriter ?? new PidsSnapshotWriter(pidsPath);
  const writeSnapshot = (): void => {
    try {
      snapshot(pidsPath);
    } catch (error) {
      lifecycleDiagnostic(deps, {
        stage: "pid_snapshot",
        message: `pid snapshot FAILED: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
    }
  };
  let pidsTimer: NodeJS.Timeout | null = null;

  let stopping = false;
  let finalized = false;
  const onShutdownSignal = (sig: string): void => {
    // Duplicate deliveries coalesce (launchd/tooling may re-signal); the
    // machine's deadline timer guarantees termination.
    if (stopping) return;
    stopping = true;
    void deps.beginShutdown(sig).catch(() => {
      // The machine logged the failure and keeps its deadline armed.
    });
    lifecycleDiagnostic(deps, {
      stage: "shutdown_signal",
      message: `${sig} received; stopping daemon`,
    });
  };
  const onSigterm = () => onShutdownSignal("SIGTERM");
  const onSigint = () => onShutdownSignal("SIGINT");
  signals.on("SIGTERM", onSigterm);
  signals.on("SIGINT", onSigint);
  const stopLoopFacts = startLoopFacts(LOOP_FACTS_WINDOW_MS, (facts) => {
    if (!isDelayedLoopWindow(facts, LOOP_FACTS_WINDOW_MS)) return;
    const message = loopStallMessage(facts, LOOP_FACTS_WINDOW_MS);
    lifecycleDiagnostic(deps, { stage: "loop_stall", message });
  });

  return {
    beginPidSnapshots: () => {
      if (pidsTimer || finalized) return;
      pidsTimer = setInterval(() => {
        void pidsWriter.refresh();
        void deps.scopeCapture?.captureTick().catch(() => {});
      }, 2_000);
      pidsTimer.unref?.();
    },
    finalize: async () => {
      if (finalized) return;
      finalized = true;
      const snapshotsWereArmed = pidsTimer !== null;
      if (pidsTimer) clearInterval(pidsTimer);
      pidsTimer = null;
      signals.off("SIGTERM", onSigterm);
      signals.off("SIGINT", onSigint);
      stopLoopFacts();
      // Graceful stop aborted all children; one final snapshot records any
      // that survived the grace window (SIGKILL escalation may be in flight).
      // Without armed snapshots there were no children to record, and the
      // previous life's pids.json must stay byte-untouched (C2).
      if (!snapshotsWereArmed) return;
      await pidsWriter.settled();
      writeSnapshot();
    },
  };
}
