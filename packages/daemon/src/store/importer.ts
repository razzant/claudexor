import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ThreadHeadPing } from "@claudexor/schema";
import { deleteUnownedInlineInTx } from "./blob-files.js";
import { setGlobalGenerationInTx, reconcileLiveInTx } from "./generations.js";
import { ImportContext, importError } from "./import-context.js";
import { prepareImportRecords } from "./import-records.js";
import { prepareImportResources, type ImportResourceReceipt } from "./import-resources.js";
import {
  assertImportSourceUnchanged,
  readImportSource,
  type ImportPartitionSource,
  type ImportSource,
} from "./import-source.js";
import { verifyImportedPartition } from "./import-verify.js";
import { insertPartitionInTx } from "./partitions.js";
import { applyImportedHeadRevision } from "./thread-rows.js";
import { loadEngineRuntime } from "./runtime.js";
import { assertSchemaServable, ensureSchema, readSchemaIdentity } from "./schema.js";

export interface ImportProgress {
  phase: "reading" | "importing" | "verifying" | "complete";
  completedPartitions: number;
  totalPartitions: number;
  currentPartition: string | null;
  processedBytes: number;
  totalBytes: number;
}
export interface LegacyImportOptions {
  databasePath: string;
  journalRoot: string;
  resourceStoreDir: string;
  partitions: readonly ImportPartitionSource[];
  onProgress?: (progress: ImportProgress) => void;
  now?: () => Date;
}
export interface ImportedPartitionReceipt {
  name: string;
  pid: number;
  epoch: string;
  nextSeq: number;
  previousFrameHash: string;
  fingerprint: string;
  records: number;
  status: "ready" | "recovery_required";
  reused: boolean;
  discardedTailBytes: number;
}
export interface LegacyImportReceipt {
  databasePath: string;
  partitions: ImportedPartitionReceipt[];
  resources: ImportResourceReceipt;
  compared: number;
  unclassified: number;
  externalDirectories: string[];
}
type Marker = {
  pid: number;
  epoch: string;
  source_size: number;
  source_mtime: string;
  fingerprint: string;
  status: string;
};

/** One closed temp SQLite result. Root authority, discovery, fsync/floor and
 * publication renames belong to the calling startup owner. */
export async function runLegacyImport(options: LegacyImportOptions): Promise<LegacyImportReceipt> {
  const databasePath = resolve(options.databasePath);
  if (basename(databasePath) !== "engine.sqlite.import")
    throw importError("store_import_target_invalid", "import target must be engine.sqlite.import");
  const runtime = await loadEngineRuntime();
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  let db: DatabaseSync | null = null;
  let receipt: LegacyImportReceipt;
  const now = options.now ?? (() => new Date());
  const ordered = options.partitions
    .map((source) => ({ source, size: sourceSize(source) }))
    .sort((a, b) => a.size - b.size || a.source.name.localeCompare(b.source.name));
  if (new Set(ordered.map(({ source }) => source.name)).size !== ordered.length)
    throw importError("store_import_source_invalid", "duplicate partition name");
  const totalBytes = ordered.reduce((sum, item) => sum + item.size, 0);
  const progress = (
    phase: ImportProgress["phase"],
    completedPartitions: number,
    currentPartition: string | null,
    processedBytes: number,
  ) =>
    options.onProgress?.({
      phase,
      completedPartitions,
      totalPartitions: ordered.length,
      currentPartition,
      processedBytes,
      totalBytes,
    });
  try {
    db = new runtime.sqlite.DatabaseSync(databasePath);
    // Resume validation uses this same writer, never a progress/read connection.
    let intact = true;
    try {
      intact = db
        .prepare("PRAGMA integrity_check")
        .all()
        .every((row) => Object.values(row)[0] === "ok");
    } catch {
      intact = false;
    }
    if (!intact) {
      db.close();
      db = null;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(databasePath + suffix, { force: true });
      db = new runtime.sqlite.DatabaseSync(databasePath);
    }
    assertSchemaServable(readSchemaIdentity(db));
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=4000;",
    );
    ensureSchema(db, now);
    const sql = new ImportContext(db, join(options.resourceStoreDir, "blobs"));
    const partitions: ImportedPartitionReceipt[] = [];
    let processedBytes = 0;
    for (const { source } of ordered) {
      progress("reading", partitions.length, source.name, processedBytes);
      const prior = sql
        .prepare(
          "SELECT pid,epoch,source_size,source_mtime,fingerprint,status FROM import_partition WHERE name=?",
        )
        .get(source.name) as Marker | undefined;
      const input = readImportSource(options.journalRoot, source, prior?.epoch);
      const reused =
        prior?.status === "complete" &&
        prior.source_size === input.size &&
        prior.source_mtime === input.mtime &&
        prior.fingerprint === input.fingerprint;
      progress("importing", partitions.length, source.name, processedBytes);
      const prepared = reused ? null : prepareImportRecords(sql, input.records);
      const pid = reused
        ? prior.pid
        : sql.transaction(() => {
            if (prior) clearImportedPartition(sql, prior.pid);
            const partition = insertPartitionInTx(sql, {
              name: source.name,
              epoch: input.epoch,
              createdAt: input.records[0]?.time ?? now().toISOString(),
              nextSeq: input.nextSeq,
              status: input.recovery.status,
              projectId: source.name.startsWith("project:") ? source.name.slice(8) : null,
            });
            prepared!(partition.pid);
            assertImportSourceUnchanged(options.journalRoot, source, input.fingerprint);
            writeMarker(sql, partition.pid, input);
            return partition.pid;
          });
      partitions.push({
        name: source.name,
        pid,
        epoch: input.epoch,
        nextSeq: input.nextSeq,
        previousFrameHash: input.previousFrameHash,
        fingerprint: input.fingerprint,
        records: input.records.length,
        status: input.recovery.status,
        reused,
        discardedTailBytes: input.discardedTailBytes,
      });
      processedBytes += input.size;
    }
    const resources = sql.transaction(
      prepareImportResources(options.resourceStoreDir).bind(null, sql),
    );
    sql.transaction(() => bindImportedRegistry(sql));
    let compared = 0;
    processedBytes = 0;
    for (const partition of partitions) {
      progress("verifying", partitions.indexOf(partition), partition.name, processedBytes);
      const source = ordered.find((entry) => entry.source.name === partition.name)!.source;
      const input = readImportSource(options.journalRoot, source, partition.epoch);
      if (input.fingerprint !== partition.fingerprint)
        throw importError("store_import_source_changed", `journal source changed: ${source.name}`);
      compared += verifyImportedPartition(sql, input, partition.pid);
      processedBytes += input.size;
    }
    receipt = {
      databasePath,
      partitions,
      resources,
      compared,
      unclassified: Number(
        (sql.prepare("SELECT count(*) AS n FROM unclassified").get() as { n: number }).n,
      ),
      externalDirectories: [...sql.externalDirectories].sort(),
    };
    db.exec("PRAGMA synchronous=NORMAL");
    sql.transaction(() =>
      sql
        .prepare(
          "INSERT INTO meta(key,value) VALUES('migration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify(receipt)),
    );
    db.exec("PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db?.close();
  }
  // B3: recovery may reopen only AFTER the first connection is closed.
  if (existsSync(databasePath + "-wal")) {
    const cleanup = new runtime.sqlite.DatabaseSync(databasePath);
    try {
      cleanup.exec("PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      cleanup.close();
    }
    if (existsSync(databasePath + "-wal"))
      throw importError("store_import_wal_present", "temp import WAL remains after close");
  }
  progress("complete", ordered.length, null, totalBytes);
  return receipt!;
}

function sourceSize(source: ImportPartitionSource): number {
  const path = join(source.directory, "journal.bin");
  return existsSync(path) ? statSync(path).size : 0;
}

function writeMarker(sql: ImportContext, pid: number, input: ImportSource): void {
  sql
    .prepare(
      `INSERT INTO import_partition(name,status,pid,epoch,next_seq,previous_frame_hash,source_size,source_mtime,fingerprint,records,digest,problem)
    VALUES(?,'complete',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET status=excluded.status,pid=excluded.pid,epoch=excluded.epoch,
    next_seq=excluded.next_seq,previous_frame_hash=excluded.previous_frame_hash,source_size=excluded.source_size,source_mtime=excluded.source_mtime,
    fingerprint=excluded.fingerprint,records=excluded.records,digest=excluded.digest,problem=excluded.problem`,
    )
    .run(
      input.source.name,
      pid,
      input.epoch,
      input.nextSeq,
      input.previousFrameHash,
      input.size,
      input.mtime,
      input.fingerprint,
      input.records.length,
      input.digest,
      input.recovery.status === "ready" ? null : JSON.stringify(input.recovery),
    );
}

function clearImportedPartition(sql: ImportContext, pid: number): void {
  const refs = sql
    .prepare(
      `SELECT params_sha AS sha FROM command WHERE pid=?1 UNION SELECT result_sha FROM command WHERE pid=?1
    UNION SELECT prompt_sha FROM turn WHERE pid=?1 UNION SELECT payload_sha FROM event WHERE pid=?1`,
    )
    .all(pid) as Array<{ sha: string | null }>;
  for (const table of [
    "command",
    "thread",
    "turn",
    "session",
    "lane_checkpoint",
    "interaction",
    "operator_decision",
    "project",
    "run_terminal",
    "effect_obligation",
    "idempotency",
    "event",
    "unclassified",
  ])
    sql.prepare(`DELETE FROM ${table} WHERE pid=?`).run(pid);
  sql.prepare("DELETE FROM partition WHERE id=?").run(pid);
  for (const { sha } of refs) if (sha) deleteUnownedInlineInTx(sql, sha);
}

function bindImportedRegistry(sql: ImportContext): void {
  const global = sql.prepare("SELECT id FROM partition WHERE name='global'").get() as
    { id: number } | undefined;
  sql
    .prepare(
      "UPDATE project SET current_pid=(SELECT id FROM partition WHERE name='project:'||project.id)",
    )
    .run();
  if (global) setGlobalGenerationInTx(sql, global.id);
  reconcileLiveInTx(sql);
  sql.prepare("UPDATE thread SET head_revision=0").run();
  sql.prepare("DELETE FROM pruned_root").run();
  for (const row of sql
    .prepare(
      "SELECT type,payload,payload_sha FROM event WHERE type IN ('thread.head.updated','command.pruned') ORDER BY pid,seq",
    )
    .iterate() as Iterable<{ type: string; payload: Uint8Array; payload_sha: string | null }>) {
    const payload = JSON.parse(
      (row.payload_sha ? sql.read(row.payload_sha) : Buffer.from(row.payload)).toString("utf8"),
    );
    if (row.type === "thread.head.updated") {
      const ping = ThreadHeadPing.safeParse(payload);
      if (ping.success) applyImportedHeadRevision(sql, ping.data.thread_id, ping.data.revision);
    } else if (Array.isArray(payload.roots))
      for (const root of payload.roots)
        if (typeof root === "string" && root)
          sql.prepare("INSERT OR IGNORE INTO pruned_root(root) VALUES(?)").run(root);
  }
}
