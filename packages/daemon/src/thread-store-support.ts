import type { LaneCheckpoint, Session, Thread, ThreadTurn } from "@claudexor/schema";
import {
  LaneCheckpoint as LaneCheckpointSchema,
  SCHEMA_VERSION,
  Session as SessionSchema,
  Thread as ThreadSchema,
  ThreadTurn as ThreadTurnSchema,
} from "@claudexor/schema";
import { hashJson, newId, nowIso } from "@claudexor/util";
import { idempotencyWireProjection } from "./idempotency-wire-projection.js";
import type { CreateThreadInput, CreateTurnInput, UpdateThreadInput } from "./threads.js";

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

/** Keep a sticky primary only when it belongs to a non-empty explicit pool. */
export function coercePrimaryToPool(primary: string | null, pool: string[]): string | null {
  if (primary && pool.length > 0 && !pool.includes(primary)) return null;
  return primary;
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
    requestDigest: hashJson(idempotencyWireProjection(input.request)),
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
    requestDigest: hashJson(idempotencyWireProjection(input.request)),
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

export function turnRunConflict(turnId: string, boundRunId: string, runId: string): Error {
  return Object.assign(
    new Error(`turn ${turnId} is already bound to run ${boundRunId}, not ${runId}`),
    { code: "turn_run_conflict", status: 409, retryable: false },
  );
}

export function findIdempotentTurn(
  index: ReadonlyMap<string, { turnId: string; requestDigest: string }>,
  getTurn: (id: string) => ThreadTurn | undefined,
  input: ThreadMutation["idempotency"],
): ThreadTurn | undefined {
  if (!input) return undefined;
  const prior = index.get(input.keyDigest);
  if (!prior) return undefined;
  if (prior.requestDigest !== input.requestDigest) throw idempotencyConflict();
  const turn = getTurn(prior.turnId);
  if (!turn) throw new Error(`idempotency record points to missing turn ${prior.turnId}`);
  return turn;
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

/** Construct a NEW thread from its create input (defaults documented inline). */
export function buildNewThread(input: CreateThreadInput): Thread {
  const now = nowIso();
  // A sticky primary must be a member of a non-empty eligible pool — enforce
  // at CREATE too (the request carries primary + pool independently) so a
  // thread is never born incoherent.
  const eligible = input.eligibleHarnesses ?? [];
  return ThreadSchema.parse({
    schema_version: SCHEMA_VERSION,
    id: newId("th"),
    created_at: now,
    updated_at: now,
    repo: input.repoRoot ? { root: input.repoRoot, base_ref: "HEAD" } : null,
    title: input.title ?? null,
    folder: input.folder ?? null,
    // Default mode follows the scope: a no-project thread can only Ask
    // (read-only), so it must NOT default to agent (which would 400 on the
    // first turn for lack of a project root). A project thread defaults to agent.
    mode: input.mode ?? (input.repoRoot ? "agent" : "ask"),
    // An isolated workspace needs a git project for its worktree; a no-project
    // thread is always in_place (review #6 — never persist a doomed config).
    workspace: {
      mode: input.repoRoot ? (input.workspace ?? "in_place") : "in_place",
      worktree_path: null,
      base_sha: null,
    },
    auth_preference: input.authPreference ?? "auto",
    credential_profile_id: input.credentialProfileId ?? null,
    access: input.access ?? null,
    primary_harness: coercePrimaryToPool(input.primaryHarness ?? null, eligible),
    eligible_harnesses: eligible,
  });
}

/** Apply an UpdateThreadInput patch; a primary outside the (non-empty) pool
 * coerces to null (Auto) rather than persisting an incoherent state. */
export function mergeThreadPatch(thread: Thread, patch: UpdateThreadInput): Thread {
  const next = ThreadSchema.parse({
    ...thread,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.primaryHarness !== undefined ? { primary_harness: patch.primaryHarness } : {}),
    ...(patch.credentialProfileId !== undefined
      ? { credential_profile_id: patch.credentialProfileId }
      : {}),
    ...(patch.access !== undefined ? { access: patch.access } : {}),
    ...(patch.eligibleHarnesses !== undefined
      ? { eligible_harnesses: patch.eligibleHarnesses }
      : {}),
    updated_at: nowIso(),
  });
  next.primary_harness = coercePrimaryToPool(next.primary_harness, next.eligible_harnesses);
  return next;
}
