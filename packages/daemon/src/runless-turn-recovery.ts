/**
 * Restart recovery for accepted-but-runless thread turns.
 *
 * A turn's job is accepted durably before its run starts. When the daemon
 * stops in that window, the command store's crash reconciliation interrupts the
 * job, but the live job settlement that records `enqueue_error` on the turn
 * (`onTurnEnqueueFailed`) never runs. Without a projection the turn stays an
 * empty bubble and Turn Retry refuses it as "no recorded refusal". The same
 * thread-store owner records the restart refusal as retryable: the accepted
 * command params are the replay source. A bound turn, or one that already
 * carries a refusal, is never touched, so the pass is idempotent across starts.
 */
import type { ProjectThreadPort } from "./store-contracts.js";

interface CommandRecordView {
  state: string;
  runId?: string;
  error?: string;
  params?: unknown;
}

export const RESTARTED_BEFORE_START = "daemon_restarted_before_start";

export function recordInterruptedRunlessTurns(
  store: Pick<ProjectThreadPort, "getTurn" | "setTurnEnqueueError">,
  records: Iterable<CommandRecordView>,
): number {
  let recorded = 0;
  for (const record of records) {
    if (record.state !== "interrupted" || record.runId) continue;
    const turnId = (record.params as { turnId?: unknown } | undefined)?.turnId;
    if (typeof turnId !== "string" || !turnId) continue;
    const turn = store.getTurn(turnId);
    if (!turn || turn.run_id || turn.enqueue_error) continue;
    store.setTurnEnqueueError(turnId, {
      message: record.error ?? "daemon restarted before this turn's accepted command started a run",
      code: RESTARTED_BEFORE_START,
      retryable: true,
      required_actions: ["Retry the turn; its accepted request is replayed unchanged."],
      context: {},
    });
    recorded += 1;
  }
  return recorded;
}
