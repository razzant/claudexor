import type { LaneCheckpoint, Session, Thread, ThreadTurn } from "@claudexor/schema";
import {
  LaneCheckpoint as LaneCheckpointSchema,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { hashJson } from "@claudexor/util";
import type { CreateThreadInput, CreateTurnInput } from "./threads.js";

/**
 * Pure ThreadStore support: the journal mutation codec and the idempotency
 * digests. Extracted from `threads.ts` so the store file stays under the
 * new-file complexity cap (INV-124); no behavior lives here — only parsing,
 * hashing, and array upkeep.
 */

export interface ThreadMutation {
  threads?: Thread[];
  sessions?: Session[];
  turns?: ThreadTurn[];
  /** Per-lane checkpoints (INV-137): journaled alongside turns/sessions. */
  checkpoints?: LaneCheckpoint[];
  idempotency?: { keyDigest: string; requestDigest: string; turnId: string };
  threadCreation?: { keyDigest: string; requestDigest: string; threadId: string };
}

export function parseMutation(value: unknown): ThreadMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid thread mutation");
  }
  const mutation = value as ThreadMutation;
  const idempotency = mutation.idempotency;
  const threadCreation = mutation.threadCreation;
  if (
    idempotency !== undefined &&
    (!idempotency ||
      typeof idempotency.keyDigest !== "string" ||
      typeof idempotency.requestDigest !== "string" ||
      typeof idempotency.turnId !== "string")
  ) {
    throw new Error("invalid thread idempotency record");
  }
  if (
    threadCreation !== undefined &&
    (!threadCreation ||
      typeof threadCreation.keyDigest !== "string" ||
      typeof threadCreation.requestDigest !== "string" ||
      typeof threadCreation.threadId !== "string")
  ) {
    throw new Error("invalid thread creation idempotency record");
  }
  return {
    ...(mutation.threads
      ? { threads: mutation.threads.map((item) => ThreadSchema.parse(item)) }
      : {}),
    ...(mutation.sessions
      ? { sessions: mutation.sessions.map((item) => SessionSchema.parse(item)) }
      : {}),
    ...(mutation.turns
      ? { turns: mutation.turns.map((item) => ThreadTurnSchema.parse(item)) }
      : {}),
    ...(mutation.checkpoints
      ? { checkpoints: mutation.checkpoints.map((item) => LaneCheckpointSchema.parse(item)) }
      : {}),
    ...(idempotency ? { idempotency: { ...idempotency } } : {}),
    ...(threadCreation ? { threadCreation: { ...threadCreation } } : {}),
  };
}

export function threadCreationIdempotency(
  partition: string,
  input: CreateThreadInput["idempotency"],
): ThreadMutation["threadCreation"] {
  if (!input) return undefined;
  validateIdempotencyKey(input.key);
  return {
    keyDigest: hashJson({
      client: input.client,
      partition,
      operation: "thread.create",
      key: input.key,
    }),
    requestDigest: hashJson(input.request),
    threadId: "",
  };
}

export function turnIdempotency(
  partition: string,
  threadId: string,
  input: CreateTurnInput["idempotency"],
): ThreadMutation["idempotency"] {
  if (!input) return undefined;
  validateIdempotencyKey(input.key);
  return {
    keyDigest: hashJson({
      client: input.client,
      partition,
      operation: "thread.turn.create",
      key: input.key,
    }),
    requestDigest: hashJson(input.request),
    turnId: "",
  };
}

function validateIdempotencyKey(key: string): void {
  if (!key || key.length > 256) {
    throw Object.assign(new Error("Idempotency-Key must contain 1-256 characters"), {
      code: "invalid_idempotency_key",
      status: 400,
    });
  }
}

export function idempotencyConflict(): Error & { code: string; status: number } {
  return Object.assign(new Error("idempotency key was already used with a different request"), {
    code: "idempotency_conflict",
    status: 409,
  });
}

export function upsert<T extends { id: string }>(items: T[], value: T): void {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) items.push(value);
  else items[index] = value;
}

export function assertUnique(items: Array<{ id: string }>, kind: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(`duplicate ${kind} id in journal projection`);
  }
}
