import type { DurableJournal } from "@claudexor/journal";
import type {
  ControlPendingInteraction,
  InteractionAnswerSet,
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
  timeoutAt: string;
}

export type InteractionAnswerStatus = "delivered" | "not_found" | "already_resolved" | "rejected";
export type InteractionTerminal = "answered" | "timeout" | "run_terminal" | "interrupted";

interface InteractionResolution {
  runId: string;
  interactionIds: string[];
  terminal: InteractionTerminal;
}

const REQUESTED = "interaction.requested";
const RESOLVED = "interaction.resolved";

/** Journal-backed authority for pending interaction projections. */
export class InteractionStore {
  private readonly pending = new Map<string, ControlPendingInteraction>();
  private readonly resolved = new Set<string>();

  constructor(private readonly journal: DurableJournal) {
    this.replay();
    this.interruptAfterRestart();
  }

  request(ctx: InteractionContext): ControlPendingInteraction {
    const value = PendingInteractionSchema.parse({
      interactionId: ctx.request.interaction_id,
      runId: ctx.runId,
      attemptId: ctx.attemptId,
      harnessId: ctx.harnessId,
      sourceTool: ctx.request.source_tool,
      questions: ctx.request.questions,
      requestedAt: ctx.requestedAt,
      timeoutAt: ctx.timeoutAt,
    });
    const key = interactionKey(value.runId, value.interactionId);
    if (this.pending.has(key) || this.resolved.has(key)) {
      throw new Error(`duplicate interaction '${value.interactionId}' for run '${value.runId}'`);
    }
    this.journal.append(REQUESTED, value);
    this.pending.set(key, value);
    return value;
  }

  resolve(
    runId: string,
    interactionId: string,
    terminal: InteractionTerminal,
  ): "resolved" | "not_found" | "already_resolved" {
    const key = interactionKey(runId, interactionId);
    if (this.resolved.has(key)) return "already_resolved";
    if (!this.pending.has(key)) return "not_found";
    this.commitResolution({ runId, interactionIds: [interactionId], terminal });
    return "resolved";
  }

  resolveRun(
    runId: string,
    terminal: Extract<InteractionTerminal, "run_terminal" | "interrupted">,
  ): string[] {
    const interactionIds = this.pendingForRun(runId).map((value) => value.interactionId);
    if (interactionIds.length > 0) this.commitResolution({ runId, interactionIds, terminal });
    return interactionIds;
  }

  status(runId: string, interactionId: string): "pending" | "resolved" | "missing" {
    const key = interactionKey(runId, interactionId);
    if (this.pending.has(key)) return "pending";
    return this.resolved.has(key) ? "resolved" : "missing";
  }

  pendingForRun(runId: string): ControlPendingInteraction[] {
    return [...this.pending.values()].filter((value) => value.runId === runId);
  }

  validateProjection(): void {
    for (const value of this.pending.values()) PendingInteractionSchema.parse(value);
    for (const key of this.pending.keys()) {
      if (this.resolved.has(key)) throw new Error("interaction is both pending and resolved");
    }
  }

  private replay(): void {
    for (const record of this.journal.records()) {
      if (record.type === REQUESTED) {
        const value = PendingInteractionSchema.parse(record.payload);
        const key = interactionKey(value.runId, value.interactionId);
        if (this.pending.has(key) || this.resolved.has(key)) {
          throw new Error("duplicate interaction request history");
        }
        this.pending.set(key, value);
      } else if (record.type === RESOLVED) {
        this.applyResolution(parseResolution(record.payload));
      }
    }
    this.validateProjection();
  }

  private interruptAfterRestart(): void {
    const byRun = new Map<string, string[]>();
    for (const value of this.pending.values()) {
      const ids = byRun.get(value.runId) ?? [];
      ids.push(value.interactionId);
      byRun.set(value.runId, ids);
    }
    for (const [runId, interactionIds] of byRun) {
      this.commitResolution({ runId, interactionIds, terminal: "interrupted" });
    }
  }

  private commitResolution(value: InteractionResolution): void {
    const parsed = parseResolution(value);
    this.journal.append(RESOLVED, parsed);
    this.applyResolution(parsed);
  }

  private applyResolution(value: InteractionResolution): void {
    for (const interactionId of value.interactionIds) {
      const key = interactionKey(value.runId, interactionId);
      if (!this.pending.delete(key)) throw new Error("interaction resolution precedes request");
      this.resolved.add(key);
    }
  }
}

interface LiveEntry {
  store: InteractionStore;
  resolve: (answers: InteractionAnswerSet | null) => void;
  expiresAtMs: number;
}

/** Live answer bridge; durable state remains owned by InteractionStore. */
export class InteractionRegistry {
  private readonly live = new Map<string, LiveEntry>();

  constructor(
    private readonly stores: {
      forRequest(params: unknown): InteractionStore;
      all(): InteractionStore[];
    },
  ) {}

  register(ctx: InteractionContext, params: unknown): Promise<InteractionAnswerSet | null> {
    this.prune();
    const store = this.stores.forRequest(params);
    store.request(ctx);
    return new Promise<InteractionAnswerSet | null>((resolve) => {
      this.live.set(interactionKey(ctx.runId, ctx.request.interaction_id), {
        store,
        resolve,
        expiresAtMs: Date.parse(ctx.timeoutAt) || Date.now() + 900_000,
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
    const store = this.stores
      .all()
      .find((candidate) => candidate.status(runId, interactionId) !== "missing");
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
    for (const store of this.stores.all()) store.resolveRun(runId, "run_terminal");
    for (const [key, entry] of this.live) {
      if (!key.startsWith(`${runId}\u0000`)) continue;
      this.live.delete(key);
      entry.resolve(null);
    }
  }

  pendingForRun(runId: string): ControlPendingInteraction[] {
    this.prune();
    return this.stores.all().flatMap((store) => store.pendingForRun(runId));
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.live) {
      if (entry.expiresAtMs > now) continue;
      const split = key.indexOf("\u0000");
      const runId = key.slice(0, split);
      const interactionId = key.slice(split + 1);
      entry.store.resolve(runId, interactionId, "timeout");
      this.live.delete(key);
      entry.resolve(null);
    }
  }
}

export function interactionProjection() {
  return {
    name: "interactions",
    create: (journal: DurableJournal) => new InteractionStore(journal),
    validate: (store: InteractionStore) => store.validateProjection(),
  };
}

function interactionKey(runId: string, interactionId: string): string {
  return `${runId}\u0000${interactionId}`;
}

function parseResolution(value: unknown): InteractionResolution {
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
