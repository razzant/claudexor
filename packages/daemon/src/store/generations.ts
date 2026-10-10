import { randomUUID } from "node:crypto";
import { bindIdempotencyInTx, lookupIdempotency, type IdempotencyBinding } from "./idempotency.js";
import { appendPreparedEventInTx, prepareEvent } from "./event-store.js";
import { requireTransaction, runMutation, type SqlWriteContext } from "./mutation.js";
import {
  generationOf,
  insertPartitionInTx,
  partitionById,
  type PartitionGeneration,
} from "./partitions.js";
import type { EngineStore } from "./store.js";
import type { BlobFiles } from "./blob-files.js";

type Reader = Pick<SqlWriteContext, "prepare">;

/** Current registry authority, including recovery-required global state. */
export function globalGeneration(sql: Reader): PartitionGeneration | null {
  const row = sql.prepare("SELECT value FROM meta WHERE key = 'global_pid'").get() as
    { value: string } | undefined;
  return row ? partitionById(sql, Number(row.value)) : null;
}

/** The registry, not just a partition's ready bit, determines visibility. */
export const SERVED_PIDS_SQL = `
  SELECT g.id FROM meta m JOIN partition g ON g.id = CAST(m.value AS INTEGER)
    WHERE m.key = 'global_pid' AND g.status = 'ready'
  UNION ALL
  SELECT p.current_pid FROM meta m JOIN partition g ON g.id = CAST(m.value AS INTEGER)
    JOIN project p ON p.pid = g.id AND p.status = 'active'
    JOIN partition q ON q.id = p.current_pid AND q.status = 'ready'
    WHERE m.key = 'global_pid' AND g.status = 'ready'`;

/** Addressed membership: no materialization of every project on hot lookups. */
export function isServedPid(sql: Reader, pid: number): boolean {
  return Boolean(
    sql
      .prepare(
        `SELECT 1 FROM partition q JOIN meta m ON m.key = 'global_pid'
    JOIN partition g ON g.id = CAST(m.value AS INTEGER) AND g.status = 'ready'
    WHERE q.id = ? AND q.status = 'ready' AND (q.id = g.id OR EXISTS(
      SELECT 1 FROM project p WHERE p.current_pid = q.id AND p.pid = g.id AND p.status = 'active'))`,
      )
      .get(pid),
  );
}

export function requireServedGeneration(sql: Reader, pid: number): PartitionGeneration {
  const generation = partitionById(sql, pid);
  if (!generation || !isServedPid(sql, pid)) {
    throw Object.assign(
      new Error(`partition ${generation?.name ?? pid} requires journal recovery`),
      { code: "journal_recovery_required", status: 409 },
    );
  }
  return generation;
}

export function servedGenerations(sql: Reader): PartitionGeneration[] {
  return (
    sql
      .prepare(
        `SELECT q.id,q.name,q.epoch,q.status,q.next_seq FROM partition q
    LEFT JOIN project p ON p.current_pid=q.id AND p.status='active'
      AND p.pid=CAST((SELECT value FROM meta WHERE key='global_pid') AS INTEGER)
    WHERE q.id IN (${SERVED_PIDS_SQL})
    ORDER BY CASE WHEN q.name='global' THEN 0 ELSE 1 END,p.created_at,p.rowid`,
      )
      .all() as Array<{ id: number; name: string; epoch: string; status: string; next_seq: number }>
  ).map(generationOf);
}

/** Used by first construction/import. No engine is opened or committed here. */
export function setGlobalGenerationInTx(sql: SqlWriteContext, pid: number): void {
  requireTransaction(sql);
  const generation = partitionById(sql, pid);
  if (generation?.name !== "global")
    throw new Error("global authority must name a global partition");
  sql
    .prepare(
      "INSERT INTO meta(key, value) VALUES('global_pid', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(pid));
  // Global registry replacement also hides all previously registered projects.
  sql.prepare("UPDATE command SET live = 0 WHERE live = 1 AND pid <> ?").run(pid);
  reconcileLiveInTx(sql);
}

/** Import's final pass, after project current_pid bindings are complete. */
export function reconcileLiveInTx(sql: SqlWriteContext): void {
  requireTransaction(sql);
  sql
    .prepare(
      `UPDATE command SET live = CASE WHEN pid IN (${SERVED_PIDS_SQL}) THEN 1 ELSE 0 END
    WHERE live <> CASE WHEN pid IN (${SERVED_PIDS_SQL}) THEN 1 ELSE 0 END`,
    )
    .run();
}

export function setGenerationStatusInTx(sql: SqlWriteContext, pid: number, status: string): void {
  requireTransaction(sql);
  sql.prepare("UPDATE partition SET status = ? WHERE id = ?").run(status, pid);
  if (globalGeneration(sql)?.pid === pid) {
    reconcileLiveInTx(sql);
  } else {
    sql
      .prepare("UPDATE command SET live = ? WHERE pid = ?")
      .run(isServedPid(sql, pid) ? 1 : 0, pid);
  }
}

export function archiveGenerationInTx(sql: SqlWriteContext, pid: number): string {
  const generation = partitionById(sql, pid);
  if (!generation) throw new Error(`no partition ${pid}`);
  setGenerationStatusInTx(sql, pid, "archived");
  return `partition:${generation.name}@${generation.epoch}`;
}

export function restoreGenerationInTx(sql: SqlWriteContext, pid: number): void {
  const generation = partitionById(sql, pid);
  if (generation?.status !== "archived") throw new Error(`partition ${pid} is not archived`);
  setGenerationStatusInTx(sql, pid, "ready");
}

/** Preserves old rows as evidence. Restoring an unregistered generation cannot
 * re-adopt it: only the current global registry can make its commands live. */
export function quarantineGenerationInTx(
  sql: SqlWriteContext,
  oldPid: number,
  input: {
    epoch: string;
    createdAt: string;
  },
): PartitionGeneration {
  requireTransaction(sql);
  const old = partitionById(sql, oldPid);
  if (!old) throw new Error(`no partition ${oldPid}`);
  const global = globalGeneration(sql);
  const project = sql
    .prepare("SELECT id FROM project WHERE pid = ? AND current_pid = ? AND status = 'active'")
    .get(global?.pid ?? -1, oldPid) as { id: string } | undefined;
  if (global?.pid !== oldPid && !project) throw new Error(`partition ${oldPid} is not current`);
  setGenerationStatusInTx(sql, oldPid, "quarantined");
  const next = insertPartitionInTx(sql, { name: old.name, ...input, projectId: project?.id });
  if (global?.pid === oldPid) setGlobalGenerationInTx(sql, next.pid);
  else sql.prepare("UPDATE project SET current_pid = ? WHERE id = ?").run(next.pid, project!.id);
  return next;
}

/** Recovery owns request/fingerprint validation and any filesystem leftovers.
 * A retry addresses oldPid, even after current authority has moved. */
export function quarantineGeneration(
  store: EngineStore,
  blobs: BlobFiles,
  input: {
    oldPid: number;
    keyDigest: string;
    requestDigest: string;
    operationId: string;
    payload: unknown;
    epoch?: string;
  },
): { generation: PartitionGeneration | null; binding: IdempotencyBinding; replay: boolean } {
  const key = { owner: "quarantine" as const, pid: input.oldPid, keyDigest: input.keyDigest };
  const prior = lookupIdempotency(store, key, input.requestDigest);
  if (prior) {
    // Recovery owns the original operation receipt. Never infer its generation
    // from today's current pointer: it may have been quarantined again.
    return { generation: null, binding: prior, replay: true };
  }
  const epoch = input.epoch ?? randomUUID().replace(/-/g, "");
  const time = store.now().toISOString();
  const event = prepareEvent(blobs, {
    type: "journal.partition_quarantined",
    time,
    payload: input.payload,
  });
  const binding: IdempotencyBinding = {
    ...key,
    operation: "journal.partition.quarantine",
    requestDigest: input.requestDigest,
    targetId: input.operationId,
    createdAt: time,
  };
  return runMutation(store, (tx) => {
    const generation = quarantineGenerationInTx(tx, input.oldPid, { epoch, createdAt: time });
    bindIdempotencyInTx(tx, binding);
    appendPreparedEventInTx(tx, blobs, generation.pid, event);
    return { generation, binding, replay: false };
  });
}
