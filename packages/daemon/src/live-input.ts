import type {
  InteractionDelivery,
  LiveInputCapability,
  LiveMessageAdapterResult,
  LiveMessageDelivery,
  LiveMessageInput,
} from "@claudexor/schema";
import { safeProblemMessage } from "@claudexor/util";

/**
 * The slice of a harness adapter the registry needs: its id and the optional
 * live-input method (`HarnessAdapter.message`, declared beside `cancel`). Typed
 * structurally so the registry compiles against any adapter object; an adapter
 * without `message` answers `unsupported` without a native write.
 */
export interface LiveInputAdapter {
  readonly id: string;
  message?(
    sessionId: string,
    input: { messageId: string; text: string },
  ): Promise<LiveMessageAdapterResult>;
}

/**
 * One live agent attempt, registered by the orchestrator for the attempt's
 * lifetime (structural twin of the orchestrator's LiveAttemptContext).
 * `currentSessionId` is a LIVE getter: a native transient retry mints a new
 * session id per try, so a snapshot would steer a dead session.
 */
export interface LiveAttemptContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  currentSessionId: () => string | null;
  /** The harness's declared channel (capability profile `live_input`). */
  liveInput: LiveInputCapability;
  adapter: LiveInputAdapter;
  /** Thread turns are not steerable in v1 (the continuity packet would lose the message). */
  threadBound: boolean;
}

export interface LiveAttemptRegistration {
  /** Removes THIS registration only; a stale release cannot evict a replacement. */
  release(): void;
}

/**
 * In-process registry of live-input targets: runId → attemptId → attempt.
 * Steering lifetime is attempt-local: a native retry, convergence attempt,
 * Exact Retry or rerun never re-injects an earlier message. Durable truth lives
 * in the per-run event log (`message.*` rows) and the idempotency ledger; this
 * map only answers "who can receive a message right now".
 */
/** Terminal run ids remembered for the commit race (bounded; see dropForRun). */
const TERMINAL_MEMORY = 1024;

export class LiveInputRegistry {
  private readonly live = new Map<string, Map<string, LiveAttemptContext>>();
  private readonly terminal = new Set<string>();

  constructor(
    /** Pending rows; an absent delivery is a historical row and blocks. */
    private readonly interactions: {
      pendingForRun(runId: string): readonly { delivery?: InteractionDelivery }[];
    },
  ) {}

  register(ctx: LiveAttemptContext): LiveAttemptRegistration {
    const attempts = this.live.get(ctx.runId) ?? new Map<string, LiveAttemptContext>();
    attempts.set(ctx.attemptId, ctx);
    this.live.set(ctx.runId, attempts);
    return { release: () => this.unregister(ctx.runId, ctx.attemptId, ctx) };
  }

  /** Remove one attempt; with `owner`, only when that exact registration still holds the slot. */
  unregister(runId: string, attemptId: string, owner?: LiveAttemptContext): void {
    const attempts = this.live.get(runId);
    if (!attempts) return;
    if (owner && attempts.get(attemptId) !== owner) return;
    attempts.delete(attemptId);
    if (attempts.size === 0) this.live.delete(runId);
  }

  /** Run terminal: every live attempt is gone and later sends answer run_terminal. */
  dropForRun(runId: string): void {
    this.live.delete(runId);
    // The route already refuses terminal records by state; this set only
    // covers the commit race, so a bounded memory is enough for a daemon's life.
    if (this.terminal.size >= TERMINAL_MEMORY) this.terminal.clear();
    this.terminal.add(runId);
  }

  /**
   * Decision order (CONTRACT v2): terminal → thread-bound → no live attempt →
   * multi-attempt → attempt mismatch → pending blocking interaction (INV-048:
   * no vendor write beside a question the agent is held on) → no channel → no
   * session → adapter 1:1. An async question holds nothing, so it never
   * refuses a message; the message still does not answer it.
   */
  async send(input: LiveMessageInput): Promise<LiveMessageDelivery> {
    const attempts = this.live.get(input.runId);
    if (!attempts || attempts.size === 0) {
      return this.terminal.has(input.runId)
        ? refusal("not_active", "run_terminal", `run ${input.runId} is terminal`)
        : refusal("not_active", "no_live_session", `run ${input.runId} has no live agent attempt`);
    }
    const first = attempts.values().next().value as LiveAttemptContext;
    if (first.threadBound) {
      return {
        ...refusal("unsupported", "thread_bound", "thread turns are not steerable in v1"),
        ...facts(first),
      };
    }
    let target: LiveAttemptContext;
    if (input.expectedAttemptId !== undefined) {
      const wanted = attempts.get(input.expectedAttemptId);
      if (!wanted) {
        return refusal(
          "not_active",
          "attempt_mismatch",
          `attempt ${input.expectedAttemptId} is not live (live: ${[...attempts.keys()].join(", ")})`,
        );
      }
      target = wanted;
    } else if (attempts.size > 1) {
      return refusal(
        "rejected",
        "multi_attempt",
        `run has ${attempts.size} live attempts; pass expectedAttemptId (${[...attempts.keys()].join(", ")})`,
      );
    } else {
      target = first;
    }
    if (
      this.interactions
        .pendingForRun(input.runId)
        .some((interaction) => interaction.delivery !== "async")
    ) {
      return {
        ...refusal(
          "not_active",
          "interaction_pending",
          "a blocking question is pending; the message was not sent and did not answer it",
        ),
        ...facts(target),
      };
    }
    if (typeof target.adapter.message !== "function" || target.liveInput === "none") {
      return {
        ...refusal(
          "unsupported",
          "no_live_session",
          `${target.harnessId} has no live-input channel`,
        ),
        ...facts(target),
      };
    }
    const sessionId = target.currentSessionId();
    if (!sessionId) {
      return {
        ...refusal("not_active", "no_live_session", "the attempt has no native session yet"),
        ...facts(target),
      };
    }
    let result: LiveMessageAdapterResult;
    try {
      result = await target.adapter.message(sessionId, {
        messageId: input.messageId,
        text: input.text,
      });
    } catch (error) {
      // The adapter contract answers typed; a throw across the boundary is a
      // lost transport from here: the message may have landed.
      return {
        ...refusal("delivery_unknown", "transport_lost", safeProblemMessage(error)),
        ...facts(target),
      };
    }
    return {
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.nativeTurnId ? { nativeTurnId: result.nativeTurnId } : {}),
      ...facts(target),
    };
  }
}

function refusal(
  outcome: LiveMessageDelivery["outcome"],
  reason: NonNullable<LiveMessageDelivery["reason"]>,
  message: string,
): LiveMessageDelivery {
  return { outcome, reason, message };
}

function facts(
  ctx: LiveAttemptContext,
): Pick<LiveMessageDelivery, "attemptId" | "harnessId" | "liveInput"> {
  return { attemptId: ctx.attemptId, harnessId: ctx.harnessId, liveInput: ctx.liveInput };
}
