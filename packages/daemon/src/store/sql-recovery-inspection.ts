import { createHash } from "node:crypto";
import { JournalRecoveryRequiredError, type JournalRecoveryState } from "./errors.js";
import { ControlJournalInspection, ControlJournalRecoveryState } from "@claudexor/schema";
import { globalGeneration } from "./generations.js";
import { partitionById, type PartitionGeneration } from "./partitions.js";
import type { SqlWriteContext } from "./mutation.js";

export type RecoveryReader = Pick<SqlWriteContext, "prepare">;

/** Current registry authority, including a partition that cannot serve product work. */
export function recoveryGeneration(sql: RecoveryReader, name: string): PartitionGeneration {
  const global = globalGeneration(sql);
  if (name === "global" && global) return global;
  if (global && global.status === "ready") {
    const project = sql
      .prepare(
        `SELECT q.id FROM project p JOIN partition q ON q.id=p.current_pid
      WHERE p.pid=? AND p.status='active' AND q.name=?`,
      )
      .get(global.pid, name) as { id: number } | undefined;
    const generation = project ? partitionById(sql, project.id) : null;
    if (generation) return generation;
  }
  throw Object.assign(new Error(`journal partition is not registered: ${name}`), {
    code: "journal_partition_not_found",
    status: 404,
  });
}

export interface SqlPartitionEvidence {
  storeId: string;
  generation: PartitionGeneration;
  counts: Array<{ type: string; count: number }>;
  fingerprint: string;
}

/** Inspection fingerprints metadata only; command/turn/event bodies stay unopened. */
export function partitionEvidence(
  sql: RecoveryReader,
  generation: PartitionGeneration,
): SqlPartitionEvidence {
  const identity = sql.prepare("SELECT value FROM meta WHERE key='store_id'").get() as
    { value: string } | undefined;
  if (!identity) throw new Error("engine store identity is missing");
  const counts = (
    sql
      .prepare("SELECT type,count(*) AS count FROM event WHERE pid=? GROUP BY type ORDER BY type")
      .all(generation.pid) as Array<{ type: string; count: number | bigint }>
  ).map((row) => ({ type: row.type, count: Number(row.count) }));
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        store_id: identity.value,
        name: generation.name,
        epoch: generation.epoch,
        next_seq: generation.nextSeq,
        counts,
      }),
    )
    .digest("hex");
  return { storeId: identity.value, generation, counts, fingerprint };
}

export function partitionRecovery(
  sql: RecoveryReader,
  generation: PartitionGeneration,
): JournalRecoveryState {
  if (generation.status === "ready") return { status: "ready", discardedTailBytes: 0 };
  const imported = sql
    .prepare("SELECT problem FROM import_partition WHERE pid=? AND problem IS NOT NULL")
    .get(generation.pid) as { problem: string } | undefined;
  if (imported) {
    try {
      const parsed = ControlJournalRecoveryState.parse(JSON.parse(imported.problem));
      if (parsed.status === "recovery_required") return parsed;
    } catch {
      /* Preserve a usable recovery doorway when the original detail is unavailable. */
    }
  }
  const issue = sql
    .prepare("SELECT seq,reason FROM unclassified WHERE pid=? ORDER BY seq LIMIT 1")
    .get(generation.pid) as { seq: number; reason: string } | undefined;
  return {
    status: "recovery_required",
    location: { kind: "cursor", epoch: generation.epoch, seq: issue ? Number(issue.seq) : 0 },
    reason: issue?.reason ?? `partition generation is ${generation.status}`,
    discardedTailBytes: 0,
  };
}

export function inspection(
  sql: RecoveryReader,
  evidence: SqlPartitionEvidence,
  observedAt: string,
): ControlJournalInspection {
  const recovery = partitionRecovery(sql, evidence.generation);
  return ControlJournalInspection.parse({
    schemaVersion: 1,
    partition: evidence.generation.name,
    generation: evidence.generation.pid,
    status: recovery.status,
    recovery,
    fingerprint: evidence.fingerprint,
    observedAt,
    evidenceRefs: [`recovery:${evidence.generation.name}:${evidence.fingerprint}`],
  });
}

export function assertPartitionReadable(
  sql: RecoveryReader,
  generation: PartitionGeneration,
): void {
  const state = partitionRecovery(sql, generation);
  if (state.status === "recovery_required") throw new JournalRecoveryRequiredError(state);
}
