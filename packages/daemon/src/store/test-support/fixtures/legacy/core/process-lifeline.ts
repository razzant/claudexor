export interface OrphanExitOptions {
  /** Poll cadence for the parent-death check (default 5s, unref'd). */
  intervalMs?: number;
  getppid?: () => number;
  exit?: (code: number) => void;
  /** Disclosed once, right before exiting (e.g. a stderr note). */
  onOrphaned?: () => void;
}

/**
 * Orphaned-bridge watchdog (W3.5): a stdio bridge (mcp/acp serve) whose HOST
 * died without the pipe closing — grandchildren holding inherited fds, a
 * SIGKILLed host — reparents to pid 1 and would otherwise idle forever with
 * nobody on the other end. Polling ppid catches exactly that class; the
 * interval is unref'd so the watchdog never keeps a clean bridge alive.
 */
export function armOrphanExit(options: OrphanExitOptions = {}): { stop: () => void } {
  const getppid = options.getppid ?? (() => process.ppid);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timer = setInterval(() => {
    if (getppid() !== 1) return;
    try {
      options.onOrphaned?.();
    } catch {
      /* the disclosure must not block the exit */
    }
    exit(0);
  }, options.intervalMs ?? 5_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
