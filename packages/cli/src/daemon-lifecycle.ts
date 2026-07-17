/**
 * Daemon process-lifecycle wiring: pre-start crash GC (orphan
 * reap + workspace sweep), live-children bookkeeping, and graceful shutdown
 * signals. Kept out of claudexord's main() so the entrypoint stays a thin
 * composition root. OS signals are just one TRIGGER of the single shutdown
 * state machine (DaemonRuntimeShutdown, W3.5) — the escalation ladder lives
 * there so a socket-RPC stop gets the same bounded termination.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { reapRecordedOrphans, writePidsSnapshot } from "./orphan-reaper.js";
import { sweepOrphanWorkspaces } from "./orphan-sweeper.js";

interface LifecycleDeps {
  daemonDir: string;
  logPath: string;
  /** Enter the shutdown state machine (DaemonRuntimeShutdown.beginShutdown). */
  beginShutdown: (reason: string) => Promise<void>;
  signals?: Pick<NodeJS.Process, "on" | "off">;
  snapshot?: (path: string) => void;
}

export const logLine = (path: string, message: string): void => {
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
 * behind) and SIGTERM/SIGINT -> the shutdown state machine (abort children,
 * persist, close, bounded escalation). Returns the finalizer for main()'s tail.
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
  let finalized = false;
  const onShutdownSignal = (sig: string): void => {
    // Duplicate deliveries coalesce (launchd/tooling may re-signal); the
    // machine's deadline timer guarantees termination.
    if (stopping) return;
    stopping = true;
    logLine(deps.logPath, `${sig} received; stopping daemon`);
    void deps.beginShutdown(sig).catch(() => {
      // The machine logged the failure and keeps its deadline armed.
    });
  };
  const onSigterm = () => onShutdownSignal("SIGTERM");
  const onSigint = () => onShutdownSignal("SIGINT");
  signals.on("SIGTERM", onSigterm);
  signals.on("SIGINT", onSigint);

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
