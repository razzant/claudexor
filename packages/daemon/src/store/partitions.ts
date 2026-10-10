import { randomUUID } from "node:crypto";
import type { EngineStore } from "./store.js";

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

function generationOf(row: PartitionRow): PartitionGeneration {
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
  if (!store.inTransaction)
    throw new Error("a partition generation is created inside a transaction");
  if (!name.trim()) throw new Error("journal partition must not be empty");
  const epoch = options.epoch ?? randomUUID().replace(/-/g, "");
  const result = store
    .prepare(
      "INSERT INTO partition(name, epoch, status, next_seq, project_id, created_at) VALUES(?, ?, 'ready', 1, ?, ?)",
    )
    .run(name, epoch, options.projectId ?? null, store.now().toISOString());
  return { pid: Number(result.lastInsertRowid), name, epoch, status: "ready", nextSeq: 1 };
}

/** The current (`ready`) generation of a partition name, or null. */
export function currentGeneration(store: EngineStore, name: string): PartitionGeneration | null {
  const row = store
    .prepare(
      "SELECT id, name, epoch, status, next_seq FROM partition WHERE name = ? AND status = 'ready'",
    )
    .get(name) as PartitionRow | undefined;
  return row ? generationOf(row) : null;
}
