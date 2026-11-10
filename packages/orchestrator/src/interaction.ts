/**
 * Per-attempt interaction channel. Emits the typed lifecycle events
 * (`interaction.requested` / `interaction.answered` / `interaction.timeout` /
 * `interaction.withdrawn`) around the caller-provided answer surface. The wait
 * policy is finite or has automatic expiry disabled; answers, cancellation,
 * terminal cleanup, and registry release still end either form. Undefined
 * when the caller provides no surface — the adapter then runs non-interactive.
 *
 * Delivery: a blocking request suspends the inactivity watchdog while it waits
 * (the agent's tool call is held on the human). An async request does not: the
 * agent keeps working, so its stream must keep proving progress, and the
 * adapter consumes the eventual answer without holding its event pump on it.
 * Every lifecycle event carries the request's delivery.
 *
 * Outcomes stay distinct: answers resolve the request; an explicit decline, an
 * expiry (`interaction.timeout`), a withdrawal (`interaction.withdrawn`) or the
 * run's end resolves null; a failed answer surface rejects with
 * InteractionChannelError, never a decline-shaped null. A journal that cannot
 * append `interaction.requested` rejects the request with its own error, after
 * the surface's registration was withdrawn through the request's signal.
 *
 * Capability gate: the channel is OFFERED only to routes whose manifest
 * declares `interactive` — a non-interactive harness never gets a surface it
 * cannot raise questions through.
 */
import { InteractionChannelError, type InteractionChannel } from "@claudexor/core";
import type {
  InteractionAnswerSet,
  InteractionHandlerRelease,
  InteractionHandlerResult,
  InteractionRequest,
} from "@claudexor/schema";
import { INTERACTION_TIMEOUT_MAX_MS } from "@claudexor/schema";
import type { EventLog } from "@claudexor/event-log";
import { nowIso } from "@claudexor/util";
import type { PendingInteractionContext } from "./orchestrator.js";

export interface InteractionChannelWiring {
  onInteraction?: (ctx: PendingInteractionContext) => Promise<InteractionHandlerResult>;
  interactionTimeoutMs?: number | null;
  signal?: AbortSignal;
}

export type InteractionTimeoutPolicy = { kind: "finite"; timeoutMs: number } | { kind: "disabled" };

export function resolveInteractionTimeoutPolicy(
  configured: number | null | undefined,
  defaultTimeoutMs: number,
): InteractionTimeoutPolicy {
  const value = configured === undefined ? defaultTimeoutMs : configured;
  if (value === null) return { kind: "disabled" };
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("interaction timeout must be a positive safe integer or null");
  }
  if (value > INTERACTION_TIMEOUT_MAX_MS) {
    throw new Error("interaction timeout exceeds the supported maximum");
  }
  return { kind: "finite", timeoutMs: value };
}

/** Default wait for one interactive answer before a benign decline. */
const DEFAULT_INTERACTION_TIMEOUT_MS = 900_000;

export function interactionChannelFor(
  input: InteractionChannelWiring,
  log: EventLog,
  runId: string,
  taskId: string,
  attemptId: string,
  harnessId: string,
  // REQUIRED (no default): every call site must state the routed manifest's
  // `interactive` capability, or a future site would silently bypass the gate.
  supportsInteractive: boolean,
  defaultTimeoutMs = DEFAULT_INTERACTION_TIMEOUT_MS,
): InteractionChannel | undefined {
  if (!supportsInteractive) return undefined;
  const handler = input.onInteraction;
  if (!handler) return undefined;
  const timeoutPolicy = resolveInteractionTimeoutPolicy(
    input.interactionTimeoutMs,
    defaultTimeoutMs,
  );
  // Waiting on a human is legitimate stream silence: the inactivity watchdog
  // consults this count and re-arms instead of killing the "wedged" harness.
  let pending = 0;
  let suspensionVersion = 0;
  return {
    pendingCount: () => pending,
    suspensionVersion: () => suspensionVersion,
    request: async (
      request: InteractionRequest,
      signal?: AbortSignal,
    ): Promise<InteractionAnswerSet | null> => {
      if (signal?.aborted) return null;
      const requestedAt = nowIso();
      const deadlineAtMs =
        timeoutPolicy.kind === "finite" ? finiteDeadline(timeoutPolicy.timeoutMs) : null;
      const timeoutAt = deadlineAtMs === null ? null : new Date(deadlineAtMs).toISOString();
      // Absent delivery keeps the historical meaning: the agent waits. The
      // answer surface persists exactly what this channel announces.
      const delivery = request.delivery === "async" ? "async" : "blocking";
      const asked: InteractionRequest =
        request.delivery === delivery ? request : { ...request, delivery };
      // Only a blocking question is legitimate stream silence.
      const suspends = delivery === "blocking";
      // The surface's runtime handle on this request: the asking harness's
      // withdrawal, or the channel's own release of a question it could not
      // announce. Composed rather than listening on the harness's signal, so a
      // withdrawal still reaches the surface after this wait has settled.
      const release = new AbortController();
      const surfaceSignal = signal ? AbortSignal.any([signal, release.signal]) : release.signal;
      if (suspends) {
        pending += 1;
        suspensionVersion += 1;
      }
      try {
        // Invoke the answer surface BEFORE announcing the event: handlers
        // register the pending question synchronously (daemon
        // InteractionRegistry), so any subscriber that reacts to
        // interaction.requested — `claudexor follow` checks pendingInteractions
        // before prompting — finds the registry already populated. The reverse
        // order would make that guarantee depend on event-loop timing.
        // The handler is invoked SYNCHRONOUSLY (the registry-population contract
        // below depends on it). Its failure is the answer surface failing, never
        // the user's decline: a synchronous throw registered nothing, so no
        // question is announced; a later rejection ends the wait. Both reject
        // this request with InteractionChannelError after the same cleanup.
        let answersPromise: Promise<HandlerOutcome>;
        try {
          answersPromise = Promise.resolve(
            handler({
              runId,
              taskId,
              attemptId,
              harnessId,
              request: asked,
              requestedAt,
              timeoutAt,
              signal: surfaceSignal,
            }),
          ).then(
            (result): HandlerOutcome => ({ kind: "handler", result }),
            (error: unknown): HandlerOutcome => ({ kind: "failed", error }),
          );
        } catch (error) {
          throw new InteractionChannelError(error);
        }
        try {
          log.emit("interaction.requested", {
            interaction_id: request.interaction_id,
            attempt_id: attemptId,
            harness_id: harnessId,
            source_tool: request.source_tool,
            questions: request.questions,
            requested_at: requestedAt,
            timeout_at: timeoutAt,
            delivery,
          });
        } catch (error) {
          // The surface already registered a question nobody was told about,
          // and this request fails here: an answer could never reach the
          // harness. Withdraw it through the request lifecycle the surface
          // honours (the daemon registry releases it as interrupted), then
          // fail with the journal's own error. The record stays missing, so
          // the failure stays a failure.
          release.abort(error);
          throw error;
        }
        let cancelTimer: (() => void) | undefined;
        let onAbort: (() => void) | undefined;
        let onRequestAbort: (() => void) | undefined;
        const startedWaiting = Date.now();
        const discloseDiscardedAnswer = (
          reason: "run_cancelled" | "request_withdrawn" | "timed_out",
        ) =>
          void answersPromise
            .then((outcome) => {
              const late = outcome.kind === "handler" ? outcome.result : null;
              if (late && !isInteractionHandlerRelease(late) && late.answers.length > 0) {
                log.emit("interaction.answer_discarded", {
                  interaction_id: request.interaction_id,
                  attempt_id: attemptId,
                  harness_id: harnessId,
                  answer_count: late.answers.length,
                  reason,
                  delivery,
                });
              }
            })
            .catch(() => undefined);
        type WaitResult =
          HandlerOutcome | { kind: "timeout" } | { kind: "abort" } | { kind: "request_abort" };
        const waits: Promise<WaitResult>[] = [
          answersPromise,
          // A cancelled run must release the interaction wait IMMEDIATELY —
          // the abort already kills the harness process, and neither a finite
          // nor disabled-expiry policy may park a dead run in waiting_on_user.
          new Promise<WaitResult>((resolve) => {
            if (!input.signal) return;
            if (input.signal.aborted) return resolve({ kind: "abort" });
            onAbort = () => resolve({ kind: "abort" });
            input.signal.addEventListener("abort", onAbort, { once: true });
          }),
          new Promise<WaitResult>((resolve) => {
            if (!signal) return;
            if (signal.aborted) return resolve({ kind: "request_abort" });
            onRequestAbort = () => resolve({ kind: "request_abort" });
            signal.addEventListener("abort", onRequestAbort, { once: true });
          }),
        ];
        if (deadlineAtMs !== null) {
          waits.push(
            new Promise<WaitResult>((resolve) => {
              cancelTimer = scheduleSafeDeadline(deadlineAtMs, () => resolve({ kind: "timeout" }));
            }),
          );
        }
        const result = await Promise.race(waits);
        cancelTimer?.();
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        if (onRequestAbort) signal?.removeEventListener("abort", onRequestAbort);
        if (result.kind === "failed") {
          // A run already being cancelled keeps that truth; otherwise the
          // adapter learns the surface failed, with its cause.
          if (input.signal?.aborted) return null;
          throw new InteractionChannelError(result.error);
        }
        // The asking harness withdrew this exact request (e.g. Codex
        // serverRequest/resolved). The request signal and the registry's
        // `interrupted` release fire in the same abort dispatch, so either may
        // win the race; both are one withdrawal. Announce it so every surface
        // that opened an answer prompt closes it — under a disabled expiry an
        // unclosed prompt would block every later question. Neither an expiry
        // nor a run cancellation, so it never borrows interaction.timeout.
        if (
          result.kind === "request_abort" ||
          (result.kind === "handler" &&
            isInteractionHandlerRelease(result.result) &&
            result.result.reason === "interrupted")
        ) {
          // Adapter cancellation revokes request signals before the channel's
          // run-abort listener can win the race. Preserve the outer cause.
          if (input.signal?.aborted) {
            discloseDiscardedAnswer("run_cancelled");
            return null;
          }
          log.emit("interaction.withdrawn", {
            interaction_id: request.interaction_id,
            attempt_id: attemptId,
            harness_id: harnessId,
            delivery,
          });
          // An answer the registry accepted in the same tick never reaches the
          // harness; disclose it instead of letting "delivered" stand silently.
          discloseDiscardedAnswer("request_withdrawn");
          return null;
        }
        // Run cancellation has its own terminal event and is not an expired
        // answer window. Emitting interaction.timeout here makes downstream
        // surfaces briefly claim a benign timeout before the cancellation
        // truth arrives.
        if (result.kind === "abort") {
          // Preserve late-answer honesty without fabricating an expiry. The
          // registry may still deliver an answer racing the run cancellation;
          // disclose that it was discarded for the actual terminal cause.
          discloseDiscardedAnswer("run_cancelled");
          return null;
        }
        const handlerResult = result.kind === "handler" ? result.result : null;
        const answers = isInteractionHandlerRelease(handlerResult) ? null : handlerResult;
        if (answers && answers.answers.length > 0) {
          log.emit("interaction.answered", {
            interaction_id: request.interaction_id,
            attempt_id: attemptId,
            harness_id: harnessId,
            answer_count: answers.answers.length,
            delivery,
          });
          return answers;
        }
        // An untyped external null or a run-terminal registry release is a
        // decline, not an automatic expiry. The daemon tags only its own
        // finite expiry so that race can retain exact provenance.
        if (
          result.kind === "handler" &&
          (!isInteractionHandlerRelease(handlerResult) ||
            handlerResult.reason !== "timeout" ||
            deadlineAtMs === null)
        ) {
          return null;
        }
        log.emit("interaction.timeout", {
          interaction_id: request.interaction_id,
          attempt_id: attemptId,
          harness_id: harnessId,
          waited_ms: Date.now() - startedWaiting,
          delivery,
        });
        // Late-answer honesty: the run already declined this
        // interaction; an answer arriving AFTER the timeout must be visibly
        // DISCARDED, not silently swallowed (the user typed it in good faith).
        discloseDiscardedAnswer("timed_out");
        return null;
      } finally {
        // ALWAYS release the suspension: a synchronous handler throw or a
        // log.emit failure must not leave the watchdog suspended forever.
        if (suspends) {
          pending -= 1;
          suspensionVersion += 1;
        }
      }
    },
  };
}

type HandlerOutcome =
  { kind: "handler"; result: InteractionHandlerResult } | { kind: "failed"; error: unknown };

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_DATE_MS = 8_640_000_000_000_000;

function finiteDeadline(timeoutMs: number): number {
  const deadline = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(deadline) || deadline > MAX_DATE_MS) {
    throw new Error("interaction timeout is too large to represent as a deadline");
  }
  return deadline;
}

/** Node clamps one setTimeout above 2^31-1 ms to ~1 ms. Re-arm in bounded
 * chunks so a large valid finite policy cannot expire immediately. */
function scheduleSafeDeadline(deadline: number, fire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      fire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  };
  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

function isInteractionHandlerRelease(
  result: InteractionHandlerResult,
): result is InteractionHandlerRelease {
  return result !== null && "kind" in result && result.kind === "released";
}
