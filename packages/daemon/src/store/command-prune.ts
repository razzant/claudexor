import { retainedEnvelopeOfRun } from "@claudexor/workspace";
import type { BlobFiles } from "./blob-files.js";
import { deleteTargetIdempotencyInTx } from "./idempotency.js";
import { requireTransaction, runMutation, type SqlWriteContext } from "./mutation.js";
import {
  commandRetentionCandidates,
  deleteEventKeysInTx,
  COMMAND_RETENTION_BATCH,
} from "./retention.js";
import type { EngineStore } from "./store.js";
import { collectReleasedBodies } from "./event-store.js";

type PruneRow = {
  id: string;
  pid: number;
  run_id: string | null;
  scope_root: string | null;
  params_sha: string;
  result_sha: string | null;
};

/** Remove decisions and their bindings/events atomically; conversation turns
 * remain retained and therefore keep their independent turn bindings. Return
 * released digests for the caller's final, pre-COMMIT owner cleanup. */
export function applyCommandPruneInTx(sql: SqlWriteContext, rows: readonly PruneRow[]): string[] {
  requireTransaction(sql);
  const released: string[] = [];
  for (const row of rows) {
    const keys = [`c:${row.id}:a`, `c:${row.id}:u`];
    if (row.run_id) {
      keys.push(
        `r:${row.run_id}:c`,
        `r:${row.run_id}:live`,
        `r:${row.run_id}:t`,
        `d:${row.run_id}`,
      );
      const interactions = sql
        .prepare("DELETE FROM interaction WHERE run_id=? AND pid=? RETURNING id")
        .all(row.run_id, row.pid) as Array<{ id: string }>;
      for (const interaction of interactions)
        keys.push(`i:${row.run_id}:${interaction.id.slice(row.run_id.length + 1)}`);
      sql
        .prepare("DELETE FROM operator_decision WHERE run_id=? AND pid=?")
        .run(row.run_id, row.pid);
      sql.prepare("DELETE FROM run_terminal WHERE run_id=? AND pid=?").run(row.run_id, row.pid);
      sql
        .prepare("DELETE FROM effect_obligation WHERE kind='terminal_files' AND key=? AND pid=?")
        .run(row.run_id, row.pid);
      deleteTargetIdempotencyInTx(sql, "decision", row.pid, row.run_id);
    }
    released.push(...deleteEventKeysInTx(sql, row.pid, keys), row.params_sha);
    if (row.result_sha) released.push(row.result_sha);
    deleteTargetIdempotencyInTx(sql, "command", row.pid, row.id);
    sql.prepare("DELETE FROM command WHERE id=? AND pid=?").run(row.id, row.pid);
    if (row.scope_root)
      sql.prepare("INSERT OR IGNORE INTO pruned_root(root) VALUES(?)").run(row.scope_root);
  }
  return released;
}

/** At most one batch per admission/terminal, over the global live command set.
 * File GC is asynchronous and uses the existing shared C10 owner generations. */
export class SqlCommandPruner {
  private eventCursor = { time: "", pid: 0, seq: 0 };
  constructor(
    private readonly store: EngineStore,
    private readonly blobs: BlobFiles,
    private readonly options: {
      log?: (message: string) => void;
      retainedEnvelope?: typeof retainedEnvelopeOfRun;
    } = {},
  ) {}

  pruneHistory(cap: number, retentionMs: number, now: number): string[] {
    const selection = commandRetentionCandidates(this.store, {
      now: new Date(now),
      retentionMs,
      cap,
      exempt: (candidate) =>
        !!(
          candidate.runDir &&
          candidate.runId &&
          (this.options.retainedEnvelope ?? retainedEnvelopeOfRun)(
            candidate.runDir,
            candidate.runId,
          )
        ),
    });
    this.prune(selection.victims.map((row) => row.id));
    this.pruneReceiptEvents(now);
    return selection.victims.map((row) => row.id);
  }

  prune(ids: readonly string[], pid?: number): void {
    if (ids.length === 0) return;
    const rows = this.store
      .prepare(
        `SELECT id,pid,run_id,scope_root,params_sha,result_sha FROM command
      WHERE id IN (SELECT value FROM json_each(?))${pid === undefined ? "" : " AND pid=?"}`,
      )
      .all(JSON.stringify(ids), ...(pid === undefined ? [] : [pid])) as PruneRow[];
    const released = runMutation(this.store, (tx) => {
      const digests = applyCommandPruneInTx(tx, rows);
      tx.changes.blobChanged(...digests);
      return digests;
    });
    this.collect(released);
  }

  /** A bounded keyset scan of aged command copies. The cursor is disposable
   * scan progress, not retention authority; every decision rechecks the command
   * kind. This avoids rescanning exempt product history on every pass. */
  private pruneReceiptEvents(now: number): void {
    const cursor = this.eventCursor;
    const rows = this.store
      .prepare(
        `SELECT pid,seq,time,slot_key,group_key FROM event INDEXED BY event_command_age
      WHERE type IN ('command.accepted','command.updated') AND time <= ?
      AND (time,pid,seq) > (?,?,?) ORDER BY time,pid,seq LIMIT ?`,
      )
      .all(
        new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
        cursor.time,
        cursor.pid,
        cursor.seq,
        COMMAND_RETENTION_BATCH,
      ) as Array<{
      pid: number;
      seq: number;
      time: string;
      slot_key: string | null;
      group_key: string | null;
    }>;
    if (rows.length === 0) {
      this.eventCursor = { time: "", pid: 0, seq: 0 };
      return;
    }
    const released = runMutation(this.store, (tx) => {
      const digests: string[] = [];
      for (const row of rows) {
        const key = row.slot_key ?? row.group_key;
        if (!key) continue;
        const owner = tx
          .prepare("SELECT kind FROM command WHERE id=? AND pid=? AND live=1")
          .get(key.slice(2, -2), row.pid) as { kind: string } | undefined;
        if (owner?.kind !== "model" && owner?.kind !== "account_reset") continue;
        const deleted = tx
          .prepare("DELETE FROM event WHERE pid=? AND seq=? RETURNING payload_sha")
          .get(row.pid, row.seq) as { payload_sha: string | null } | undefined;
        if (deleted?.payload_sha) digests.push(deleted.payload_sha);
      }
      tx.changes.blobChanged(...digests);
      const last = rows[rows.length - 1]!;
      tx.changes.afterCommit(() => {
        this.eventCursor = { time: last.time, pid: last.pid, seq: last.seq };
      });
      return digests;
    });
    this.collect(released);
  }

  private collect(digests: readonly string[]): void {
    collectReleasedBodies(this.store, this.blobs, digests, this.options.log);
  }
}
