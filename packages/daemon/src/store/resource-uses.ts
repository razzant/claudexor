import type { ControlResource } from "@claudexor/schema";
import type { BlobFiles } from "./blob-files.js";
import { collectReleasedBodies } from "./event-store.js";
import { requireTransaction, type MutationContext, type SqlWriteContext } from "./mutation.js";
import { readResourceRow, resourceError, resourceSha, type ResourceRow } from "./resource-rows.js";
import type { EngineStore } from "./store.js";
import { decodeBody } from "./thread-rows.js";

/**
 * Accepted owners holding a MANAGED ordinary resource (#249). A managed ID's
 * caller may release it; from then on no new reference is admitted, while every
 * owner that accepted the ID before keeps its bytes. One row per (resource,
 * owner), written in that owner's own acceptance transaction and dropped when
 * the owner is retired by its existing lifecycle (command retention, draft
 * replace/clear/dispatch, thread purge). Default and legacy resources have no
 * rows: their `ready` row already holds the bytes indefinitely.
 */
export type ResourceUseOwner = "command" | "turn" | "deferred_message";
export interface ResourceUseHolder {
  owner: ResourceUseOwner;
  id: string;
}
type SqlReader = Pick<SqlWriteContext, "prepare">;

/** Resource ids named by request refs (`resourceId`) or resolved attachments (`resource_id`). */
export function referencedResourceIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ids = new Set<string>();
  for (const item of list as Array<Record<string, unknown> | null>) {
    const id = item?.["resourceId"] ?? item?.["resource_id"];
    if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

export function isManagedOrdinary(resource: ControlResource): boolean {
  return resource.lifetime === "managed" && resource.purpose === undefined;
}

/** The typed refusal of a NEW reference to a released ID: never success, never a re-upload. */
export function releasedResourceError(resourceId: string, releasedAt: string | null): Error {
  return Object.assign(
    resourceError(
      `resource ${resourceId} was released by its caller and admits no new reference`,
      410,
      "resource_released",
    ),
    {
      retryable: false,
      context: { resourceId, releasedAt },
      requiredActions: [
        "Import the document again under a new import key to attach it to new work.",
      ],
    },
  );
}

export function holdsResourceUse(
  sql: SqlReader,
  holder: ResourceUseHolder,
  resourceId: string,
): boolean {
  return !!sql
    .prepare("SELECT 1 FROM resource_use WHERE resource_id=? AND owner=? AND owner_id=?")
    .get(resourceId, holder.owner, holder.id);
}

/** A released managed row whose reader is not one of its accepted holders. */
export function refusedReleasedUse(
  sql: SqlReader,
  row: ResourceRow,
  holders: readonly ResourceUseHolder[],
): boolean {
  return (
    row.state === "released" &&
    isManagedOrdinary(row.resource) &&
    !holders.some((holder) => holdsResourceUse(sql, holder, row.resource.resourceId))
  );
}

/**
 * Inside the owner's acceptance transaction: hold every managed resource it
 * names. A released one is admitted only when `holder` itself or `from` (the
 * accepted owner this one derives from, a dispatching draft) already holds it;
 * otherwise this is a new reference and the transaction refuses. Missing or
 * unpublished resources are left to the existing resolver's refusals.
 */
export function claimResourceUsesInTx(
  sql: SqlWriteContext,
  holder: ResourceUseHolder,
  ids: readonly string[],
  from?: ResourceUseHolder,
): void {
  requireTransaction(sql);
  const insert = sql.prepare(
    "INSERT OR IGNORE INTO resource_use(resource_id,owner,owner_id,sha256) VALUES(?,?,?,?)",
  );
  for (const id of ids) {
    const row = readResourceRow(sql, id);
    if (!row || !isManagedOrdinary(row.resource) || row.state === "publishing") continue;
    if (refusedReleasedUse(sql, row, from ? [holder, from] : [holder]))
      throw releasedResourceError(id, row.releasedAt);
    insert.run(id, holder.owner, holder.id, resourceSha(row.resource));
  }
}

/** Retire one owner's holds except `keep`; returns their digests for the caller's file GC. */
export function dropResourceUsesInTx(
  sql: SqlWriteContext,
  holder: ResourceUseHolder,
  keep: readonly string[] = [],
): string[] {
  requireTransaction(sql);
  return (
    sql
      .prepare(
        `DELETE FROM resource_use WHERE owner=? AND owner_id=?
        AND resource_id NOT IN (SELECT value FROM json_each(?)) RETURNING sha256`,
      )
      .all(holder.owner, holder.id, JSON.stringify(keep)) as Array<{ sha256: string }>
  ).map((row) => row.sha256);
}

/** Digests a commit released: their files go by the same post-commit collection as
 * other released bodies, never left for the startup sweep. */
export function collectAfterCommit(
  tx: MutationContext,
  owner: { store: EngineStore; blobs: BlobFiles },
  digests: readonly string[],
): void {
  if (digests.length === 0) return;
  tx.changes.blobChanged(...digests);
  tx.changes.afterCommit(() => collectReleasedBodies(owner.store, owner.blobs, digests));
}

/**
 * Every thread write's holds, run after its rows by the one reducer all thread
 * writers share (`applyInTx`: a turn, relink, retirement or a project removal
 * that purges its trash): each written turn of a live thread holds its resolved
 * attachments (a rewrite of an existing turn finds its own hold), and a purged
 * thread's turns end theirs; a later rewrite of such a turn never holds again.
 */
export function syncThreadResourceUsesInTx(
  tx: MutationContext,
  mutation: {
    threads?: ReadonlyArray<{ id: string; state: string }>;
    turns?: ReadonlyArray<{ id: string; thread_id: string; attachments?: unknown }>;
  },
  owner: { store: EngineStore; blobs: BlobFiles },
): void {
  const state = tx.prepare("SELECT state FROM thread WHERE id=?");
  for (const turn of mutation.turns ?? []) {
    if ((state.get(turn.thread_id) as { state: string } | undefined)?.state === "purged") continue;
    claimResourceUsesInTx(
      tx,
      { owner: "turn", id: turn.id },
      referencedResourceIds(turn.attachments),
    );
  }
  const released = (mutation.threads ?? []).flatMap((thread) =>
    thread.state === "purged" ? dropThreadResourceUsesInTx(tx, thread.id) : [],
  );
  collectAfterCommit(tx, owner, released);
}

/**
 * What a thread turn's command references: the turn's stored attachments (its
 * params carry none). Only the turn's FIRST dispatch inherits the accepted turn's
 * hold (`from`): the turn has no durable dispatch fact (`dispatched_at`, written
 * with its first accepted product command and kept when command retention prunes
 * that command) and no run. A refusal recorded before any command (a preflight or
 * enqueue failure, or a stop before the first enqueue) leaves the turn undispatched,
 * so its same-key repeat still dispatches it. Any later dispatch (Turn Retry, or a
 * repeat after an accepted one) is a new reference, refused once released.
 */
export function turnDispatchUses(
  sql: SqlReader,
  turnId: string | null,
): { ids: string[]; from?: ResourceUseHolder } {
  if (turnId === null) return { ids: [] };
  const row = sql.prepare("SELECT run_id,dispatched_at,body FROM turn WHERE id=?").get(turnId) as
    { run_id: string | null; dispatched_at: string | null; body: Uint8Array } | undefined;
  if (!row) return { ids: [] };
  const ids = referencedResourceIds(decodeBody<{ attachments?: unknown }>(row).attachments);
  const dispatched = row.run_id !== null || row.dispatched_at !== null;
  return dispatched ? { ids } : { ids, from: { owner: "turn", id: turnId } };
}

/** In the acceptance transaction of a turn's product command: its first one is the
 * turn's durable dispatch fact; a later one keeps the first instant. */
export function markTurnDispatchedInTx(sql: SqlWriteContext, turnId: string, at: string): void {
  requireTransaction(sql);
  sql
    .prepare("UPDATE turn SET dispatched_at=? WHERE id=? AND dispatched_at IS NULL")
    .run(at, turnId);
}

/** Thread purge ends the history its turns hold. */
function dropThreadResourceUsesInTx(sql: SqlWriteContext, threadId: string): string[] {
  requireTransaction(sql);
  return (
    sql
      .prepare(
        `DELETE FROM resource_use WHERE owner='turn'
        AND owner_id IN (SELECT id FROM turn WHERE thread_id=?) RETURNING sha256`,
      )
      .all(threadId) as Array<{ sha256: string }>
  ).map((row) => row.sha256);
}
