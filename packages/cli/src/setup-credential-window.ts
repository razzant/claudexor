/**
 * The credential-mutation window of the daemon's setup lifecycle (#363).
 *
 * A native login may rewrite a credential store from the moment the daemon
 * issues its execution permit through terminal verification. Closing requires
 * the runner's hash-bound result or a process group proven empty (monitor,
 * cancel/timeout, restart or explicit reconciliation). Fresh verification can
 * run while the window is open. The durable job owns it; no second store,
 * lease or timer:
 * - an active job holding an execution permit is open, whoever attached its
 *   terminal and whether or not that client still lives;
 * - a terminal job whose termination is unconfirmed (a vendor that may still
 *   survive) stays open until a reconciliation proves its group empty;
 * - a deadline never closes it: expiry only starts the termination that must
 *   prove death, and an unproven one stays open;
 * - an unreadable setup journal, or a lifecycle generation that is not bound,
 *   proves nothing closed (the core reader fails closed on the throw).
 * Every durable transition that opens or closes a window runs the
 * login-lifecycle invalidation, so what was observed before the window, and
 * anything a fenced observer saw during it, is void after it.
 */
import type { ControlHarnessSetupHarness, ControlSetupJob } from "@claudexor/schema";
import { ACTIVE_SETUP_STATES, type SetupJobStorePort } from "./setup-job-projection.js";
import { hasUnconfirmedSetupTermination } from "./setup-job-reducer.js";

type WindowFacts = Pick<
  ControlSetupJob,
  "state" | "execution" | "outcome" | "terminationReconciliation"
>;

/** Whether this permitted login is unfinished or its termination is unproven. */
export function credentialMutationWindowOpenFor(job: WindowFacts): boolean {
  return (
    Boolean(job.execution?.permitIssuedAt) &&
    (ACTIVE_SETUP_STATES.has(job.state) || hasUnconfirmedSetupTermination(job))
  );
}

/** The daemon's projection for `credentialMutationWindowOpen` (core): any job of
 * `harness` (every harness when undefined) with an open window. The store scan
 * throws while the setup journal requires recovery. */
export function open(store: Pick<SetupJobStorePort, "some">, harness?: string): boolean {
  return store.some(
    (job) =>
      (harness === undefined || job.harness === harness) && credentialMutationWindowOpenFor(job),
  );
}

/**
 * The setup manager's ONE durable update path, with the window hook: the
 * login-lifecycle invalidation fires when a transition opens or closes a job's
 * window, never on any other update. A failed invalidation is logged, not
 * thrown after the durable write: the window itself stays derived from the
 * journal, so the fenced observers keep refusing while it is open.
 */
export function observedUpdate(
  store: Pick<SetupJobStorePort, "status" | "update">,
  options: { onCredentialStateMayHaveChanged?: (harness: ControlHarnessSetupHarness) => void },
  log: (jobId: string, line: string) => void,
): SetupJobStorePort["update"] {
  return (jobId, patch, idempotency) => {
    const before = store.status(jobId);
    const after = store.update(jobId, patch, idempotency);
    const onChange = options.onCredentialStateMayHaveChanged;
    if (
      onChange &&
      credentialMutationWindowOpenFor(before) !== credentialMutationWindowOpenFor(after)
    ) {
      try {
        onChange(after.harness);
      } catch (error) {
        log(
          jobId,
          `credential observer invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return after;
  };
}
