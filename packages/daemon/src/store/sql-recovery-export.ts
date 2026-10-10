import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, open, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { ControlJournalExportReceipt } from "@claudexor/schema";
import { ControlJournalExportReceipt as Receipt } from "@claudexor/schema";
import { BLOB_OWNER_PREDICATE, type BlobFiles } from "./blob-files.js";
import { StoreError } from "./errors.js";
import type { MaintenanceController } from "./maintenance.js";
import type { EngineStore } from "./store.js";
import {
  partitionEvidence,
  partitionRecovery,
  recoveryGeneration,
} from "./sql-recovery-inspection.js";

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function syncFile(path: string, directory = false): Promise<void> {
  try {
    const fd = await open(path, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  } catch (error) {
    // Directory durability has the existing platform limit; database/body
    // file synchronization never takes this exception.
    if (!directory || process.platform !== "win32") throw error;
  }
}

/** One snapshot bundle, not a second backup authority. Missing required bodies
 * fail the export; concurrent GC never turns a partial copy into a receipt. */
export async function exportSqlRecovery(
  store: EngineStore,
  blobs: BlobFiles,
  maintenance: Pick<MaintenanceController, "exportTo">,
  partition: string,
): Promise<ControlJournalExportReceipt> {
  const exportId = `journal-export-${store.now().getTime().toString(36)}-${randomUUID()}`;
  const exportsRoot = join(dirname(store.paths.database), "recovery-exports");
  await mkdir(exportsRoot, { recursive: true, mode: 0o700 });
  const bundlePath = join(exportsRoot, exportId);
  await mkdir(bundlePath, { mode: 0o700 });
  const databasePath = join(bundlePath, "engine.sqlite");
  try {
    await maintenance.exportTo(databasePath);
    // All evidence, including required body refs, belongs to this exact copy.
    const db = new store.runtime.sqlite.DatabaseSync(databasePath, { readOnly: true });
    let evidence;
    let recovery;
    let required;
    try {
      evidence = partitionEvidence(db, recoveryGeneration(db, partition));
      recovery = partitionRecovery(db, evidence.generation);
      required = db
        .prepare(
          `SELECT sha256,size FROM blob WHERE inline IS NULL AND (${BLOB_OWNER_PREDICATE.replaceAll("?1", "blob.sha256")}) ORDER BY sha256`,
        )
        .all() as Array<{ sha256: string; size: number | bigint }>;
    } finally {
      db.close();
    }
    const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
    if (required.length) await mkdir(join(bundlePath, "blobs"), { mode: 0o700 });
    for (const body of required) {
      const target = join(bundlePath, "blobs", body.sha256);
      await copyFile(blobs.filePath(body.sha256), target, constants.COPYFILE_EXCL);
      const bytes = (await stat(target)).size;
      const sha256 = await digestFile(target);
      if (bytes !== Number(body.size) || sha256 !== body.sha256)
        throw new Error(`SQL body ${body.sha256} does not match its snapshot digest/size`);
      await syncFile(target);
      await chmod(target, 0o400);
      entries.push({ path: `blobs/${body.sha256}`, sha256, bytes });
    }
    await syncFile(databasePath);
    await chmod(databasePath, 0o400);
    entries.unshift({
      path: "engine.sqlite",
      sha256: await digestFile(databasePath),
      bytes: (await stat(databasePath)).size,
    });
    const createdAt = store.now().toISOString();
    const manifest = Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, exportId, partition, fingerprint: evidence.fingerprint, recovery, createdAt, scope: "whole_engine_store", storeId: evidence.storeId, generation: evidence.generation, counts: evidence.counts, entries, externalEvidence: "Per-run event logs, run artifacts and setup operational artifacts remain in their existing locations and are not included." }, null, 2)}\n`,
    );
    const manifestPath = join(bundlePath, "manifest.json");
    const fd = await open(manifestPath, "wx", 0o400);
    try {
      await fd.writeFile(manifest);
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (required.length) await syncFile(join(bundlePath, "blobs"), true);
    await syncFile(bundlePath, true);
    await syncFile(exportsRoot, true);
    return Receipt.parse({
      schemaVersion: 1,
      exportId,
      partition,
      fingerprint: evidence.fingerprint,
      bundlePath,
      manifestSha256: createHash("sha256").update(manifest).digest("hex"),
      createdAt,
    });
  } catch (error) {
    await rm(bundlePath, { recursive: true, force: true });
    throw new StoreError(
      "recovery_export_incomplete",
      503,
      true,
      `SQL recovery export did not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
