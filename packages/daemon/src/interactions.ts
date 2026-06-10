import type { ControlPendingInteraction, InteractionAnswerSet, InteractionRequest } from "@claudexor/schema";
import { InteractionAnswerSet as InteractionAnswerSetSchema } from "@claudexor/schema";

/** Structural twin of the orchestrator's PendingInteractionContext. */
export interface InteractionContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  request: InteractionRequest;
  requestedAt: string;
  timeoutAt: string;
}

interface PendingEntry {
  ctx: InteractionContext;
  resolve: (answers: InteractionAnswerSet | null) => void;
  expiresAtMs: number;
}

export type InteractionAnswerStatus = "delivered" | "not_found" | "already_resolved" | "rejected";

/**
 * Daemon-side registry of questions waiting for the user (waiting_on_user).
 *
 * The orchestrator's RunInput.onInteraction is wired to `register()`, which
 * parks the attempt's promise here; control-api lists pending entries for the
 * UI and delivers answers via `answer()`. The orchestrator owns the timeout —
 * entries self-expire here only as hygiene so a timed-out question cannot be
 * answered into a session that already moved on.
 */
export class InteractionRegistry {
  private readonly pending = new Map<string, PendingEntry>();

  register(ctx: InteractionContext): Promise<InteractionAnswerSet | null> {
    this.prune();
    return new Promise<InteractionAnswerSet | null>((resolve) => {
      this.pending.set(ctx.request.interaction_id, {
        ctx,
        resolve,
        expiresAtMs: Date.parse(ctx.timeoutAt) || Date.now() + 900_000,
      });
    });
  }

  answer(runId: string, interactionId: string, rawAnswers: unknown): { status: InteractionAnswerStatus; message?: string } {
    this.prune();
    const entry = this.pending.get(interactionId);
    if (!entry || entry.ctx.runId !== runId) return { status: "not_found", message: `no pending interaction '${interactionId}' for run '${runId}'` };
    const parsed = InteractionAnswerSetSchema.safeParse(rawAnswers);
    if (!parsed.success) return { status: "rejected", message: parsed.error.issues[0]?.message ?? "invalid answers" };
    this.pending.delete(interactionId);
    entry.resolve(parsed.data);
    return { status: "delivered" };
  }

  pendingForRun(runId: string): ControlPendingInteraction[] {
    this.prune();
    return [...this.pending.values()]
      .filter((e) => e.ctx.runId === runId)
      .map((e) => ({
        interactionId: e.ctx.request.interaction_id,
        runId: e.ctx.runId,
        attemptId: e.ctx.attemptId,
        harnessId: e.ctx.harnessId,
        sourceTool: e.ctx.request.source_tool,
        questions: e.ctx.request.questions,
        requestedAt: e.ctx.requestedAt,
        timeoutAt: e.ctx.timeoutAt,
      }));
  }

  /** Drop expired entries (the orchestrator already declined them). */
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAtMs <= now) {
        this.pending.delete(id);
        entry.resolve(null);
      }
    }
  }
}
