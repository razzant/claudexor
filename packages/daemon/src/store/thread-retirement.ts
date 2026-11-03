import { hashJson, safeProblemMessage } from "@claudexor/util";
import {
  Thread as ThreadSchema,
  ThreadRetirementOperation,
  type Thread,
  type ThreadExportDigestEntry,
  type ThreadRetireRequest,
} from "@claudexor/schema";
import { reduceThreadLifecycle } from "../thread-lifecycle.js";
import { bindIdempotencyInTx, lookupIdempotency } from "./idempotency.js";
import {
  requireTransaction,
  runMutation,
  type MutationContext,
  type SqlWriteContext,
} from "./mutation.js";
import type { Obligations } from "./obligations.js";
import type { PurgeFilesPayload } from "./purge-files.js";
import { readThreadClosure } from "./thread-closure.js";
import type { SqlThreadStore } from "./threads.js";

/** A definite answer: bound to its operation, so it can never later accept. */
export interface RetirementRefusal {
  code: string;
  message: string;
  error(): Error;
}

const OPERATION = "thread.retire";
/** The key names the operation alone: abandon and retire share its one outcome. */
const keyOf = (pid: number, threadId: string, operationId: string) => ({
  owner: "thread_retire" as const,
  pid,
  keyDigest: hashJson({ threadId, operationId }),
});
const REQUEST_DIGEST = hashJson({ operation: OPERATION });

export function retirementRefusal(code: string, message: string): RetirementRefusal {
  const safe = safeProblemMessage(message);
  return {
    code,
    message: safe,
    error: () =>
      Object.assign(new Error(safe), {
        code,
        status: code === "thread_purged" ? 410 : 409,
        retryable: false,
        context: { settled: true },
      }),
  };
}

export function retirementOutcome(
  sql: Pick<SqlWriteContext, "prepare">,
  pid: number,
  threadId: string,
  operationId: string,
): ThreadRetirementOperation | null {
  const binding = lookupIdempotency(sql, keyOf(pid, threadId, operationId), REQUEST_DIGEST);
  return binding ? ThreadRetirementOperation.parse(binding.result) : null;
}

/** First writer wins, in the transaction of its decision; a replay keeps it. */
export function bindRetirementOutcome(
  tx: MutationContext,
  pid: number,
  threadId: string,
  operationId: string,
  refusal: RetirementRefusal | null,
  outcome: "accepted" | "abandoned" = "abandoned",
): ThreadRetirementOperation {
  requireTransaction(tx);
  const settledAt = tx.now().toISOString();
  const result = ThreadRetirementOperation.parse({
    operationId,
    outcome: refusal ? "refused" : outcome,
    code: refusal?.code ?? null,
    message: refusal?.message ?? null,
    settledAt,
  });
  const bound = bindIdempotencyInTx(tx, {
    ...keyOf(pid, threadId, operationId),
    operation: OPERATION,
    requestDigest: REQUEST_DIGEST,
    targetId: threadId,
    createdAt: settledAt,
    result,
  });
  return ThreadRetirementOperation.parse(bound.result);
}

/** An open purge obligation is open cleanup; its reason names the last failure. */
export function readThreadCleanup(
  obligations: Pick<Obligations, "get">,
  threadId: string,
): { reason: string | null } | null {
  const row = obligations.get("purge_fs", threadId);
  if (!row) return null;
  return { reason: (row.payload as PurgeFilesPayload).lastError ?? null };
}

/**
 * The one conditional acceptance: active, closed or trashed goes straight to
 * purged, atomically with its cleanup obligation and the operation's bound
 * outcome, only while the exact closure is finished and still the one the caller
 * exported. The check runs inside the same transaction as the decision, so any
 * admission that committed first is seen and any later one finds a purged thread.
 * Nothing here deletes bytes: the purge owner does, under the obligation this
 * writes, and deletes only lane entries whose bytes these accepted entries hold.
 */
export function acceptRetirement(
  threads: Pick<SqlThreadStore, "store" | "generation" | "getThread" | "prepare" | "applyInTx">,
  obligations: Pick<Obligations, "create">,
  id: string,
  request: ThreadRetireRequest,
  acceptedLane: readonly ThreadExportDigestEntry[],
): Thread {
  const { store, generation } = threads;
  const thread = threads.getThread(id);
  if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
  if (thread.state === "purged") throw new Error(`thread ${id} is already purged`);
  const next = ThreadSchema.parse({
    ...reduceThreadLifecycle(thread, "retire"),
    retirement: {
      operationId: request.operationId,
      exportId: request.exportId,
      closureDigest: request.closureDigest,
      contentDigest: request.contentDigest,
      laneDigest: request.laneDigest,
      acceptedAt: store.now().toISOString(),
    },
  });
  const prepared = threads.prepare({ threads: [next] });
  const refusal = runMutation(store, (tx) => {
    // First writer wins here too: an operation already refused or abandoned keeps
    // that outcome, and this request is answered by it without evaluating anything.
    const bound = retirementOutcome(tx, generation.pid, id, request.operationId);
    if (bound)
      return retirementRefusal(
        bound.outcome === "abandoned"
          ? "thread_retirement_abandoned"
          : (bound.code ?? "thread_retirement_conflict"),
        bound.message ?? `operation ${request.operationId} was already ${bound.outcome}`,
      );
    const closure = readThreadClosure(store, id);
    const blocked = closure?.holds[0];
    const refused = blocked
      ? retirementRefusal(
          blocked.code === "closure_not_quiescent" || blocked.code === "closure_awaiting_decision"
            ? "thread_busy"
            : "thread_export_incomplete",
          blocked.message,
        )
      : closure?.digest !== request.closureDigest
        ? retirementRefusal("thread_export_stale", "the closure changed since this export")
        : null;
    if (refused) {
      bindRetirementOutcome(tx, generation.pid, id, request.operationId, refused);
      return refused;
    }
    threads.applyInTx(tx, prepared);
    bindRetirementOutcome(tx, generation.pid, id, request.operationId, null, "accepted");
    obligations.create("purge_fs", id, generation.pid, {
      thread,
      retirement: next.retirement,
      acceptedLane,
    } satisfies PurgeFilesPayload);
    return null;
  });
  if (refusal) throw refusal.error();
  return next;
}
