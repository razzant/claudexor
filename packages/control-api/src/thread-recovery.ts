import type { ResourceAttachmentRef } from "@claudexor/schema";
import type { DaemonFacadeClient, DaemonRunRecord } from "./daemon-server.js";
import { assertThreadIdle } from "./thread-mutation.js";

export interface ThreadTurnIdempotency {
  key: string;
  client: string;
  request: unknown;
}

export interface ThreadRecoveryTurnCreateOptions {
  kind?: unknown;
  parentRunId?: string | null;
  planRunId?: string | null;
  planHash?: string | null;
  planOverridden?: boolean;
  attachments?: ResourceAttachmentRef[];
}

export type FindThreadTurnByIdempotency = (
  id: string,
  idempotency: ThreadTurnIdempotency,
) => Promise<{ id: string } | null>;

export interface ThreadRecoveryServices {
  createThreadTurn?: (
    id: string,
    prompt: string,
    options: ThreadRecoveryTurnCreateOptions & { idempotency?: ThreadTurnIdempotency },
  ) => Promise<unknown>;
  findThreadTurnByIdempotency?: FindThreadTurnByIdempotency;
  threadDetail?: (
    id: string,
  ) => Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
}

interface ThreadTurnCreateReplayServices {
  threadDetail(id: string): Promise<{ thread: unknown; sessions: unknown[]; turns: unknown[] }>;
  findThreadTurnByIdempotency?: FindThreadTurnByIdempotency;
}

export function assertLatestThreadTurn(turns: unknown[], turnId: string): void {
  const latest = [...turns]
    .reverse()
    .find(
      (turn) =>
        turn !== null &&
        typeof turn === "object" &&
        !Array.isArray(turn) &&
        typeof (turn as { id?: unknown }).id === "string",
    ) as { id: string } | undefined;
  if (latest?.id !== turnId) {
    throw Object.assign(
      new Error(
        `turn ${turnId} is not the latest turn of this thread; the conversation moved on — send a new message instead`,
      ),
      { code: "thread_turn_not_latest", status: 409, retryable: false },
    );
  }
}

/**
 * A purged thread is terminal: every route asks this after its accepted-command
 * replay lookup, so what the thread accepted still answers, and nothing new is
 * recorded on it or admitted for it, a refused turn's replay included. New work
 * answers 409 `thread_purged`, as the store's turn creation always has.
 */
export function assertThreadAdmitsWork(threadId: string, thread: unknown): void {
  if ((thread as { state?: unknown } | null)?.state === "purged")
    throw Object.assign(new Error(`thread ${threadId} was purged; it admits no new work`), {
      code: "thread_purged",
      status: 409,
      retryable: false,
    });
}

function assertExistingTurnIsRunless(turn: unknown, turnId: string): void {
  if (
    turn !== null &&
    typeof turn === "object" &&
    !Array.isArray(turn) &&
    typeof (turn as { run_id?: unknown }).run_id === "string"
  ) {
    throw Object.assign(
      new Error(
        `turn ${turnId} already has a run; its original command is no longer retained — open that run or send a new message instead`,
      ),
      { code: "thread_turn_already_bound", status: 409, retryable: false },
    );
  }
}

/** Read-only admission for ordinary turn create: accepted handle or tail orphan. */
export async function inspectThreadTurnCreateReplay(
  daemon: Pick<DaemonFacadeClient, "findAccepted">,
  services: ThreadTurnCreateReplayServices,
  threadId: string,
  idempotency: ThreadTurnIdempotency,
): Promise<{
  detail: { thread: unknown; sessions: unknown[]; turns: unknown[] };
  existingId: string | null;
  accepted: DaemonRunRecord | null;
}> {
  const existing = await services.findThreadTurnByIdempotency?.(threadId, idempotency);
  const detail = await services.threadDetail(threadId);
  if (!existing) return { detail, existingId: null, accepted: null };

  const accepted = await daemon.findAccepted?.(
    { threadId },
    {
      idempotencyKey: idempotency.key,
      clientId: idempotency.client,
      operation: "thread.turn.create",
      idempotencyRequest: idempotency.request,
    },
  );
  if (accepted) return { detail, existingId: existing.id, accepted };

  const turn = (detail.turns as Array<Record<string, unknown>>).find(
    (candidate) => candidate["id"] === existing.id,
  );
  assertExistingTurnIsRunless(turn, existing.id);
  assertLatestThreadTurn(detail.turns, existing.id);
  return { detail, existingId: existing.id, accepted: null };
}

/** Durable command replay, orphan tail fence, idle fence, then create. */
export async function resolveThreadRecoveryTurn(
  daemon: Pick<DaemonFacadeClient, "list">,
  services: ThreadRecoveryServices | undefined,
  source: DaemonRunRecord,
  threadId: string,
  prompt: string,
  options: ThreadRecoveryTurnCreateOptions,
  idempotency: ThreadTurnIdempotency,
  findAccepted?: (turnId: string) => Promise<unknown | null | undefined>,
): Promise<{ id: string }> {
  if (!services?.createThreadTurn || !services.findThreadTurnByIdempotency) {
    throw Object.assign(
      new Error("thread recovery requires the durable thread idempotency service"),
      { status: 501, code: "thread_recovery_unavailable" },
    );
  }
  const existing = await services.findThreadTurnByIdempotency(threadId, idempotency);
  if (existing) {
    // Once the daemon accepted this exact command, its original handle wins
    // even if the conversation later advanced. Only a RUNLESS/no-command
    // orphan is eligible for fresh admission, and only while it remains tail.
    if (await findAccepted?.(existing.id)) return existing;
    if (!services.threadDetail) {
      throw Object.assign(new Error("thread recovery requires the durable thread detail service"), {
        status: 501,
        code: "thread_recovery_unavailable",
      });
    }
    const detail = await services.threadDetail(threadId);
    const turn = detail.turns.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as { id?: unknown }).id === existing.id,
    );
    assertThreadAdmitsWork(threadId, detail.thread);
    assertExistingTurnIsRunless(turn, existing.id);
    assertLatestThreadTurn(detail.turns, existing.id);
  }
  await assertThreadIdle(source, () => daemon.list({ threadId, activeOnly: true }));
  if (existing) return existing;
  return (await services.createThreadTurn(threadId, prompt, { ...options, idempotency })) as {
    id: string;
  };
}
