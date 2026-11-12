import { ControlProblem } from "@claudexor/schema";
import { controlApiFetch, type ControlApiAddress } from "./live.js";

/** The answer route's typed refusal of this exact answer (`context.status`). */
async function definitelyRejected(response: Response): Promise<boolean> {
  const problem = ControlProblem.safeParse(await response.json().catch(() => null));
  return problem.success && problem.data.context["status"] === "rejected";
}

/** A poll-tick bridge that the runner closes when it stops observing the run. */
export type InteractionBridge = ((info: { runId: string }) => Promise<void>) & {
  /** Close every prompt still open (terminal, cancellation, failure) and drop
   * every answer kept for a retry; later ticks do nothing. */
  close(): void;
};

type BridgePending = {
  interactionId: string;
  questions?: unknown[];
  timeoutAt?: string | null;
  delivery?: string;
};

/** A usable list names every question. Anything else is unknown, never an empty list. */
function pendingList(value: unknown): BridgePending[] | null {
  return Array.isArray(value) &&
    value.every((row) => typeof row?.interactionId === "string" && row.interactionId !== "")
    ? (value as BridgePending[])
    : null;
}

/**
 * Poll-tick bridge: watch the run's pendingInteractions on the control API and
 * forward each NEW interaction to the caller's hook exactly once; answers go
 * back through the typed answer endpoint. A stale answer (engine already
 * timed out and declined) is the endpoint's problem to refuse — the bridge
 * never fakes delivery. A failed post is retried with the same answer, except
 * a definite `rejected` refusal: the daemon committed nothing and would refuse
 * the same body again, so the bridge stops there and the question stays
 * pending for another surface or its expiry. An answer is kept for that retry
 * only while its question is pending: a read that returns a list without it, or
 * close, drops it. A read that fails or carries no usable list proves nothing:
 * it keeps the answer and leaves open prompts open.
 *
 * Every prompt runs beside the poll loop: waiting on a person, or on a hook
 * that never settles, cannot stop the runner observing cancellation, status and
 * the terminal. Delivery says only what the agent does meanwhile: a blocking
 * question still parks it. Blocking questions are asked first and one at a
 * time, nothing new opens behind one, and an open async prompt never holds one
 * back. A prompt's signal aborts once its question is no longer pending, the
 * caller cancels or the bridge closes; an aborted prompt posts nothing and no
 * longer holds the next question, even if its hook never settles.
 *
 * A blocking prompt's failure fails the next tick, so the runner reports it and
 * stops observing. An async prompt that fails is not asked again and posts
 * nothing: the question stays pending for another surface or its expiry while
 * the agent keeps working.
 */
export function makeInteractionBridge(
  addr: ControlApiAddress,
  onInteraction: (ctx: any) => Promise<any | null>,
  callerSignal?: AbortSignal,
): InteractionBridge {
  const delivered = new Set<string>();
  const answerCache = new Map<string, any | null>();
  const openPrompts = new Map<string, AbortController>();
  let blockingPrompt: AbortController | null = null;
  let blockingFailure: { error: unknown } | null = null;
  let lastCheck = 0;
  let closed = false;
  const handle = async (runId: string, pi: BridgePending, id: string, signal: AbortSignal) => {
    const result = answerCache.has(id)
      ? answerCache.get(id)
      : await onInteraction({
          run_id: runId,
          request: {
            interaction_id: id,
            questions: Array.isArray(pi.questions) ? pi.questions : [],
            delivery: pi.delivery === "async" ? "async" : "blocking",
          },
          ...(Object.hasOwn(pi, "timeoutAt") ? { timeoutAt: pi.timeoutAt } : {}),
          signal,
        });
    // A closed prompt's question was resolved elsewhere or the run ended:
    // posting now could only be refused, and it is never re-asked.
    if (signal.aborted) {
      delivered.add(id);
      answerCache.delete(id);
      return;
    }
    answerCache.set(id, result);
    const answers = result && Array.isArray(result.answers) ? result.answers : null;
    if (answers) {
      const response = await controlApiFetch(
        addr,
        `/runs/${encodeURIComponent(runId)}/interactions/${encodeURIComponent(id)}/answer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            answers: answers.map((a: any) => ({
              questionId: a.question_id,
              selectedLabels: a.selected_labels ?? [],
              ...(a.free_text ? { freeText: a.free_text } : {}),
            })),
          }),
        },
      ).catch(() => null);
      if (response?.ok || (response && (await definitelyRejected(response)))) {
        delivered.add(id);
        answerCache.delete(id);
      }
    } else {
      // A deliberate decline has no answer mutation to acknowledge.
      delivered.add(id);
      answerCache.delete(id);
    }
  };
  const bridge = async ({ runId }: { runId: string }) => {
    if (closed) return;
    if (blockingFailure) {
      const { error } = blockingFailure;
      blockingFailure = null;
      throw error;
    }
    if (Date.now() - lastCheck < 1_000) return;
    lastCheck = Date.now();
    let pending: BridgePending[] | null;
    try {
      const res = await controlApiFetch(addr, `/runs/${encodeURIComponent(runId)}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) return;
      const detail = (await res.json()) as { pendingInteractions?: unknown };
      pending = pendingList(detail.pendingInteractions);
    } catch {
      return; // transient control-api hiccup: the next tick retries
    }
    // Only a successfully read list can withdraw a question; an unknown one
    // leaves open prompts and kept answers alone until a later read can say.
    if (!pending) return;
    const stillPending = new Set(pending.map((pi) => pi.interactionId));
    for (const [id, controller] of openPrompts)
      if (!stillPending.has(id)) controller.abort({ kind: "interaction_resolved" });
    // An answer to a question off the list can no longer be delivered, and must
    // not be replayed if the id is listed again. It is not marked delivered: if
    // the question does come back, it is asked again rather than left unanswered.
    for (const id of answerCache.keys()) if (!stillPending.has(id)) answerCache.delete(id);
    const ordered = [
      ...pending.filter((pi) => pi.delivery !== "async"),
      ...pending.filter((pi) => pi.delivery === "async"),
    ];
    for (const pi of ordered) {
      const id = pi.interactionId;
      if (delivered.has(id) || openPrompts.has(id) || closed) continue;
      // An open blocking prompt goes alone; whatever is listed behind it waits.
      if (blockingPrompt && !blockingPrompt.signal.aborted) break;
      const blocking = pi.delivery !== "async";
      const controller = new AbortController();
      openPrompts.set(id, controller);
      if (blocking) blockingPrompt = controller;
      void handle(runId, pi, id, controller.signal)
        .catch((error: unknown) => {
          if (blocking && !controller.signal.aborted) {
            // The agent is held on this prompt: the failure is the runner's.
            blockingFailure = { error };
            return;
          }
          // The prompt failed. It may still have shown the question, so it
          // is not asked again, and it obtained nothing to post: neither an
          // answer nor a decline. A lost reply to an obtained answer is not
          // this path; that answer stays cached for the same-body retry.
          delivered.add(id);
          answerCache.delete(id);
        })
        .finally(() => {
          if (openPrompts.get(id) === controller) openPrompts.delete(id);
          if (blockingPrompt === controller) blockingPrompt = null;
        });
    }
  };
  const close = () => {
    closed = true;
    callerSignal?.removeEventListener("abort", close);
    for (const controller of openPrompts.values()) controller.abort({ kind: "bridge_closed" });
    answerCache.clear();
  };
  if (callerSignal?.aborted) close();
  else callerSignal?.addEventListener("abort", close, { once: true });
  return Object.assign(bridge, { close });
}
