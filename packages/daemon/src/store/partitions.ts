import { randomUUID } from "node:crypto";
import type { EngineStore } from "./store.js";
import { requireTransaction, type SqlWriteContext } from "./mutation.js";

/** One generation of a partition: the surrogate `pid` is the only key rows carry. */
export interface PartitionGeneration {
  pid: number;
  name: string;
  epoch: string;
  status: string;
  nextSeq: number;
}

interface PartitionRow {
  id: number | bigint;
  name: string;
  epoch: string;
  status: string;
  next_seq: number | bigint;
}

export function generationOf(row: PartitionRow): PartitionGeneration {
  return {
    pid: Number(row.id),
    name: row.name,
    epoch: row.epoch,
    status: row.status,
    nextSeq: Number(row.next_seq),
  };
}

/** Create a new generation (inside the caller's transaction). Sequence numbers start at 1, as today. */
export function createPartition(
  store: EngineStore,
  name: string,
  options: { epoch?: string; projectId?: string | null } = {},
): PartitionGeneration {
  const epoch = options.epoch ?? randomUUID().replace(/-/g, "");
  return insertPartitionInTx(store, {
    name,
    epoch,
    projectId: options.projectId,
    createdAt: store.now().toISOString(),
  });
}

/** Importers supply the original identity, time and sparse sequence head. */
export function insertPartitionInTx(
  sql: SqlWriteContext,
  input: {
    name: string;
    epoch: string;
    createdAt: string;
    projectId?: string | null;
    status?: string;
    nextSeq?: number;
  },
): PartitionGeneration {
  requireTransaction(sql);
  if (!input.name.trim()) throw new Error("journal partition must not be empty");
  const status = input.status ?? "ready";
  const nextSeq = input.nextSeq ?? 1;
  const result = sql
    .prepare(
      "INSERT INTO partition(name, epoch, status, next_seq, project_id, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    )
    .run(input.name, input.epoch, status, nextSeq, input.projectId ?? null, input.createdAt);
  return {
    pid: Number(result.lastInsertRowid),
    name: input.name,
    epoch: input.epoch,
    status,
    nextSeq,
  };
}

/** The current (`ready`) generation of a partition name, or null. */
export function currentGeneration(
  store: Pick<SqlWriteContext, "prepare">,
  name: string,
): PartitionGeneration | null {
  const global = store.prepare("SELECT value FROM meta WHERE key = 'global_pid'").get() as
    { value: string } | undefined;
  if (global) {
    const row =
      name === "global"
        ? store
            .prepare(
              "SELECT id,name,epoch,status,next_seq FROM partition WHERE id=? AND name='global' AND status='ready'",
            )
            .get(Number(global.value))
        : store
            .prepare(
              `SELECT q.id,q.name,q.epoch,q.status,q.next_seq FROM project p
          JOIN partition q ON q.id=p.current_pid JOIN partition g ON g.id=p.pid
          WHERE p.pid=? AND p.status='active' AND g.status='ready' AND q.name=? AND q.status='ready'`,
            )
            .get(Number(global.value), name);
    return row ? generationOf(row as unknown as PartitionRow) : null;
  }
  // Core/import fixtures may construct a partition before binding the registry;
  // admitted composition always has global_pid and uses the branch above.
  const row = store
    .prepare(
      "SELECT id, name, epoch, status, next_seq FROM partition WHERE name = ? AND status = 'ready'",
    )
    .get(name) as PartitionRow | undefined;
  return row ? generationOf(row) : null;
}

export function partitionById(
  sql: Pick<SqlWriteContext, "prepare">,
  pid: number,
): PartitionGeneration | null {
  const row = sql
    .prepare("SELECT id, name, epoch, status, next_seq FROM partition WHERE id = ?")
    .get(pid) as PartitionRow | undefined;
  return row ? generationOf(row) : null;
}
