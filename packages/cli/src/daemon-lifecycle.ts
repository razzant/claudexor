/**
 * Daemon process-lifecycle wiring (T3.1#4/#5): pre-start crash GC (orphan
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
  stop: () => Promise<void> | void;
}

const logLine = (path: string, message: string): void => {
  appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`);
};

/** Pre-start: kill surviving children of a previous daemon life, then GC
 * envelopes/branches/tmp-homes nothing owns anymore. */
export async function runStartupCrashGc(deps: Pick<LifecycleDeps, "daemonDir" | "logPath">): Promise<void> {
  const pidsPath = join(deps.daemonDir, "pids.json");
  for (const action of reapRecordedOrphans(pidsPath)) {
    logLine(deps.logPath, `reaper: ${action}`);
  }
  try {
    const sweepActions = await sweepOrphanWorkspaces({
      jobsPath: join(deps.daemonDir, "jobs.json"),
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
  const pidsTimer = setInterval(() => writePidsSnapshot(pidsPath), 2_000);
  pidsTimer.unref?.();

  let stopping = false;
  const onShutdownSignal = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    logLine(deps.logPath, `${sig} received; stopping daemon`);
    void deps.stop();
  };
  process.on("SIGTERM", () => onShutdownSignal("SIGTERM"));
  process.on("SIGINT", () => onShutdownSignal("SIGINT"));

  return {
    finalize: () => {
      clearInterval(pidsTimer);
      // Graceful stop aborted all children; one final snapshot records any
      // that survived the grace window (SIGKILL escalation may be in flight).
      writePidsSnapshot(pidsPath);
    },
  };
}
