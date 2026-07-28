import { isTerminalLifecycle, type ModeKind, type RunOutcomeFacts } from "@claudexor/schema";
import { daemonOutcomeProblemFields } from "./daemon-outcome.js";
import type { DaemonRunOutcome } from "./daemon-run.js";
import { terminalDetailFields } from "./delegation-output.js";
import { projectTerminalDetailFields } from "./run-facts-projection.js";

type TerminalRunOutputOptions = {
  frame?: "run.terminal";
  summary?: string | undefined;
};

/** One owner for the identical terminal envelope emitted by JSON and NDJSON runs. */
export function projectTerminalRunOutput(
  out: DaemonRunOutcome,
  mode: ModeKind,
  detail: Record<string, unknown> | null,
  options: TerminalRunOutputOptions = {},
): Record<string, unknown> {
  return {
    ...(options.frame ? { frame: options.frame } : {}),
    runId: out.runId,
    runDir: out.runDir,
    status: out.status,
    jobId: out.jobId,
    mode,
    ...(out.error ? { error: out.error } : {}),
    ...daemonOutcomeProblemFields(out),
    ...(options.summary ? { summary: options.summary } : {}),
    ...terminalDetailFields(detail),
    // Unified identity binding (S2): like the control-api projection, the CLI
    // asserts the receipt's lifecycle against the settled daemon job state —
    // the daemon job state IS the run lifecycle (D8) once terminal.
    ...projectTerminalDetailFields(detail, {
      ...(out.runId ? { runId: out.runId } : {}),
      ...(isTerminalLifecycle(out.status)
        ? { lifecycle: out.status as RunOutcomeFacts["lifecycle"] }
        : {}),
    }),
  };
}
