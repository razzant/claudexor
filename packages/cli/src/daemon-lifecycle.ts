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
      threadsPath: join(deps.daemonDir, "threads.json"),
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

  let stopping = false;
  const onShutdownSignal = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    logLine(deps.logPath, `${sig} received; stopping daemon`);
    void deps.stop().catch((error) => {
      if (deps.onStopFailure) deps.onStopFailure(error);
      else process.exitCode = 1;
      logLine(
        deps.logPath,
        `shutdown FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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
      signals.off("SIGTERM", onSigterm);
      signals.off("SIGINT", onSigint);
      // Graceful stop aborted all children; one final snapshot records any
      // that survived the grace window (SIGKILL escalation may be in flight).
      writeSnapshot();
    },
  };
}
