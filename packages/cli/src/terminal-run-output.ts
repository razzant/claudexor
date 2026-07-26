import type { ModeKind } from "@claudexor/schema";
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
    ...projectTerminalDetailFields(detail, out.runId ? { runId: out.runId } : {}),
  };
}
