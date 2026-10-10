import { InteractionRegistry } from "../interactions.js";
import { LiveInputRegistry } from "../live-input.js";
import { QuotaRegistry } from "../quota-registry.js";
import type { QuotaPacerStateStore } from "../quota-poll-pacer.js";
import type { QuotaRefresher, QuotaVendorRefresher } from "../quota-poll-lanes.js";
import type { QuotaSubjectUniverse } from "../quota-registry.js";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { readJournalEvents } from "./cursors.js";
import { isServedPid } from "./generations.js";
import { SqlInteractionStore } from "./interactions.js";
import { MaintenanceController, type MaintenanceControllerOptions } from "./maintenance.js";
import { Obligations } from "./obligations.js";
import { partitionById } from "./partitions.js";
import { SqlProjectStore } from "./projects.js";
import { SqlPurgeFiles, partitionFilesHandler, type PurgeFilesEffect } from "./purge-files.js";
import { SqlResourceStore } from "./resources.js";
import { SqlCommandRouter } from "./sql-command-router.js";
import type { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";

export interface SqlDaemonServicesOptions {
  purgeFiles: PurgeFilesEffect;
  log?: (line: string) => void;
  refreshers?: readonly (QuotaRefresher | QuotaVendorRefresher)[];
  subjects?: QuotaSubjectUniverse;
  pacerStore?: QuotaPacerStateStore;
  maintenance?: Omit<MaintenanceControllerOptions, "blobs">;
}

/** Builds a complete SQL graph over an already opened store and bound current
 * global generation. Startup/import/recovery admission remain the caller's
 * lifecycle; this factory never discovers roots or selects a second backend. */
export function createSqlDaemonServices(store: EngineStore, options: SqlDaemonServicesOptions) {
  const blobs = new BlobFiles(store);
  let resources: SqlResourceStore;
  const obligations = new Obligations(store, {
    log: options.log,
    onCleared: (rows) => resources.onObligationsCleared(rows),
  });
  const terminalFiles = new SqlTerminalFiles(store, obligations);
  const pruner = new SqlCommandPruner(store, blobs, { log: options.log });
  const projects = new SqlProjectStore(store, blobs, obligations);
  const threads = new SqlCommandRouter(projects, { obligations, terminalFiles, pruner });
  let globalEvents = threads.ledger(projects.global());
  resources = new SqlResourceStore(store, blobs, obligations, options.log);
  const purgeFiles = new SqlPurgeFiles(store, obligations);
  obligations.registerHandler("purge_fs", purgeFiles.handler(options.purgeFiles));
  obligations.registerHandler("archive_fs", partitionFilesHandler(store));
  obligations.registerHandler("quarantine_fs", partitionFilesHandler(store));
  const maintenance = new MaintenanceController(store, {
    ...options.maintenance,
    log: options.log,
    blobs,
  });
  const quotaFor = (events: typeof globalEvents) =>
    new QuotaRegistry(events, options.refreshers, store.now, options.subjects, options.pacerStore);
  let quota = quotaFor(globalEvents);
  const interactions = new InteractionRegistry({
    forRequest: (params) => threads.interactionsForRequest(params),
    forRun: (runId) => threads.interactionsForRun(runId),
  });
  const liveInputs = new LiveInputRegistry({
    pendingForRun: (runId) => interactions.pendingForRun(runId),
  });
  return {
    store,
    blobs,
    obligations,
    terminalFiles,
    pruner,
    projects,
    threads,
    commands: threads,
    get globalEvents() {
      return globalEvents;
    },
    resources,
    purgeFiles,
    maintenance,
    get quota() {
      return quota;
    },
    interactions,
    liveInputs,
    /** Called by the existing global recovery replacement owner after it
     * drains setup and changes the registry generation. Publish both owners
     * together only after the new quota projection validates. */
    rebindGlobal() {
      const generation = projects.global();
      if (generation.pid === globalEvents.generation.pid) return;
      const nextEvents = threads.ledger(generation);
      const nextQuota = quotaFor(nextEvents);
      globalEvents = nextEvents;
      quota = nextQuota;
    },
    journalEvents: (partition: string, afterCursor?: string) =>
      readJournalEvents(store, partition, afterCursor, blobs),
    async recoverAfterStartup() {
      const effects = await obligations.completeOpen();
      // Only generations with unfinished work need recovery. No reconstruction
      // of every project's historical command store on restart.
      const rows = store
        .prepare(
          `SELECT DISTINCT pid FROM command WHERE live=1 AND state IN ('queued','running')
        UNION SELECT DISTINCT pid FROM interaction WHERE state='pending'`,
        )
        .all() as Array<{ pid: number }>;
      for (const { pid } of rows) {
        if (!isServedPid(store, pid)) continue;
        const generation = partitionById(store, pid)!;
        threads.commandStore(generation).recoverAfterStartup();
        new SqlInteractionStore(store, threads.ledger(generation)).recoverAfterStartup();
      }
      threads.recoverRunlessTurns();
      quota.recoverAfterStartup();
      return effects;
    },
    /** Caller closes transports/runners first, then this graph, then its store. */
    async close() {
      await maintenance.stop();
      try {
        await store.flushed();
        await resources.drainCleanup();
      } finally {
        obligations.close();
      }
    },
  };
}
