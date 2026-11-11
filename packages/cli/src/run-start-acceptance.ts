import { acceptedReceiptMetadata, ControlProblem, TERMINAL_LIFECYCLES } from "@claudexor/schema";
import type { DaemonRunOutcome } from "./daemon-run.js";

const TERMINAL_STATES: ReadonlySet<string> = TERMINAL_LIFECYCLES;

/**
 * An accepted job that reached its terminal before binding a run: the daemon
 * answers its typed failure with the job identity in `context`. Refusals that
 * never accepted a job (admission, conflicts) carry no such identity.
 */
export function acceptedPreRunFailure(status: number, body: unknown): DaemonRunOutcome | null {
  const problem = ControlProblem.safeParse(body);
  if (!problem.success) return null;
  const { jobId, state } = problem.data.context;
  if (typeof jobId !== "string" || !jobId || typeof state !== "string") return null;
  if (!TERMINAL_STATES.has(state)) return null;
  return {
    ...acceptedReceiptMetadata(problem.data.context),
    jobId,
    runId: "",
    runDir: "",
    status: state,
    error: problem.data.message,
    errorCode: problem.data.code,
    errorStatus: status,
    errorRetryable: problem.data.retryable,
    errorRequiredActions: problem.data.requiredActions,
    errorContext: problem.data.context,
  };
}
