import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EngineStore,
  createPartition,
  globalGeneration,
  importLegacyInWorker,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import type { StoreMigrationProgress } from "@claudexor/schema";
import { preserveLegacyJournal, publishImportedStore } from "./sql-import-publication.js";

/** Called only after root-authority acquisition and real recovery-transport
 * proof. Opens one serving store after its sole import writer has closed. */
export async function openSqlStoreAfterTransport(input: {
  daemonDir: string;
  advanceFloor(): void;
  signal?: AbortSignal;
  progress?: (progress: StoreMigrationProgress) => void;
  log?: (message: string) => void;
  importWorkerEntry?: string;
  flusherWorkerEntry?: string;
}): Promise<EngineStore> {
  const database = join(input.daemonDir, "engine.sqlite"),
    journalRoot = join(input.daemonDir, "journal");
  const existing = existsSync(database);
  let imported = false;
  input.signal?.throwIfAborted();
  if (!existing && existsSync(journalRoot)) {
    let latest: StoreMigrationProgress | null = null;
    const receipt = await importLegacyInWorker(
      {
        databasePath: join(input.daemonDir, "engine.sqlite.import"),
        journalRoot,
        resourceStoreDir: join(input.daemonDir, "resource-store"),
      },
      {
        signal: input.signal,
        workerEntry: input.importWorkerEntry,
        onProgress: (progress) => {
          latest = progress;
          input.progress?.(progress);
        },
      },
    );
    input.signal?.throwIfAborted();
    if (latest) input.progress?.({ ...(latest as StoreMigrationProgress), phase: "publishing" });
    publishImportedStore({
      daemonDir: input.daemonDir,
      externalDirectories: receipt.externalDirectories,
      advanceFloor: input.advanceFloor,
    });
    imported = true;
    input.log?.(
      `legacy import published: ${receipt.partitions.length} partitions, ${receipt.compared} comparisons, ${receipt.unclassified} retained unclassified records`,
    );
  } else if (!existing && existsSync(join(input.daemonDir, "engine.sqlite.import"))) {
    throw Object.assign(
      new Error("an unfinished SQL import has no legacy source; preserved for recovery"),
      {
        code: "store_import_source_missing",
        status: 503,
        retryable: false,
      },
    );
  }
  const store = await EngineStore.open({
    daemonDir: input.daemonDir,
    workerEntry: input.flusherWorkerEntry,
    log: input.log,
  });
  try {
    input.signal?.throwIfAborted();
    if (!globalGeneration(store)) {
      if (existing || imported)
        throw Object.assign(new Error("engine store has no global generation"), {
          code: "store_corrupt",
          status: 503,
          retryable: false,
        });
      store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
    }
    if (!imported) {
      store.registerExternal(input.daemonDir);
      await store.flushed();
      input.signal?.throwIfAborted();
      input.advanceFloor();
      preserveLegacyJournal(input.daemonDir);
    }
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}
