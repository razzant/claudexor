import type { InteractionStorePort } from "./store-contracts.js";
import type {
  ControlPendingInteraction,
  InteractionAnswerSet,
  InteractionHandlerRelease,
  InteractionRequest,
} from "@claudexor/schema";
import {
  ControlPendingInteraction as PendingInteractionSchema,
  InteractionAnswerSet as InteractionAnswerSetSchema,
} from "@claudexor/schema";

/** Structural twin of the orchestrator's PendingInteractionContext. */
export interface InteractionContext {
  runId: string;
  taskId: string;
  attemptId: string;
  harnessId: string;
  request: InteractionRequest;
  requestedAt: string;
  timeoutAt: string | null;
}

export type InteractionAnswerStatus = "delivered" | "not_found" | "already_resolved" | "rejected";
export type InteractionTerminal = "answered" | "timeout" | "run_terminal" | "interrupted";

export interface InteractionResolution {
  runId: string;
  interactionIds: string[];
  terminal: InteractionTerminal;
}

interface LiveEntry {
  store: InteractionStorePort;
  resolve: (result: InteractionAnswerSet | InteractionHandlerRelease) => void;
  expiresAtMs: number | null;
}

/** Live answer bridge; durable state remains owned by its store. */
export class InteractionRegistry {
  private readonly live = new Map<string, LiveEntry>();

  constructor(
    private readonly stores: {
      forRequest(params: unknown): InteractionStorePort;
      forRun(runId: string): InteractionStorePort | undefined;
    },
  ) {}

  register(
    ctx: InteractionContext,
    params: unknown,
  ): Promise<InteractionAnswerSet | InteractionHandlerRelease> {
    this.prune();
    // Validate before the durable request append: a malformed internal
    // deadline must not leave an unanswerable journal row without a live owner.
    const expiresAtMs = parseExpiry(ctx.timeoutAt);
    const store = this.stores.forRequest(params);
    store.request(ctx);
    return new Promise<InteractionAnswerSet | InteractionHandlerRelease>((resolve) => {
      this.live.set(interactionKey(ctx.runId, ctx.request.interaction_id), {
        store,
        resolve,
        expiresAtMs,
      });
    });
  }

  answer(
    runId: string,
    interactionId: string,
    rawAnswers: unknown,
  ): { status: InteractionAnswerStatus; message?: string } {
    this.prune();
    const parsed = InteractionAnswerSetSchema.safeParse(rawAnswers);
    if (!parsed.success) {
      return { status: "rejected", message: parsed.error.issues[0]?.message ?? "invalid answers" };
    }
    const store = this.storesForRun(runId).find(
      (candidate) => candidate.status(runId, interactionId) !== "missing",
    );
    if (!store) return { status: "not_found", message: missingMessage(runId, interactionId) };
    const status = store.resolve(runId, interactionId, "answered");
    if (status !== "resolved") {
      return {
        status: status === "already_resolved" ? "already_resolved" : "not_found",
        message: status === "not_found" ? missingMessage(runId, interactionId) : undefined,
      };
    }
    const key = interactionKey(runId, interactionId);
    const entry = this.live.get(key);
    this.live.delete(key);
    entry?.resolve(parsed.data);
    return { status: "delivered" };
  }

  dropForRun(runId: string): void {
    for (const store of this.storesForRun(runId)) store.resolveRun(runId, "run_terminal");
    for (const [key, entry] of this.live) {
      if (!key.startsWith(`${runId}\u0000`)) continue;
      this.live.delete(key);
      entry.resolve({ kind: "released", reason: "run_terminal" });
    }
  }

  pendingForRun(runId: string): ControlPendingInteraction[] {
    this.prune();
    return this.storesForRun(runId).flatMap((store) => store.pendingForRun(runId));
  }

  private storesForRun(runId: string): InteractionStorePort[] {
    const store = this.stores.forRun(runId);
    return store ? [store] : [];
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.live) {
      if (entry.expiresAtMs === null || entry.expiresAtMs > now) continue;
      const split = key.indexOf("\u0000");
      const runId = key.slice(0, split);
      const interactionId = key.slice(split + 1);
      entry.store.resolve(runId, interactionId, "timeout");
      this.live.delete(key);
      entry.resolve({ kind: "released", reason: "timeout" });
    }
  }
}

function parseExpiry(timeoutAt: string | null): number | null {
  if (timeoutAt === null) return null;
  const value = Date.parse(timeoutAt);
  if (!Number.isFinite(value)) throw new Error("invalid interaction timeoutAt");
  return value;
}

export function interactionKey(runId: string, interactionId: string): string {
  return `${runId}\u0000${interactionId}`;
}

export function parseInteractionResolution(value: unknown): InteractionResolution {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid interaction resolution");
  const input = value as Partial<InteractionResolution>;
  const terminals: InteractionTerminal[] = ["answered", "timeout", "run_terminal", "interrupted"];
  if (
    typeof input.runId !== "string" ||
    !Array.isArray(input.interactionIds) ||
    input.interactionIds.length === 0 ||
    input.interactionIds.some((id) => typeof id !== "string" || !id) ||
    !terminals.includes(input.terminal as InteractionTerminal)
  ) {
    throw new Error("invalid interaction resolution");
  }
  return {
    runId: input.runId,
    interactionIds: [...input.interactionIds],
    terminal: input.terminal as InteractionTerminal,
  };
}

function missingMessage(runId: string, interactionId: string): string {
  return `no pending interaction '${interactionId}' for run '${runId}'`;
}

export function pendingInteraction(ctx: InteractionContext): ControlPendingInteraction {
  return PendingInteractionSchema.parse({
    interactionId: ctx.request.interaction_id,
    runId: ctx.runId,
    attemptId: ctx.attemptId,
    harnessId: ctx.harnessId,
    sourceTool: ctx.request.source_tool,
    questions: ctx.request.questions,
    requestedAt: ctx.requestedAt,
    timeoutAt: ctx.timeoutAt,
  });
}
