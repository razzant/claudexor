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
  RunOutcomeFacts,
  type RunOutcomeFacts as RunOutcomeFactsType,
} from "@claudexor/schema";
import { orderedAppender, readTextSafe, redactSecrets } from "@claudexor/util";
import { reconcileDecisionBudget, settledBudgetSnapshot } from "./decisionBudget.js";
import {
  cancelReasonFromSignalToken,
  cancellationFacts,
  commitCancellation,
  committedOutcome,
  committedResult,
  commitNetTerminal,
  type CommittedCancellation,
  isTerminalRecoveryRequired,
  ownsDelegateDrain,
  postDrainBudgetFailure,
  settledSpend,
  terminalEventTypeFor,
  terminalFactsFailure,
  terminalOutcomeFromPayload,
} from "./runTerminalHelpers.js";
import { reconcileDecisionTerminal } from "./decisionTerminalReconciliation.js";
import type { OrchestratorResult } from "./orchestrator.js";
import { prepareRunFactsFailureReceipt, prepareRunFactsReceipt } from "./runFacts.js";
import type { AnnouncedRunContext } from "./runTerminalContext.js";
import { flushContinuationTerminal } from "./continuation-custody.js";
import { namingRetainedOutput, publishRetainedOutput } from "./retainedOutput.js";
import {
  cancellationStatement,
  cancelledResult,
  declaredFailure,
  failTerminally,
  writeFailure,
} from "./runTerminalResults.js";
import {
  clearFailureArtifact,
  preparedCaptureFacts,
  reconcileWorkProductTerminal,
  terminalOutcomeFacts,
} from "./terminalOutcome.js";

export type { AnnouncedRunContext } from "./runTerminalContext.js";
export { cancelledResult, declaredFailure, failTerminally, writeFailure };
export { cancelReasonFromSignalToken } from "./runTerminalHelpers.js";

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
  let committedCancel: CommittedCancellation | null = null;
  let terminalPreparationError: string | null = null;
  /** The retained output this terminal's publication announced, if any. */
  let retainedOutputPath: string | null = null;
  let barrierAttempted = false;
  let barrierFailed = false;
  // The cancellation decision is frozen the moment the strategy's terminal is
  // held (the strategy returned): a host cancel or wall-clock abort that
  // arrives DURING the settlement barrier must not turn a completed run into
  // a cancelled one. Null until the strategy has returned.
  let abortedAtStrategyEnd: boolean | null = null;
  const cancellationDecided = (): boolean =>
    abortedAtStrategyEnd !== null ? abortedAtStrategyEnd : signal?.aborted === true;
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
  /** The barrier for a HELD terminal: true when it (already) succeeded. */
  let heldBarrierError: unknown = null;
  const barrierHeld = async (context: AnnouncedRunContext): Promise<boolean> => {
    try {
      await runBarrier(context);
      return true;
    } catch (error) {
      heldBarrierError = error;
      return false;
    }
  };
  /**
   * The held-terminal RECOVERY path (the strategy held its terminal, then
   * threw): for an ordinary run the cancellation decision is frozen NOW,
   * before its barrier, exactly as on the normal return — the verdict was
   * reached before any abort that lands during settlement. Delegate parents
   * keep the live signal through their child drain (the drain is their work).
   */
  const heldVerdictBarrier = async (context: AnnouncedRunContext): Promise<boolean> => {
    if (!ownsDelegateDrain(context)) abortedAtStrategyEnd = signal?.aborted === true;
    return barrierHeld(context);
  };
  /**
   * The failure net: the run's failed or cancelled terminal for `cause` (the
   * strategy's own throw, or a failed commit of its verdict), stamped instead
   * of orphaning the run, and committed even when a landing failure under the
   * run directory interrupts it (#704).
   */
  const failureNet = async (
    a: AnnouncedRunContext,
    cause: unknown,
  ): Promise<OrchestratorResult> => {
    a.log.clearDeferredTerminal();
    // What the run directory holds, or still has in flight, is consumed first:
    // a landing failure is stated by this terminal, never thrown out of the net.
    const lostEvents = await orderedAppender.settledUnder(a.paths.root).then(
      () => [],
      (error: unknown) => [error],
    );
    let terminalError = heldBarrierError ?? cause;
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
    if (signal?.aborted && terminalError === cause) {
      const priorFacts = preparedResult?.facts;
      const cancelFacts = terminalOutcomeFacts(
        priorFacts,
        "cancelled",
        cancelReasonFromSignalToken(signal.reason),
      );
      const cancelSummary =
        signal.reason === "wall_clock_exceeded"
          ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
          : "run cancelled";
      const attempts = a.attempts?.();
      // As on the Delegate cancel path: a kept capture-bearing record
      // carries the cancelled terminal's own statement.
      const statement = cancellationStatement(a.runId, a.mode, signal, attempts ?? []);
      let reconciledCancelFacts = cancelFacts;
      try {
        if (delegateBarrierArmed) reconcileDecisionBudget(a, budget);
        reconciledCancelFacts = reconcileDecisionTerminal(a, {
          facts: cancelFacts,
          why: cancelSummary,
          ...(preparedResult ? { preparedFacts: preparedResult.facts } : {}),
        });
        reconcileWorkProductTerminal(a, reconciledCancelFacts);
        clearFailureArtifact(a, { summary: statement.summary });
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
        undefined,
        attempts,
        lostEvents,
      );
      await commitNetTerminal(a, cancelled.facts);
      return preparedResult
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
        // Read before this terminal replaces the prepared record.
        {
          priorFacts: reconciledFailureFacts,
          ...preparedCaptureFacts(a),
          attempts: a.attempts?.(),
          lostEvents,
        },
      );
      await commitNetTerminal(a, failed.facts);
      return preparedResult
        ? {
            ...preparedResult,
            lifecycle: "failed",
            facts: failed.facts,
            summary: failed.summary,
            spendUsd: failed.spendUsd,
          }
        : failed;
    }
  };
  try {
    let result: OrchestratorResult;
    try {
      result = await body((a) => {
        announced = a;
        a.log.setBeforeTerminal(
          (originalType, payload) => {
            try {
              // Cancellation is decided here, once, when the terminal is
              // prepared: the verdict frozen at strategy end, or the signal
              // now for a terminal that drained Delegate work. A later abort,
              // also one arriving while the prepared bytes are staged, cannot
              // rewrite it.
              const payloadOutcome = terminalOutcomeFromPayload(payload);
              const terminalOutcome =
                cancellationDecided() && signal
                  ? cancellationFacts(signal, payloadOutcome)
                  : payloadOutcome;
              const prepared = prepareRunFactsReceipt(a, terminalOutcome);
              canonicalOutcome = prepared.facts.outcome;
              // A cancellation chosen here replaces the strategy's own verdict,
              // so the terminal states that cancellation instead.
              committedCancel =
                signal &&
                payloadOutcome.lifecycle !== "cancelled" &&
                prepared.facts.outcome.lifecycle === "cancelled"
                  ? commitCancellation(a, signal, payload)
                  : null;
              return {
                type: terminalEventTypeFor(originalType, prepared.facts.outcome),
                payload: {
                  ...(committedCancel?.payload ?? payload),
                  lifecycle: prepared.facts.outcome.lifecycle,
                  facts: prepared.facts.outcome,
                  reason: prepared.facts.outcome.reason,
                  run_facts: prepared.facts,
                },
                commit: prepared.commit,
                telemetry: prepared.telemetry,
                rollback: () => {
                  prepared.rollback();
                  canonicalOutcome = null;
                  committedCancel = null;
                },
              };
            } catch (error) {
              committedCancel = null;
              // A contradictory terminal projection must fail the run, not throw
              // out of the hook and retry the same contradiction forever.
              const detail = redactSecrets(error instanceof Error ? error.message : String(error));
              const history = terminalFactsFailure(a, detail);
              terminalPreparationError = history.message;
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
                  // Written after the publication: it names the announced
                  // retained output too, after its own cause.
                  ...(retainedOutputPath
                    ? namingRetainedOutput(terminalPreparationError, [], retainedOutputPath)
                    : { safeMessage: terminalPreparationError }),
                  poolAttempts: history.poolAttempts,
                  runDir: a.paths.root,
                  nextActions: [
                    "Open diagnostics",
                    "Inspect final/run_facts.yaml",
                    "Retry the run",
                  ],
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
                    pool_attempts: history.poolAttempts,
                    ...(failureRefWritten ? { failure_ref: "final/failure.yaml" } : {}),
                  },
                  commit: prepared.commit,
                  telemetry: prepared.telemetry,
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
                    pool_attempts: history.poolAttempts,
                    ...(failureRefWritten ? { failure_ref: "final/failure.yaml" } : {}),
                  },
                };
              }
            }
          },
          (_type, payload) => {
            const lifecycle =
              RunOutcomeFacts.safeParse(payload["facts"]).data?.lifecycle ?? payload["lifecycle"];
            const cancelled = cancellationDecided();
            retainedOutputPath = publishRetainedOutput(
              a,
              !cancelled && lifecycle === "succeeded",
              !cancelled && lifecycle === "failed",
            );
          },
        );
      });
      preparedResult = result;
      abortedAtStrategyEnd = signal?.aborted === true;
      const context = announced as AnnouncedRunContext | null;
      if (context) {
        await runBarrier(context);
        const budget = settledBudgetSnapshot(context);
        const delegateBarrierArmed = ownsDelegateDrain(context);
        // Delegate parents keep their explicit cancel branch on the LIVE
        // signal: a cancel that arrives while the child drain is still running
        // wins there (the drain is part of their work). The frozen decision
        // applies only to an ordinary run's held terminal.
        if (delegateBarrierArmed && signal?.aborted) {
          context.log.clearDeferredTerminal();
          const cancelFacts = terminalOutcomeFacts(
            result.facts,
            "cancelled",
            cancelReasonFromSignalToken(signal.reason),
          );
          const cancelSummary =
            signal.reason === "wall_clock_exceeded"
              ? "run cancelled: wall-clock deadline (maxSeconds) exceeded"
              : "run cancelled";
          const attempts = context.attempts?.();
          // A kept capture-bearing record is re-labelled with the same
          // statement the cancelled terminal below makes (cancel, then the
          // run's earlier failed tries).
          const statement = cancellationStatement(
            context.runId,
            context.mode,
            signal,
            attempts ?? [],
          );
          let reconciledCancelFacts = cancelFacts;
          try {
            reconcileDecisionBudget(context, budget);
            reconciledCancelFacts = reconcileDecisionTerminal(context, {
              facts: cancelFacts,
              why: cancelSummary,
              preparedFacts: result.facts,
            });
            reconcileWorkProductTerminal(context, reconciledCancelFacts);
            clearFailureArtifact(context, { summary: statement.summary });
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
            undefined,
            attempts,
          );
          await flushContinuationTerminal(context, cancelled.facts);
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
            await flushContinuationTerminal(context, result.facts);
          } else {
            if (delegateBarrierArmed) reconcileDecisionBudget(context, budget);
            await flushContinuationTerminal(context, result.facts);
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
      } else if (
        // Only a strategy that itself threw holds its own verdict here: a
        // terminal still held after the strategy returned is one whose commit
        // failed, and the failure net replaces it (#704).
        preparedResult === null &&
        a.log.deferredTerminalPending() &&
        !signal?.aborted &&
        !barrierFailed &&
        (await heldVerdictBarrier(a))
      ) {
        // The strategy already produced its terminal — held for the barrier
        // (INV-144: custody settles before the terminal is published) — and
        // then threw. Exactly like a committed terminal, its verdict stands
        // once the barrier itself succeeded: publish the held terminal and
        // keep its outcome. A FAILED barrier (a child drain that timed out)
        // falls through to the typed failure below, as before, and so does a
        // commit of the held verdict that failed (#704).
        const pending = a.log.deferredTerminalPending()!;
        const flushFailure = await flushContinuationTerminal(
          a,
          terminalOutcomeFromPayload(pending.payload),
        ).then(
          () => null,
          (error: unknown) => ({ error }),
        );
        if (
          flushFailure &&
          (isTerminalRecoveryRequired(flushFailure.error) || a.log.terminalCommitted())
        )
          throw flushFailure.error;
        if (flushFailure) result = await failureNet(a, flushFailure.error);
        else {
          const outcome = canonicalOutcome ?? committedOutcome(a);
          if (!outcome) throw err;
          result = committedResult(a, outcome, settledSpend(a));
        }
      } else result = await failureNet(a, err);
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
            await a.store.writeTextAsync(
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
      await a.log.emitTerminal(terminalEventTypeFor("run.completed", result.facts), {
        lifecycle: result.facts.lifecycle,
        facts: result.facts,
        reason: result.facts.reason,
      });
    }
    // TS cannot see assignments performed inside EventLog's hook closure.
    const settledOutcome = canonicalOutcome as RunOutcomeFactsType | null;
    const settledCancel = committedCancel as CommittedCancellation | null;
    if (settledOutcome) {
      result = {
        ...result,
        lifecycle: settledOutcome.lifecycle,
        facts: settledOutcome,
        ...(terminalPreparationError ? { winner: null, summary: terminalPreparationError } : {}),
        ...(settledCancel
          ? {
              summary: settledCancel.summary,
              ...(settledCancel.cancelReason ? { cancelReason: settledCancel.cancelReason } : {}),
            }
          : {}),
      };
    }
    return result;
  } finally {
    // Release per-run engine state on EVERY terminal path (normal return, failure
    // net, cancel), but only for a run that actually announced a runId.
    const settled = announced as AnnouncedRunContext | null;
    if (settled) {
      // A writer whose terminal never committed does not stay the path's live
      // writer (#704); a poisoned one stays its fence (`EventLog.dispose`).
      if (!settled.log.terminalCommitted()) settled.log.dispose();
      await onSettled?.(settled.runId);
    }
  }
}
