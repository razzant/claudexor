import { LatencyHistogram, processTiming } from "@claudexor/util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isBusyFailure, mapStoreError, StoreCorruptError, StoreError } from "./errors.js";
import { ensureDirectory } from "./external-files.js";
import { FlusherController, type FlusherFacts } from "./flusher.js";
import type { FlusherHooks, FlusherPassReport } from "./flusher-protocol.js";
import { ObservationNotices } from "./observation-notices.js";
import { OwnerGenerations } from "./owner-generations.js";
import { applyPragmas, MAIN_CONNECTION_PRAGMAS } from "./pragmas.js";
import { loadEngineRuntime, type EngineRuntime, type EngineRuntimeProbe } from "./runtime.js";
import { assertSchemaServable, ensureSchema, readSchemaIdentity } from "./schema.js";
import { observeStatement } from "./statement-observer.js";

export interface EngineStoreOptions {
  /** The daemon data root; the store lives at `<daemonDir>/engine.sqlite`. */
  daemonDir: string;
  /** Explicit worker entry (tests: the built `dist/store/flusher-worker.js`). */
  workerEntry?: string;
  flusherHooks?: FlusherHooks;
  now?: () => Date;
  /** Monotonic milliseconds for COMMIT timing (default `performance.now`); injectable. */
  monotonicNow?: () => number;
  log?: (line: string) => void;
  /** Synchronous physical-fault notification; the caller owns serving admission. */
  onCorrupt?: (problem: StoreCorruptError) => void;
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
  /** `transaction()` COMMIT calls since this store opened: a lifetime summary, not a window. */
  commit: {
    attempts: number;
    failures: number;
    last_ms: number | null;
    max_ms: number | null;
    p50_ms: number | null;
    p99_ms: number | null;
  };
  obligations_open: number | null;
  integrity: "pending" | "ok" | "failed";
  /** Legacy-import status; schema upgrades are applied separately by ensureSchema. */
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
  readonly observations = new ObservationNotices();
  private readonly connection: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly flusher: FlusherController;
  private readonly syncedListeners = new Set<SyncedListener>();
  /** Clock for rows the store itself stamps (obligations, meta); injectable. */
  readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private busyWaits = 0;
  /** Constant-space COMMIT timing; only `facts()` reads it. */
  private readonly commitLatency = new LatencyHistogram();
  private readonly commits = {
    attempts: 0,
    failures: 0,
    lastMs: null as number | null,
    maxMs: null as number | null,
  };
  private integrityState: StoreFacts["integrity"] = "pending";
  private closed = false;
  private bodyDirectoryReady = false;
  private closing: Promise<void> | null = null;

  private constructor(
    runtime: EngineRuntime,
    paths: EngineStorePaths,
    connection: DatabaseSync,
    private readonly options: EngineStoreOptions,
    readonly storeId: string | undefined,
  ) {
    this.runtime = runtime;
    this.paths = paths;
    this.connection = connection;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.flusher = new FlusherController({
      dbPath: paths.database,
      ...(options.workerEntry ? { workerEntry: options.workerEntry } : {}),
      ...(options.flusherHooks ? { hooks: options.flusherHooks } : {}),
      ...(options.log ? { log: options.log } : {}),
      onError: (error) => void this.failure(error, "flusher worker"),
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
    let identity: { value: string } | undefined;
    try {
      // Identity first: a foreign or unknown file is refused before the
      // journal-mode or any other write touches it.
      ensureSchemaIdentityOrThrow(connection);
      applyPragmas(connection, MAIN_CONNECTION_PRAGMAS);
      ensureSchema(connection, options.now);
      // The durable UUID belongs to this database, never to a process or path.
      identity = connection.prepare("SELECT value FROM meta WHERE key='store_id'").get() as
        { value: string } | undefined;
    } catch (error) {
      connection.close();
      throw mapStoreError(error, "opening the engine store");
    }
    const store = new EngineStore(runtime, paths, connection, options, identity?.value);
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
      const statement = observeStatement(this.connection.prepare(sql), (error, context) =>
        this.failure(error, context),
      );
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
   * the event loop and break "returned means committed". Only the native COMMIT
   * call is timed for `facts().commit`, including any WAL header sync or
   * automatic checkpoint SQLite runs inside it (see `pragmas.ts`).
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
    // Waiting for the writer lock here is the request thread's own synchronous time.
    const beginStarted = this.monotonicNow();
    try {
      this.exec("BEGIN IMMEDIATE");
    } finally {
      processTiming.recordSync("store.begin_immediate", this.monotonicNow() - beginStarted);
    }
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
      const started = this.monotonicNow();
      try {
        this.connection.exec("COMMIT");
      } catch (error) {
        this.recordCommit(this.monotonicNow() - started, true);
        throw this.failure(error, "committing a transaction");
      }
      this.recordCommit(this.monotonicNow() - started, false);
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

  /** Names a slow external write in the daemon log (`writeExternalFile`). */
  logSlowWrite(line: string): void {
    this.options.log?.(line);
  }

  /**
   * The body directory, for writes staged off the request thread (which create
   * no directory): on first use it is created and each new level registered
   * with the flusher, on the request thread, as a synchronous owner would.
   */
  bodyDirectory(): string {
    if (!this.bodyDirectoryReady) {
      ensureDirectory(this, this.paths.resourceStore);
      ensureDirectory(this, this.paths.blobs);
      this.bodyDirectoryReady = true;
    }
    return this.paths.blobs;
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
  recordIntegrity(
    state: Exclude<StoreFacts["integrity"], "pending">,
    detail = "engine store integrity check failed",
  ): void {
    if (state === "failed") this.failure(new StoreCorruptError(detail), "checking integrity");
    // An older in-flight check cannot clear a physical fault observed meanwhile.
    // A repaired/replaced store opens a new observation lifetime.
    else if (this.integrityState !== "failed") this.integrityState = state;
  }

  facts(): StoreFacts {
    this.assertOpen();
    const flusher = this.flusher.facts();
    let open: number | null = null;
    if (this.integrityState !== "failed") {
      try {
        const row = this.prepare("SELECT count(*) AS n FROM effect_obligation").get() as {
          n: number | bigint;
        };
        open = Number(row.n);
      } catch (error) {
        if (!(error instanceof StoreCorruptError)) throw error;
      }
    }
    return {
      flusher,
      flush_lag_ms: flusher.flush_lag_ms,
      last_barrier_at: flusher.last_barrier_at,
      interval_ms: flusher.interval_ms,
      wal_bytes: flusher.last_pass?.wal_bytes ?? null,
      busy_waits: this.busyWaits,
      commit: {
        p50_ms: this.commitLatency.facts().p50Ms,
        p99_ms: this.commitLatency.facts().p99Ms,
        attempts: this.commits.attempts,
        failures: this.commits.failures,
        last_ms: microsecondMs(this.commits.lastMs),
        max_ms: microsecondMs(this.commits.maxMs),
      },
      obligations_open: open,
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

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.syncedListeners.clear();
    this.closing = this.closeConnections().finally(() => {
      this.closed = !this.connection.isOpen;
      this.closing = null;
    });
    return this.closing;
  }

  private async closeConnections(): Promise<void> {
    let stopFailed = false;
    try {
      await this.flusher.stop();
    } catch (error) {
      stopFailed = true;
      throw error;
    } finally {
      this.statements.clear();
      try {
        if (this.connection.isOpen) this.connection.close();
      } catch (error) {
        // Keep the first failure, while closed still reflects the native state.
        if (!stopFailed) throw error;
      }
    }
  }

  /** The request thread and private worker channels share one error owner. */
  failure(error: unknown, context: string): unknown {
    const mapped = mapStoreError(error, context);
    if (isBusyFailure(mapped)) this.busyWaits += 1;
    if (mapped instanceof StoreCorruptError && this.integrityState !== "failed") {
      this.integrityState = "failed";
      try {
        this.options.onCorrupt?.(mapped);
      } catch {
        // Notification cannot replace the original typed SQL error or recurse
        // through storage-dependent diagnostics. Admission is the caller's owner.
      }
    }
    return mapped;
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new StoreError("store_closed", 503, false, "engine store is closed");
    }
  }

  private recordCommit(elapsedMs: number, failed: boolean): void {
    this.commitLatency.record(elapsedMs);
    processTiming.recordSync("store.commit", elapsedMs);
    this.commits.attempts += 1;
    if (failed) this.commits.failures += 1;
    this.commits.lastMs = elapsedMs;
    this.commits.maxMs = Math.max(this.commits.maxMs ?? elapsedMs, elapsedMs);
  }
}

/** Measured durations keep microsecond resolution; a measured zero stays zero. */
function microsecondMs(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
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
