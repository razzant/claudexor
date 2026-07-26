/**
 * Terminal-state machinery shared by every strategy: typed failure artifacts,
 * the cancelled terminal, and the announced-run safety net. Every run that
 * was ANNOUNCED (run.created after createRun) must end with a terminal event
 * — run.completed, run.blocked, or run.failed — plus failure.yaml/summary
 * artifacts on the failure paths. An escaped throw used to orphan the run
 * dir, leaving events.jsonl without a terminal and SSE tailers waiting
 * forever.
 */
import { join } from "node:path";
import {
  makeOutcomeFacts,
  needsOperatorAttention,
  RunOutcomeFacts,
  type RunOutcomeFacts as RunOutcomeFactsType,
} from "@claudexor/schema";
import type { BudgetTerminal } from "@claudexor/budget";
import type { TerminalRunEventType } from "@claudexor/event-log";
import { readTextSafe, redactSecrets } from "@claudexor/util";
import { budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import {
  reconcileDecisionBudget,
  settledBudgetSnapshot,
  type SettledBudgetSnapshot,
} from "./decisionBudget.js";
import { reconcileDecisionTerminal } from "./decisionTerminalReconciliation.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { prepareRunFactsFailureReceipt, prepareRunFactsReceipt } from "./runFacts.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import { cancelledResult, failTerminally, writeFailure } from "./runTerminalResults.js";
import {
  clearFailureArtifact,
  reconcileWorkProductTerminal,
  terminalOutcomeFacts,
} from "./terminalOutcome.js";

export { announcedRunContext, type AnnouncedRunContext } from "./runTerminalContext.js";
export { cancelledResult, failTerminally, writeFailure };

function ownsDelegateDrain(context: AnnouncedRunContext): boolean {
  try {
    return context.recheckBudgetAfterBarrier?.() === true;
  } catch {
    // Reconciliation is an extra authority granted only to a proven Delegate
    // drain owner. An unreadable ownership predicate must fail closed instead
    // of touching an ordinary Agent's already-terminal artifacts.
    return false;
  }
}

function postDrainBudgetFailure(
  context: AnnouncedRunContext,
  terminal: Exclude<BudgetTerminal, null>,
  budget: SettledBudgetSnapshot,
  prior: OrchestratorResult,
): OrchestratorResult {
  const mapping = classifyBudgetFailure({ denial: null, terminal });
  const facts = terminalOutcomeFacts(prior.facts, "failed", mapping.reason);
  reconcileDecisionBudget(context, budget, { facts, why: mapping.safeMessage });
  reconcileWorkProductTerminal(context, facts);
  context.store.writeText(
    join(context.paths.finalDir, "summary.md"),
    `# Run ${context.runId} (${context.mode})\n\n- Lifecycle: failed (${mapping.reason})\n- Phase: budget\n\n${mapping.safeMessage}\n`,
  );
  writeFailure(
    context.store,
    context.paths,
    budgetFailureRecord(mapping, { runDir: context.paths.root }),
  );
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
    error: mapping.safeMessage,
    failure_ref: "final/failure.yaml",
  });
  return {
    ...prior,
    lifecycle: "failed",
    facts,
    summary: mapping.safeMessage,
    spendUsd: budget.spendUsd,
  };
}

function terminalEventTypeFor(
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

function cancellationFacts(signal: AbortSignal, prior: RunOutcomeFactsType): RunOutcomeFactsType {
  return terminalOutcomeFacts(
    prior,
    "cancelled",
    typeof signal.reason === "string" && signal.reason === "wall_clock_exceeded"
      ? "wall_clock_exceeded"
      : "user_cancelled",
  );
}

function terminalOutcomeFromPayload(payload: Record<string, unknown>): RunOutcomeFactsType {
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

function settledSpend(a: AnnouncedRunContext): number | null {
  try {
    return a.spend ? a.spend() : null;
  } catch {
    return null;
  }
}

function isTerminalRecoveryRequired(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "terminal_recovery_required"
  );
}

function committedOutcome(a: AnnouncedRunContext): RunOutcomeFactsType | null {
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

function committedResult(
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

/**
 * Whole-strategy terminal net: run `body`; if it throws AFTER announcing,
 * stamp terminal artifacts instead of orphaning the run. Pre-announce throws
 * keep the loud-request contract (the caller gets the error; no run dir
 * exists). An abort surfaced as a throw is a CANCELLED terminal, not an
 * internal failure.
 */
export async function guardAnnouncedRun(
  signal: AbortSignal | undefined,
  body: (announce: (a: AnnouncedRunContext) => void) => Promise<OrchestratorResult>,
  /** Awaited after strategy work but before a deferred terminal is flushed.
   * Delegate parents use it to fence admission and drain child settlements. */
  beforeTerminal?: (context: AnnouncedRunContext) => void | Promise<void>,
  /**
   * Invoked once with the announced runId when the strategy settles (return OR
   * throw). The single per-run terminalization hook: per-run engine state keyed
   * by runId (e.g. the routing-rationale map) is released HERE so a run that
   * dies before its telemetry writer runs cannot leak it (QA-034 map leak).
   */
  onSettled?: (runId: string) => void | Promise<void>,
): Promise<OrchestratorResult> {
  let announced: AnnouncedRunContext | null = null;
  let preparedResult: OrchestratorResult | null = null;
  let canonicalOutcome: RunOutcomeFactsType | null = null;
  let terminalPreparationError: string | null = null;
  let barrierAttempted = false;
  let barrierFailed = false;
  const runBarrier = async (context: AnnouncedRunContext): Promise<void> => {
    if (barrierAttempted) return;
    barrierAttempted = true;
    try {
      await beforeTerminal?.(context);
    } catch (error) {
      barrierFailed = true;
      throw error;
    }
  };
  try {
    let result: OrchestratorResult;
    try {
      result = await body((a) => {
        announced = a;
        a.log.setBeforeTerminal((originalType, payload) => {
          try {
            // Cancellation wins only until the synchronous terminal commit
            // starts. A later abort cannot rewrite an already-durable success.
            const payloadOutcome = terminalOutcomeFromPayload(payload);
            const terminalOutcome = signal?.aborted
              ? cancellationFacts(signal, payloadOutcome)
              : payloadOutcome;
            const prepared = prepareRunFactsReceipt(a, terminalOutcome);
            canonicalOutcome = prepared.facts.outcome;
            return {
              type: terminalEventTypeFor(originalType, prepared.facts.outcome),
              payload: {
                ...payload,
                lifecycle: prepared.facts.outcome.lifecycle,
                facts: prepared.facts.outcome,
                reason: prepared.facts.outcome.reason,
                run_facts: prepared.facts,
              },
              commit: prepared.commit,
              rollback: () => {
                prepared.rollback();
                canonicalOutcome = null;
              },
            };
          } catch (error) {
            // A contradictory terminal projection must fail the run, not throw
            // out of the hook and retry the same contradiction forever.
            const detail = redactSecrets(error instanceof Error ? error.message : String(error));
            terminalPreparationError = `terminal facts preparation failed: ${detail}`;
            const failureOutcome = makeOutcomeFacts("failed", {
              reason: "harness_failed",
            });
            let failureRefWritten = false;
            try {
              a.store.writeText(
                join(a.paths.finalDir, "summary.md"),
                `# Run ${a.runId} (${a.mode})\n\n- Lifecycle: failed\n- Phase: terminal_facts\n\n${terminalPreparationError}\n`,
              );
              writeFailure(a.store, a.paths, {
                phase: "terminal_facts",
                category: "internal",
                safeMessage: terminalPreparationError,
                runDir: a.paths.root,
                nextActions: ["Open diagnostics", "Inspect final/run_facts.yaml", "Retry the run"],
              });
              failureRefWritten = true;
            } catch {
              /* terminal event remains the fail-closed authority */
            }
            try {
              const prepared = prepareRunFactsFailureReceipt(a, failureOutcome);
              canonicalOutcome = prepared.facts.outcome;
              return {
                type: "run.failed",
                payload: {
                  lifecycle: prepared.facts.outcome.lifecycle,
                  facts: prepared.facts.outcome,
                  reason: prepared.facts.outcome.reason,
                  run_facts: prepared.facts,
                  phase: "terminal_facts",
                  error: terminalPreparationError,
                  ...(failureRefWritten ? { failure_ref: "final/failure.yaml" } : {}),
                },
                commit: prepared.commit,
                rollback: () => {
                  prepared.rollback();
                  canonicalOutcome = null;
                },
              };
            } catch {
              // If even the minimal receipt cannot be written, still commit an
              // honest failed terminal. The daemon job state then fails closed.
              canonicalOutcome = failureOutcome;
              return {
                type: "run.failed",
                payload: {
                  lifecycle: failureOutcome.lifecycle,
                  facts: failureOutcome,
                  reason: failureOutcome.reason,
                  phase: "terminal_facts",
                  error: terminalPreparationError,
                  ...(failureRefWritten ? { failure_ref: "final/failure.yaml" } : {}),
                },
              };
            }
          }
        });
      });
      preparedResult = result;
      const context = announced as AnnouncedRunContext | null;
      if (context) {
        await runBarrier(context);
        const budget = settledBudgetSnapshot(context);
        const delegateBarrierArmed = ownsDelegateDrain(context);
        if (delegateBarrierArmed && signal?.aborted) {
          context.log.clearDeferredTerminal();
          const cancelFacts = terminalOutcomeFacts(
            result.facts,
            "cancelled",
            signal.reason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
          );
          const cancelSummary =
            signal.reason === "wall_clock_exceeded"
              ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
              : "run cancelled";
          let reconciledCancelFacts = cancelFacts;
          try {
            reconcileDecisionBudget(context, budget);
            reconciledCancelFacts = reconcileDecisionTerminal(context, {
              facts: cancelFacts,
              why: cancelSummary,
              preparedFacts: result.facts,
            });
            reconcileWorkProductTerminal(context, reconciledCancelFacts);
            clearFailureArtifact(context);
          } catch {
            /* the cancellation terminal below remains authoritative */
          }
          const cancelled = cancelledResult(
            context.log,
            context.runId,
            context.taskId,
            context.mode,
            context.paths.root,
            result.candidates,
            undefined,
            budget.spendUsd,
            signal,
            context.store,
            reconciledCancelFacts,
          );
          context.log.flushDeferredTerminal();
          result = {
            ...result,
            lifecycle: "cancelled",
            facts: cancelled.facts,
            summary: cancelled.summary,
            spendUsd: cancelled.spendUsd,
            ...(cancelled.cancelReason ? { cancelReason: cancelled.cancelReason } : {}),
          };
        } else {
          const budgetTerminal = delegateBarrierArmed ? (context.budgetTerminal?.() ?? null) : null;
          if (budgetTerminal && result.lifecycle === "succeeded") {
            context.log.clearDeferredTerminal();
            result = postDrainBudgetFailure(context, budgetTerminal, budget, result);
            context.log.flushDeferredTerminal();
          } else {
            if (delegateBarrierArmed) reconcileDecisionBudget(context, budget);
            context.log.flushDeferredTerminal();
            if (budget.spendUsd !== null) result = { ...result, spendUsd: budget.spendUsd };
          }
        }
      }
    } catch (err) {
      // TS cannot see the closure assignment; the cast is safe (set-once).
      const a = announced as AnnouncedRunContext | null;
      if (!a) throw err;
      // The partition journal already owns this terminal. A safety-net emit
      // would hit the poisoned writer, erase the typed recovery signal, and
      // let the daemon persist a false generic failure over durable truth.
      if (isTerminalRecoveryRequired(err)) throw err;
      if (a.log.terminalCommitted()) {
        const outcome = canonicalOutcome ?? committedOutcome(a);
        if (!outcome) throw err;
        const spendUsd = settledSpend(a);
        result = preparedResult
          ? {
              ...preparedResult,
              lifecycle: outcome.lifecycle,
              facts: outcome,
              ...(spendUsd !== null ? { spendUsd } : {}),
            }
          : committedResult(a, outcome, spendUsd);
      } else {
        a.log.clearDeferredTerminal();
        let terminalError = err;
        try {
          await runBarrier(a);
        } catch (barrierError) {
          terminalError = barrierError;
        }
        // Settled-spend accounting is part of the terminal contract on EVERY
        // path (the orchestrate executor aggregates it); a broken spend snapshot
        // must not mask the original failure, so it degrades to null loudly-typed.
        const budget = settledBudgetSnapshot(a);
        const spendUsd = budget.spendUsd;
        const delegateBarrierArmed = ownsDelegateDrain(a);
        if (signal?.aborted && terminalError === err) {
          const priorFacts = preparedResult?.facts;
          const cancelFacts = terminalOutcomeFacts(
            priorFacts,
            "cancelled",
            signal.reason === "wall_clock_exceeded" ? "wall_clock_exceeded" : "user_cancelled",
          );
          const cancelSummary =
            signal.reason === "wall_clock_exceeded"
              ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
              : "run cancelled";
          let reconciledCancelFacts = cancelFacts;
          try {
            if (delegateBarrierArmed) reconcileDecisionBudget(a, budget);
            reconciledCancelFacts = reconcileDecisionTerminal(a, {
              facts: cancelFacts,
              why: cancelSummary,
              ...(preparedResult ? { preparedFacts: preparedResult.facts } : {}),
            });
            reconcileWorkProductTerminal(a, reconciledCancelFacts);
            clearFailureArtifact(a);
          } catch {
            /* the cancellation terminal below remains authoritative */
          }
          const cancelled = cancelledResult(
            a.log,
            a.runId,
            a.taskId,
            a.mode,
            a.paths.root,
            preparedResult?.candidates ?? [],
            undefined,
            spendUsd,
            // A wall-clock abort surfaced as a throw must keep its reason and
            // materialize the diagnostic summary, exactly like the checkpoint paths.
            signal,
            a.store,
            reconciledCancelFacts,
          );
          a.log.flushDeferredTerminal();
          result = preparedResult
            ? {
                ...preparedResult,
                lifecycle: "cancelled",
                facts: cancelled.facts,
                summary: cancelled.summary,
                spendUsd: cancelled.spendUsd,
                ...(cancelled.cancelReason ? { cancelReason: cancelled.cancelReason } : {}),
              }
            : cancelled;
        } else {
          const priorFacts = preparedResult?.facts;
          const pendingFacts = terminalOutcomeFacts(priorFacts, "failed", "harness_failed");
          const pendingSummary = redactSecrets(
            terminalError instanceof Error ? terminalError.message : String(terminalError),
          );
          let reconciledFailureFacts = pendingFacts;
          try {
            if (delegateBarrierArmed) reconcileDecisionBudget(a, budget);
            reconciledFailureFacts = reconcileDecisionTerminal(a, {
              facts: pendingFacts,
              why: pendingSummary,
              ...(preparedResult ? { preparedFacts: preparedResult.facts } : {}),
            });
            reconcileWorkProductTerminal(a, reconciledFailureFacts);
          } catch {
            /* the failure terminal below remains authoritative */
          }
          const failed = failTerminally(
            a.log,
            a.store,
            a.paths,
            a.runId,
            a.taskId,
            a.mode,
            barrierFailed ? "delegation_drain" : a.phase,
            terminalError,
            spendUsd,
            { priorFacts: reconciledFailureFacts },
          );
          a.log.flushDeferredTerminal();
          result = preparedResult
            ? {
                ...preparedResult,
                lifecycle: "failed",
                facts: failed.facts,
                summary: failed.summary,
                spendUsd: failed.spendUsd,
              }
            : failed;
        }
      }
    }
    // Defensive fallback for a strategy that returned without a terminal emit:
    // materialize/announce a summary when needed, then pass through the same
    // pre-terminal receipt transaction as every normal strategy.
    const a = announced as AnnouncedRunContext | null;
    if (a && !a.log.terminalCommitted()) {
      const events = a.log.readAll().events;
      if (!events.some((event) => event.type === "output.ready")) {
        const summaryPath = join(a.paths.finalDir, "summary.md");
        let summaryPresent = readTextSafe(summaryPath) !== null;
        if (!summaryPresent) {
          try {
            a.store.writeText(
              summaryPath,
              `# Run ${a.runId} (${a.mode})\n\n${redactSecrets(result.summary)}\n`,
            );
            summaryPresent = true;
          } catch {
            /* never point output.ready at a file that did not materialize */
          }
        }
        if (summaryPresent) {
          a.log.emit("output.ready", {
            kind: "summary",
            path: "final/summary.md",
            state: "diagnostic",
          });
        }
      }
      a.log.emit(terminalEventTypeFor("run.completed", result.facts), {
        lifecycle: result.facts.lifecycle,
        facts: result.facts,
        reason: result.facts.reason,
      });
    }
    // TS cannot see assignments performed inside EventLog's hook closure.
    const settledOutcome = canonicalOutcome as RunOutcomeFactsType | null;
    if (settledOutcome) {
      result = {
        ...result,
        lifecycle: settledOutcome.lifecycle,
        facts: settledOutcome,
        ...(terminalPreparationError ? { winner: null, summary: terminalPreparationError } : {}),
      };
    }
    return result;
  } finally {
    // Release per-run engine state on EVERY terminal path (normal return, failure
    // net, cancel), but only for a run that actually announced a runId.
    const settled = announced as AnnouncedRunContext | null;
    if (settled) await onSettled?.(settled.runId);
  }
}
