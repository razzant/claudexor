/**
 * Per-attempt interaction channel. Emits the typed lifecycle events
 * (`interaction.requested` / `interaction.answered` / `interaction.timeout`)
 * around the caller-provided answer surface, enforcing the wait budget so a
 * run can never hang forever on an unanswered question. Undefined when the
 * caller provides no surface — the adapter then runs non-interactive.
 *
 * Capability gate (A2): the channel is OFFERED only to routes whose manifest
 * declares `interactive` — a non-interactive harness never gets a surface it
 * cannot raise questions through.
 */
import type { InteractionChannel } from "@claudexor/core";
import type { InteractionAnswerSet, InteractionRequest } from "@claudexor/schema";
import type { EventLog } from "@claudexor/event-log";
import { nowIso } from "@claudexor/util";
import type { PendingInteractionContext } from "./orchestrator.js";

export interface InteractionChannelWiring {
  onInteraction?: (ctx: PendingInteractionContext) => Promise<InteractionAnswerSet | null>;
  interactionTimeoutMs?: number;
  signal?: AbortSignal;
}

export function interactionChannelFor(
  input: InteractionChannelWiring,
  log: EventLog,
  runId: string,
  taskId: string,
  attemptId: string,
  harnessId: string,
  supportsInteractive: boolean,
  defaultTimeoutMs: number,
): InteractionChannel | undefined {
  if (!supportsInteractive) return undefined;
  const handler = input.onInteraction;
  if (!handler) return undefined;
  const timeoutMs = input.interactionTimeoutMs ?? defaultTimeoutMs;
  // Waiting on a human is legitimate stream silence: the inactivity watchdog
  // consults this count and re-arms instead of killing the "wedged" harness.
  let pending = 0;
  return {
    pendingCount: () => pending,
    request: async (request: InteractionRequest): Promise<InteractionAnswerSet | null> => {
      const requestedAt = nowIso();
      const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
      pending += 1;
      // Invoke the answer surface BEFORE announcing the event: handlers
      // register the pending question synchronously (daemon
      // InteractionRegistry), so any subscriber that reacts to
      // interaction.requested — `claudexor follow` checks pendingInteractions
      // before prompting — finds the registry already populated. The reverse
      // order would make that guarantee depend on event-loop timing.
      const answersPromise = handler({
        runId,
        taskId,
        attemptId,
        harnessId,
        request,
        requestedAt,
        timeoutAt,
      }).catch(() => null);
      log.emit("interaction.requested", {
        interaction_id: request.interaction_id,
        attempt_id: attemptId,
        harness_id: harnessId,
        source_tool: request.source_tool,
        questions: request.questions,
        requested_at: requestedAt,
        timeout_at: timeoutAt,
      });
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const startedWaiting = Date.now();
      const answers = await Promise.race([
        answersPromise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
        // A cancelled run must release the interaction wait IMMEDIATELY —
        // the abort already kills the harness process, and sitting out the
        // remaining timeout would park a dead run in waiting_on_user.
        new Promise<null>((resolve) => {
          if (!input.signal) return;
          if (input.signal.aborted) return resolve(null);
          onAbort = () => resolve(null);
          input.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (onAbort) input.signal?.removeEventListener("abort", onAbort);
      pending -= 1;
      if (answers && answers.answers.length > 0) {
        log.emit("interaction.answered", {
          interaction_id: request.interaction_id,
          attempt_id: attemptId,
          harness_id: harnessId,
          answer_count: answers.answers.length,
        });
        return answers;
      }
      log.emit("interaction.timeout", {
        interaction_id: request.interaction_id,
        attempt_id: attemptId,
        harness_id: harnessId,
        waited_ms: Date.now() - startedWaiting,
        ...(input.signal?.aborted ? { reason: "cancelled" } : {}),
      });
      // Late-answer honesty (T2#23): the run already declined this
      // interaction; an answer arriving AFTER the timeout must be visibly
      // DISCARDED, not silently swallowed (the user typed it in good faith).
      void answersPromise.then((late) => {
        if (late && late.answers.length > 0) {
          log.emit("interaction.answer_discarded", {
            interaction_id: request.interaction_id,
            attempt_id: attemptId,
            harness_id: harnessId,
            answer_count: late.answers.length,
            reason: input.signal?.aborted ? "run_cancelled" : "timed_out",
          });
        }
      });
      return null;
    },
  };
}
