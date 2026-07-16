/**
 * Daemon process-lifecycle wiring: pre-start crash GC (orphan
 * reap + workspace sweep), live-children bookkeeping, and graceful shutdown
 * signals. Kept out of claudexord's main() so the entrypoint stays a thin
 * composition root.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

interface LifecycleDeps {
  daemonDir: string;
  logPath: string;
  stop: () => Promise<void>;
  signals?: Pick<NodeJS.Process, "on" | "off">;
  snapshot?: (path: string) => void;
  onStopFailure?: (error: unknown) => void;
  /** Injectable force-exit (tests); defaults to process.exit. */
  forceExit?: (code: number) => void;
  /** Graceful-stop deadline before the escalation exit (default 15s). */
  stopDeadlineMs?: number;
  /** Post-stop grace for the event loop to drain before the sweep exit (default 2s). */
  drainGraceMs?: number;
}

const logLine = (path: string, message: string): void => {
  try {
    appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* lifecycle safety must not depend on diagnostic I/O */
  }
};

/** Pre-start: kill surviving children of a previous daemon life, then GC
 * envelopes/branches/tmp-homes nothing owns anymore. */
export async function runStartupCrashGc(
  deps: Pick<LifecycleDeps, "daemonDir" | "logPath">,
): Promise<void> {
  const pidsPath = join(deps.daemonDir, "pids.json");
  for (const action of reapRecordedOrphans(pidsPath)) {
    logLine(deps.logPath, `reaper: ${action}`);
  }
  try {
    const sweepActions = await sweepOrphanWorkspaces({
      journalRoot: join(deps.daemonDir, "journal"),
    });
    for (const action of sweepActions) {
      logLine(deps.logPath, `sweep: ${action}`);
    }
  } catch (err) {
    logLine(deps.logPath, `sweep FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Post-start: periodic live-children snapshots (the reap list a crash leaves
 * behind) and SIGTERM/SIGINT -> graceful stop (abort children, persist,
 * close). Returns the shutdown finalizer for the main() tail.
 */
export function armDaemonLifecycle(deps: LifecycleDeps): { finalize: () => void } {
  const pidsPath = join(deps.daemonDir, "pids.json");
  const signals = deps.signals ?? process;
  const snapshot = deps.snapshot ?? writePidsSnapshot;
  const writeSnapshot = (): void => {
    try {
      snapshot(pidsPath);
    } catch (error) {
      logLine(
        deps.logPath,
        `pid snapshot FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const pidsTimer = setInterval(writeSnapshot, 2_000);
  pidsTimer.unref?.();

  // Escalation ladder (Ф2.5 W-C8, the immortal-daemon class): once a SIGTERM
  // handler is registered, node no longer default-exits — a hung stop() (or a
  // leaked handle after a clean stop) used to leave daemons alive until
  // SIGKILL. Every rung is DISCLOSED in the log and every timer is unref'd so
  // the ladder itself never keeps a clean process alive.
  const forceExit = deps.forceExit ?? ((code: number) => process.exit(code));
  const stopDeadlineMs = deps.stopDeadlineMs ?? 15_000;
  const drainGraceMs = deps.drainGraceMs ?? 2_000;
  // Timer handles are RETAINED so the deadline can be cancelled once stop()
  // settles and both can be cancelled in finalize() (review sol #17). The
  // callbacks read `process.exitCode` at FIRE time (not arm time), so a
  // failure setting it during the grace window still exits nonzero.
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const armExitTimer = (ms: number, reason: string, code?: number): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      logLine(deps.logPath, reason);
      forceExit(code ?? Number(process.exitCode ?? 0));
    }, ms);
    t.unref?.();
    return t;
  };

  let stopping = false;
  const onShutdownSignal = (sig: string): void => {
    // Duplicate deliveries coalesce (launchd/tooling may re-signal); the
    // deadline timer below already guarantees termination.
    if (stopping) return;
    stopping = true;
    logLine(deps.logPath, `${sig} received; stopping daemon`);
    deadlineTimer = armExitTimer(
      stopDeadlineMs,
      `graceful stop exceeded ${stopDeadlineMs}ms; forcing exit`,
      1,
    );
    void deps.stop().then(
      () => {
        // stop() settled: cancel the deadline. If the loop then drains the
        // process exits before the drain timer fires (unref'd); a leaked
        // handle is swept with the exit code prevailing AT that time.
        if (deadlineTimer) clearTimeout(deadlineTimer);
        deadlineTimer = null;
        drainTimer = armExitTimer(
          drainGraceMs,
          `event loop still alive ${drainGraceMs}ms after a clean stop (leaked handle); forcing exit`,
        );
      },
      (error: unknown) => {
        if (deps.onStopFailure) deps.onStopFailure(error);
        else process.exitCode = 1;
        logLine(
          deps.logPath,
          `shutdown FAILED: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Failure: the deadline timer stays armed to guarantee exit.
      },
    );
  };
  const onSigterm = () => onShutdownSignal("SIGTERM");
  const onSigint = () => onShutdownSignal("SIGINT");
  signals.on("SIGTERM", onSigterm);
  signals.on("SIGINT", onSigint);

  let finalized = false;
  return {
    finalize: () => {
      if (finalized) return;
      finalized = true;
      clearInterval(pidsTimer);
      // Cancel any armed escalation timers: a clean shutdown reaching the
      // main() tail must not be force-exited by a still-pending timer.
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (drainTimer) clearTimeout(drainTimer);
      deadlineTimer = null;
      drainTimer = null;
      signals.off("SIGTERM", onSigterm);
      signals.off("SIGINT", onSigint);
      // Graceful stop aborted all children; one final snapshot records any
      // that survived the grace window (SIGKILL escalation may be in flight).
      writeSnapshot();
    },
  };
}
