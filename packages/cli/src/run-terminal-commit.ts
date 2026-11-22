/**
 * The durable terminal hook a thread or one-shot run is given, followed by the
 * daemon's notice that the terminal is committed (run-deadline/1: the job's
 * deadline closes at that commit, not when the runner returns later, so no
 * renewal is confirmed for a job SQL already ended). Returning `pending` means
 * the SQL terminal committed and only its files are owed: it is a commit. A
 * throw committed nothing, and the daemon is not told.
 */
import type { RunContext } from "@claudexor/daemon";

export function terminalCommitHook<H extends (...args: never[]) => unknown>(
  persist: H | undefined,
  ctx: Pick<RunContext, "onTerminalCommitted">,
): H | undefined {
  if (!persist) return undefined;
  return ((...args: Parameters<H>) => {
    const result = persist(...args);
    ctx.onTerminalCommitted?.();
    return result;
  }) as H;
}
