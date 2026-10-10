import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isBusyFailure, mapStoreError, StoreError } from "./errors.js";
import { FlusherController, type FlusherFacts } from "./flusher.js";
import type { FlusherHooks, FlusherPassReport } from "./flusher-protocol.js";
import { OwnerGenerations } from "./owner-generations.js";
import { applyPragmas, MAIN_CONNECTION_PRAGMAS } from "./pragmas.js";
import { loadEngineRuntime, type EngineRuntime, type EngineRuntimeProbe } from "./runtime.js";
import { assertSchemaServable, ensureSchema, readSchemaIdentity } from "./schema.js";

export interface EngineStoreOptions {
  /** The daemon data root; the store lives at `<daemonDir>/engine.sqlite`. */
  daemonDir: string;
  /** Explicit worker entry (tests: the built `dist/store/flusher-worker.js`). */
  workerEntry?: string;
  flusherHooks?: FlusherHooks;
  now?: () => Date;
  log?: (line: string) => void;
  runtime?: EngineRuntimeProbe;
}

export interface EngineStorePaths {
  database: string;
  wal: string;
  resourceStore: string;
  blobs: string;
  uploads: string;
}

/** Facts for `GET /v2/daemon/status`: measurements, never verdicts. */
export interface StoreFacts {
  flusher: FlusherFacts;
  flush_lag_ms: number;
  last_barrier_at: string | null;
  interval_ms: number;
  wal_bytes: number | null;
  busy_waits: number;
  obligations_open: number;
  integrity: "pending" | "ok" | "failed";
  /** Filled by the importer (PR-D); the store core never migrates. */
  migration: null;
}

export type SyncedListener = (generation: number, report: FlusherPassReport) => void;

/**
 * The engine store adapter (SYNTHESIS_R5 §2, §4.5, §6.1): one `node:sqlite`
 * connection on the request thread — the single row writer — plus the flusher
 * worker that owns the power-loss barrier. `transaction(fn)` is the only way
 * to write: BEGIN IMMEDIATE … COMMIT, ROLLBACK in `finally`, synchronous by
 * contract (a Promise-returning `fn` is rejected). The request thread calls no
 * Node storage-sync primitive; external files are written `O_DSYNC` and their
 * directories are registered for the flusher's pass.
 */
export class EngineStore {
  readonly paths: EngineStorePaths;
  readonly runtime: EngineRuntime;
  /** One owner-change history for every file helper using this connection. */
  readonly owners = new OwnerGenerations(this);
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly flusher: FlusherController;
  private readonly syncedListeners = new Set<SyncedListener>();
  /** Clock for rows the store itself stamps (obligations, meta); injectable. */
  readonly now: () => Date;
  private busyWaits = 0;
  private integrityState: StoreFacts["integrity"] = "pending";
  private closed = false;

  private constructor(
    runtime: EngineRuntime,
    paths: EngineStorePaths,
    connection: DatabaseSync,
    options: EngineStoreOptions,
  ) {
    this.runtime = runtime;
    this.paths = paths;
    this.connection = connection;
    this.now = options.now ?? (() => new Date());
    this.flusher = new FlusherController({
      dbPath: paths.database,
      ...(options.workerEntry ? { workerEntry: options.workerEntry } : {}),
      ...(options.flusherHooks ? { hooks: options.flusherHooks } : {}),
      ...(options.log ? { log: options.log } : {}),
      onSynced: (generation, report) => {
        for (const listener of this.syncedListeners) listener(generation, report);
      },
    });
  }

  /**
   * Prove the runtime, open the database, apply and read back the pragmas,
   * refuse a foreign/unknown schema before any write, create a fresh schema,
   * then start the flusher.
   */
  static async open(options: EngineStoreOptions): Promise<EngineStore> {
    const runtime = await loadEngineRuntime(options.runtime);
    mkdirSync(options.daemonDir, { recursive: true, mode: 0o700 });
    const resourceStore = join(options.daemonDir, "resource-store");
    const paths: EngineStorePaths = {
      database: join(options.daemonDir, "engine.sqlite"),
      wal: join(options.daemonDir, "engine.sqlite-wal"),
      resourceStore,
      blobs: join(resourceStore, "blobs"),
      uploads: join(resourceStore, "uploads"),
    };
    const connection = new runtime.sqlite.DatabaseSync(paths.database, {
      timeout: MAIN_CONNECTION_PRAGMAS["busy_timeout"] as number,
    });
    try {
      // Identity first: a foreign or unknown file is refused before the
      // journal-mode or any other write touches it.
      ensureSchemaIdentityOrThrow(connection);
      applyPragmas(connection, MAIN_CONNECTION_PRAGMAS);
      ensureSchema(connection, options.now);
    } catch (error) {
      connection.close();
      throw mapStoreError(error, "opening the engine store");
    }
    const store = new EngineStore(runtime, paths, connection, options);
    await store.flusher.start();
    return store;
  }

  /** The request-thread connection, for reads and prepared statements. */
  get db(): DatabaseSync {
    this.assertOpen();
    return this.connection;
  }

  /** Prepared statements are cached per SQL text for the connection's life. */
  prepare(sql: string): StatementSync {
    this.assertOpen();
    const cached = this.statements.get(sql);
    if (cached) return cached;
    try {
      const statement = this.connection.prepare(sql);
      this.statements.set(sql, statement);
      return statement;
    } catch (error) {
      throw this.failure(error, "preparing a statement");
    }
  }

  exec(sql: string): void {
    this.assertOpen();
    try {
      this.connection.exec(sql);
    } catch (error) {
      throw this.failure(error, "executing a statement");
    }
  }

  /** True while a `transaction(fn)` body runs on this connection. */
  get inTransaction(): boolean {
    return this.connection.isTransaction;
  }

  /**
   * BEGIN IMMEDIATE … COMMIT with ROLLBACK in `finally`. `fn` must be
   * synchronous: returning a thenable rolls the transaction back and throws,
   * because an await inside a transaction would hold the writer lock across
   * the event loop and break "returned means committed".
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.connection.isTransaction) {
      throw new StoreError(
        "store_transaction_nested",
        500,
        false,
        "engine store transactions do not nest",
      );
    }
    this.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = fn();
      if (isThenable(result)) {
        throw new StoreError(
          "store_transaction_async",
          500,
          false,
          "engine store transaction bodies must be synchronous (a Promise was returned)",
        );
      }
      try {
        this.connection.exec("COMMIT");
      } catch (error) {
        throw this.failure(error, "committing a transaction");
      }
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try {
          this.connection.exec("ROLLBACK");
        } catch {
          /* the body's failure is the report; a failed ROLLBACK leaves no transaction open */
        }
      }
    }
  }

  /** A `{g, dir}` registration after a rename/link in `dir` (SYNTHESIS_R5 §4.4). */
  registerExternal(dir: string): number {
    this.assertOpen();
    return this.flusher.register(dir);
  }

  /** A generation covering every commit so far, acknowledged by the next pass (no waiter). */
  mark(): number {
    this.assertOpen();
    return this.flusher.mark();
  }

  /** Resolves after the next pass that started after this call proved its barrier. */
  flushed(): Promise<void> {
    this.assertOpen();
    return this.flusher.flushed();
  }

  /** Resolves once the pass covering an already issued generation proved its barrier. */
  synced(generation: number): Promise<void> {
    this.assertOpen();
    return this.flusher.awaitGeneration(generation);
  }

  /** The last generation a pass acknowledged. */
  get acknowledgedGeneration(): number {
    return this.flusher.facts().acknowledged_generation;
  }

  /** Observe `synced(G)` (obligations clear themselves through this). */
  onSynced(listener: SyncedListener): () => void {
    this.syncedListeners.add(listener);
    return () => void this.syncedListeners.delete(listener);
  }

  /** Recorded by the maintenance controller after its integrity check. */
  recordIntegrity(state: Exclude<StoreFacts["integrity"], "pending">): void {
    this.integrityState = state;
  }

  facts(): StoreFacts {
    this.assertOpen();
    const flusher = this.flusher.facts();
    const open = this.prepare("SELECT count(*) AS n FROM effect_obligation").get() as {
      n: number | bigint;
    };
    return {
      flusher,
      flush_lag_ms: flusher.flush_lag_ms,
      last_barrier_at: flusher.last_barrier_at,
      interval_ms: flusher.interval_ms,
      wal_bytes: flusher.last_pass?.wal_bytes ?? null,
      busy_waits: this.busyWaits,
      obligations_open: Number(open.n),
      integrity: this.integrityState,
      migration: null,
    };
  }

  /** Test seam into the flusher (manual ticks, worker exit). */
  get flusherControl(): Pick<FlusherController, "tick" | "requestExit"> {
    return this.flusher;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.syncedListeners.clear();
    await this.flusher.stop();
    this.statements.clear();
    this.connection.close();
  }

  private failure(error: unknown, context: string): unknown {
    const mapped = mapStoreError(error, context);
    if (isBusyFailure(mapped)) this.busyWaits += 1;
    return mapped;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StoreError("store_closed", 503, false, "engine store is closed");
    }
  }
}

function ensureSchemaIdentityOrThrow(db: DatabaseSync): void {
  // ensureSchema() repeats this check after the pragmas; the early call keeps
  // "refused before any write" literal (journal_mode=WAL writes the header).
  assertSchemaServable(readSchemaIdentity(db));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
