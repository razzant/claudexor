/**
 * Pure helpers of the whole-strategy terminal net (`runTerminals.ts`): the
 * terminal event type from the canonical axes, cancel-reason mapping, payload
 * decoding, committed-outcome recovery and the post-drain budget failure.
 */
import { join } from "node:path";
import {
  type CancelReasonCode,
  makeOutcomeFacts,
  needsOperatorAttention,
  normalizeCancelReasonCode,
  RunOutcomeFacts,
  type PoolAttemptFailure,
  type RunOutcomeFacts as RunOutcomeFactsType,
} from "@claudexor/schema";
import type { BudgetTerminal } from "@claudexor/budget";
import type { TerminalRunEventType } from "@claudexor/event-log";
import { readTextSafe } from "@claudexor/util";
import { budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import type { ContinuityTerminalFacts } from "./continuity-terminal.js";
import { poolFailure } from "./pool-attempt-evidence.js";
import { reconcileDecisionBudget, type SettledBudgetSnapshot } from "./decisionBudget.js";
import type { OrchestratorResult } from "./orchestrator.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import { flushContinuationTerminal } from "./continuation-custody.js";
import { cancellationStatement, writeFailure } from "./runTerminalResults.js";
import {
  clearFailureArtifact,
  reconcileWorkProductTerminal,
  terminalOutcomeFacts,
} from "./terminalOutcome.js";

export function ownsDelegateDrain(context: AnnouncedRunContext): boolean {
  try {
    return context.recheckBudgetAfterBarrier?.() === true;
  } catch {
    // Reconciliation is an extra authority granted only to a proven Delegate
    // drain owner. An unreadable ownership predicate must fail closed instead
    // of touching an ordinary Agent's already-terminal artifacts.
    return false;
  }
}

export function postDrainBudgetFailure(
  context: AnnouncedRunContext,
  terminal: Exclude<BudgetTerminal, null>,
  budget: SettledBudgetSnapshot,
  prior: OrchestratorResult,
): OrchestratorResult {
  const mapping = classifyBudgetFailure({ denial: null, terminal });
  const facts = terminalOutcomeFacts(prior.facts, "failed", mapping.reason);
  reconcileDecisionBudget(context, budget, { facts, why: mapping.safeMessage });
  reconcileWorkProductTerminal(context, facts);
  const { message, poolAttempts } = poolFailure(mapping.safeMessage, context.attempts?.() ?? []);
  context.store.writeText(
    join(context.paths.finalDir, "summary.md"),
    `# Run ${context.runId} (${context.mode})\n\n- Lifecycle: failed (${mapping.reason})\n- Phase: budget\n\n${message}\n`,
  );
  writeFailure(context.store, context.paths, {
    ...budgetFailureRecord(mapping, { runDir: context.paths.root }),
    safeMessage: message,
    poolAttempts,
  });
  context.log.emit("output.ready", {
    kind: "summary",
    path: "final/summary.md",
    state: "diagnostic",
  });
  context.log.emit("run.failed", {
    lifecycle: "failed",
    facts,
    reason: mapping.reason,
    phase: "budget",
    error: message,
    pool_attempts: poolAttempts,
    failure_ref: "final/failure.yaml",
  });
  return {
    ...prior,
    lifecycle: "failed",
    facts,
    summary: message,
    spendUsd: budget.spendUsd,
  };
}

/** The terminal-facts failure's message with the run's list, like every
 * failure terminal; an unreadable history costs only the list, never the terminal. */
export function terminalFactsFailure(
  context: AnnouncedRunContext,
  detail: string,
): { message: string; poolAttempts: PoolAttemptFailure[] } {
  const message = `terminal facts preparation failed: ${detail}`;
  try {
    return poolFailure(message, context.attempts?.() ?? []);
  } catch {
    return { message, poolAttempts: [] };
  }
}

/** A cancellation the terminal commit chose over the strategy's own verdict. */
export interface CommittedCancellation {
  summary: string;
  cancelReason?: string;
  payload: Record<string, unknown>;
}

/**
 * The cancel landed after the strategy's last checkpoint, so the terminal
 * commit (not the strategy) chose it: state it like every cancelled terminal.
 * The run's collected attempts name their earlier failed tries on the event and
 * in summary.md; the verdict's own failure cause and record are not the
 * cancel's (a cancellation has none), except a record that carries capture
 * facts: it stays on the public failure surface re-labelled with this same
 * statement (`clearFailureArtifact`), and the event keeps its address. Best
 * effort: an unreadable history costs only the list, an unwritable artifact
 * never the terminal.
 */
export function commitCancellation(
  context: AnnouncedRunContext,
  signal: AbortSignal,
  payload: Record<string, unknown>,
): CommittedCancellation {
  let attempts: readonly ContinuityTerminalFacts[] | null = null;
  try {
    attempts = context.attempts?.() ?? null;
  } catch {
    /* the cancellation stands without its list */
  }
  const statement = cancellationStatement(context.runId, context.mode, signal, attempts ?? []);
  try {
    context.store.writeText(join(context.paths.finalDir, "summary.md"), statement.markdown);
  } catch {
    /* the terminal event remains the authority */
  }
  let failureKept = false;
  try {
    failureKept = clearFailureArtifact(context, { summary: statement.summary });
  } catch {
    /* the terminal event remains the authority */
  }
  const { phase: _phase, error: _error, failure_ref: _failureRef, ...kept } = payload;
  return {
    summary: statement.summary,
    ...(statement.cancelReason ? { cancelReason: statement.cancelReason } : {}),
    payload: {
      ...kept,
      ...(failureKept ? { failure_ref: "final/failure.yaml" } : {}),
      ...(statement.cancelReason ? { cancel_reason: statement.cancelReason } : {}),
      ...(attempts ? { pool_attempts: statement.poolAttempts } : {}),
    },
  };
}

export function terminalEventTypeFor(
  _originalType: TerminalRunEventType,
  outcome: RunOutcomeFactsType,
): TerminalRunEventType {
  if (outcome.lifecycle !== "succeeded") return "run.failed";
  if (needsOperatorAttention(outcome, false)) return "run.blocked";
  // The canonical axes own terminal type. Preserving a producer-authored
  // run.blocked with clean axes creates an unexplainable block (no reason or
  // required action), so it is normalized to completed.
  return "run.completed";
}

/** Map an abort-signal reason token to its typed terminal RunReason. The
 * abort reason is the ONE channel a cancel's provenance survives on — before
 * this mapping every host-initiated cancel coerced to user_cancelled (the
 * daemon's own ctrl-c relay and the MCP host teardown included). The client
 * vocabulary is read from CANCEL_REASON_CODES so a future member cannot be
 * silently coerced away here while the HTTP boundary already admits it;
 * wall_clock_exceeded stays daemon-internal (deliberately NOT in the client
 * enum — unforgeable). Unknown tokens keep the user_cancelled coercion for
 * wire compatibility. */
export function cancelReasonFromSignalToken(
  reason: unknown,
): "wall_clock_exceeded" | CancelReasonCode {
  if (reason === "wall_clock_exceeded") return "wall_clock_exceeded";
  return normalizeCancelReasonCode(reason) ?? "user_cancelled";
}

export function cancellationFacts(
  signal: AbortSignal,
  prior: RunOutcomeFactsType,
): RunOutcomeFactsType {
  return terminalOutcomeFacts(prior, "cancelled", cancelReasonFromSignalToken(signal.reason));
}

export function terminalOutcomeFromPayload(payload: Record<string, unknown>): RunOutcomeFactsType {
  const parsed = RunOutcomeFacts.safeParse(payload["facts"]);
  if (parsed.success) return parsed.data;
  // Older in-process terminal producers (including the Delegate drain
  // contract) supplied only lifecycle. Keep that compatible while treating an
  // explicitly malformed facts object as a contradiction that must fail
  // closed through the terminal-facts path below.
  if (!Object.prototype.hasOwnProperty.call(payload, "facts")) {
    const lifecycle = payload["lifecycle"];
    if (
      lifecycle === "succeeded" ||
      lifecycle === "failed" ||
      lifecycle === "cancelled" ||
      lifecycle === "interrupted"
    ) {
      return makeOutcomeFacts(lifecycle);
    }
  }
  return RunOutcomeFacts.parse(payload["facts"]);
}

export function settledSpend(a: AnnouncedRunContext): number | null {
  try {
    return a.spend ? a.spend() : null;
  } catch {
    return null;
  }
}

export function isTerminalRecoveryRequired(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "terminal_recovery_required"
  );
}

/**
 * The failure net's flush: settle custody, then commit its held terminal. A
 * landing failure that interrupts the commit is consumed by the commit's own
 * barrier and leaves the terminal held, so the flush that follows commits it
 * (#704); a failure of that one is the run's to throw, as before.
 */
export async function commitNetTerminal(
  a: AnnouncedRunContext,
  facts: RunOutcomeFactsType,
): Promise<void> {
  try {
    await flushContinuationTerminal(a, facts);
  } catch (error) {
    if (
      isTerminalRecoveryRequired(error) ||
      a.log.terminalCommitted() ||
      !a.log.deferredTerminalPending()
    )
      throw error;
    await flushContinuationTerminal(a, facts);
  }
}

export function committedOutcome(a: AnnouncedRunContext): RunOutcomeFactsType | null {
  const terminal = [...a.log.readAll().events]
    .reverse()
    .find(
      (event) =>
        event.type === "run.completed" ||
        event.type === "run.blocked" ||
        event.type === "run.failed",
    );
  const parsed = RunOutcomeFacts.safeParse(terminal?.payload["facts"]);
  return parsed.success ? parsed.data : null;
}

export function committedResult(
  a: AnnouncedRunContext,
  outcome: RunOutcomeFactsType,
  spendUsd: number | null,
): OrchestratorResult {
  const summary =
    readTextSafe(join(a.paths.finalDir, "summary.md"))?.trim().slice(0, 400) ??
    `run terminal committed with lifecycle ${outcome.lifecycle}`;
  return {
    runId: a.runId,
    taskId: a.taskId,
    mode: a.mode,
    lifecycle: outcome.lifecycle,
    facts: outcome,
    winner: null,
    runDir: a.paths.root,
    summary,
    candidates: [],
    spendUsd,
  };
}
