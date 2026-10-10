import {
  EngineStore,
  EngineStateRecovery,
  SqlPartitionRecovery,
  SqlEventLedger,
  createPartition,
  createSqlDaemonServices,
  globalGeneration,
  setGlobalGenerationInTx,
  sqlRecoveryProjections,
  recoveryOnlyRefusal,
  type PartitionControlPort,
} from "@claudexor/daemon";
import type { DaemonStoreFacts, StoreMigrationProgress } from "@claudexor/schema";
import { SqlSetupJobStore } from "./sql-setup-store.js";
import { openSqlStoreAfterTransport } from "./sql-startup-storage.js";

type Graph = ReturnType<typeof createSqlDaemonServices>;

/** Storage ownership for the one daemon. Transport and setup retain their
 * existing owners; a physical replacement closes them before closing SQL. */
export class SqlDaemonStorage {
  /** Acquisition precedes graph construction, which can fail on a SQL read. */
  private storeValue: EngineStore | null = null;
  private graphValue: Graph | null = null;
  private problem: Error | null = null;
  private migration: StoreMigrationProgress | null = null;
  readonly engineRecovery: EngineStateRecovery;
  constructor(
    private readonly options: {
      rootDir: string;
      graph: Parameters<typeof createSqlDaemonServices>[1];
      advanceFloor(): void;
      beforeClose(): Promise<void>;
      onOpen(graph: Graph): void;
      onCorrupt(error: Error): void;
      log(message: string): void;
      importWorkerEntry?: string;
      flusherWorkerEntry?: string;
    },
  ) {
    this.engineRecovery = new EngineStateRecovery(options.rootDir, {
      state: () => ({
        generation:
          this.graphValue && !this.problem
            ? (globalGeneration(this.graphValue.store)?.pid ?? 0)
            : 0,
        recovery: this.problem
          ? {
              status: "recovery_required",
              location: { kind: "byte", byteOffset: 0 },
              reason: this.problem.message,
              discardedTailBytes: 0,
            }
          : { status: "ready", discardedTailBytes: 0 },
      }),
      validate: async () => {
        if (!this.graphValue)
          return { ok: false, detail: this.problem?.message ?? "engine store is not open" };
        const result = await this.graphValue.maintenance.integrityCheck();
        return {
          ok: result.ok,
          detail: result.problems.length ? result.problems.join("; ") : null,
        };
      },
      close: async () => {
        await options.beforeClose();
        await this.close(true);
      },
      createFresh: (identity) => this.createFresh(identity),
    });
  }
  graph(): Graph {
    if (!this.graphValue) throw recoveryOnlyRefusal("engine store");
    return this.graphValue;
  }
  facts(): DaemonStoreFacts {
    return {
      ...(this.graphValue?.store.facts() ?? {
        flusher: null,
        flush_lag_ms: null,
        last_barrier_at: null,
        interval_ms: null,
        wal_bytes: null,
        busy_waits: null,
        obligations_open: null,
        integrity: this.problem ? ("failed" as const) : null,
      }),
      migration: this.migration,
    };
  }
  readonly corrupt = (cause: unknown): void => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.problem = error;
    this.options.onCorrupt(error);
  };
  async open(signal?: AbortSignal): Promise<void> {
    try {
      // Accepted recovery intent outranks ordinary import/database selection.
      const resumed = await this.engineRecovery.resumePending();
      if (resumed) return;
      const store = await openSqlStoreAfterTransport({
        daemonDir: this.options.rootDir,
        advanceFloor: this.options.advanceFloor,
        signal,
        progress: (progress) => {
          this.migration = progress;
        },
        log: this.options.log,
        importWorkerEntry: this.options.importWorkerEntry,
        flusherWorkerEntry: this.options.flusherWorkerEntry,
        onCorrupt: this.corrupt,
      });
      this.storeValue = store;
      try {
        this.attach(store);
      } catch (error) {
        await this.closeAfterFailedOpen(error);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "store_corrupt") this.corrupt(error);
      if (this.migration) this.migration = { ...this.migration, phase: "failed" };
      throw error;
    }
  }
  partition(name: string): PartitionControlPort {
    if (name === "engine-state") return this.engineRecovery;
    const graph = this.graph();
    return new SqlPartitionRecovery(graph.store, graph.blobs, graph.maintenance, name, {
      projections: (generation) =>
        sqlRecoveryProjections(graph.store, graph.blobs, generation, (value) =>
          new SqlSetupJobStore(
            this.options.rootDir,
            graph.store,
            new SqlEventLedger(graph.store, graph.blobs, value),
          ).validateProjection(),
        ),
      onPhysicalCorruption: this.corrupt,
    });
  }
  /** A logical project fault is isolated by the registry/current-pid queries.
   * Only the shared global authority blocks the whole product plane. */
  blockedPartitions(): string[] {
    const global = globalGeneration(this.graph().store);
    return !global || global.status !== "ready" ? ["global"] : [];
  }
  /** Always join every storage participant before reporting successful close. */
  async close(physicalRecovery = false): Promise<void> {
    const store = this.storeValue,
      graph = this.graphValue;
    if (!store) return;
    let failure: unknown;
    try {
      await graph?.close();
    } catch (error) {
      failure = error;
    }
    try {
      await store.close();
    } catch (error) {
      failure ??= error;
    }
    if (store.isClosed) {
      this.storeValue = null;
      this.graphValue = null;
    }
    if (failure && !(physicalRecovery && store.isClosed && storageFailure(failure))) throw failure;
    if (failure) this.options.log(`closed corrupt store: ${String(failure)}`);
  }
  private attach(store: EngineStore): void {
    this.graphValue = createSqlDaemonServices(store, this.options.graph);
    this.problem = null;
    this.migration = null;
    this.options.onOpen(this.graphValue);
  }
  private async createFresh(identity: { operationId: string; newEpoch: string }): Promise<void> {
    const store = await EngineStore.open({
      daemonDir: this.options.rootDir,
      workerEntry: this.options.flusherWorkerEntry,
      onCorrupt: this.corrupt,
      log: this.options.log,
    });
    this.storeValue = store;
    try {
      const current = globalGeneration(store);
      const prior = store
        .prepare("SELECT value FROM meta WHERE key='engine_recovery_operation'")
        .get() as { value: string } | undefined;
      if (current) {
        if (current.epoch !== identity.newEpoch || prior?.value !== identity.operationId)
          throw new Error("fresh engine state does not match the accepted recovery operation");
      } else
        store.transaction(() => {
          setGlobalGenerationInTx(
            store,
            createPartition(store, "global", { epoch: identity.newEpoch }).pid,
          );
          store
            .prepare("INSERT INTO meta(key,value) VALUES('engine_recovery_operation',?)")
            .run(identity.operationId);
        });
      store.registerExternal(this.options.rootDir);
      await store.flushed();
      this.options.advanceFloor();
      this.attach(store);
    } catch (error) {
      await this.closeAfterFailedOpen(error);
    }
  }
  private async closeAfterFailedOpen(primary: unknown): Promise<never> {
    try {
      await this.close();
    } catch (error) {
      this.options.log(`engine store cleanup after failed open also failed: ${String(error)}`);
    } finally {
      // Cleanup (including diagnostics) cannot replace the initiating failure.
      // An unclosed store remains owned for the next explicit close.
      throw primary;
    }
  }
}
function storageFailure(error: unknown): boolean {
  return ["store_corrupt", "store_flush_unavailable"].includes(
    (error as { code?: string })?.code ?? "",
  );
}
