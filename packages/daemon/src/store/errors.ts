import type { ControlJournalInspection } from "@claudexor/schema";

export type JournalRecoveryState = ControlJournalInspection["recovery"];

export class JournalRecoveryRequiredError extends Error {
  readonly code: string = "journal_recovery_required";
  readonly status = 503;
  readonly retryable = false;
  readonly requiredActions = ["inspect_recovery", "export_recovery", "quarantine_partition"];
  readonly evidenceRefs: string[] = [];
  readonly recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>;

  constructor(recovery: Extract<JournalRecoveryState, { status: "recovery_required" }>) {
    const safe = Object.freeze({ ...recovery, location: Object.freeze({ ...recovery.location }) });
    const where =
      safe.location.kind === "byte"
        ? `byte ${safe.location.byteOffset}`
        : `cursor ${safe.location.epoch}:${safe.location.seq}`;
    super(`journal partition requires recovery at ${where}: ${safe.reason}`);
    this.name = "JournalRecoveryRequiredError";
    this.recovery = safe;
  }
}

/**
 * Typed failures of the engine store. Every error carries the `code` /
 * `status` / `retryable` triple the daemon's problem projection already
 * understands (`rpc-problem.ts`, control-api problem mapping), so no consumer
 * needs a new enum value: a dispatch that cannot be flushed stays
 * `not_started` with this problem attached, an account reset becomes
 * `completed/unavailable` with `detail: store_flush_unavailable`.
 */
export class StoreError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    status: number,
    retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StoreError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** The running Node lacks `node:sqlite` or bundles a SQLite older than the
 * WAL-reset corruption fix (3.51.3). Raised before any root is touched. */
export class EngineRuntimeUnsupportedError extends StoreError {
  readonly nodeVersion: string;
  readonly sqliteVersion: string | null;
  readonly requiredSqlite: string;

  constructor(input: {
    nodeVersion: string;
    sqliteVersion: string | null;
    requiredSqlite: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      "engine_runtime_unsupported",
      503,
      false,
      `engine runtime unsupported: ${input.detail} (node ${input.nodeVersion}, sqlite ${input.sqliteVersion ?? "absent"}, requires sqlite >= ${input.requiredSqlite})`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = "EngineRuntimeUnsupportedError";
    this.nodeVersion = input.nodeVersion;
    this.sqliteVersion = input.sqliteVersion;
    this.requiredSqlite = input.requiredSqlite;
  }
}

/** The database file carries another application's id or a schema version
 * this engine cannot serve. Raised before any write. */
export class StoreSchemaUnsupportedError extends StoreError {
  readonly applicationId: number;
  readonly userVersion: number;

  constructor(input: { applicationId: number; userVersion: number; detail: string }) {
    super(
      "store_schema_unsupported",
      503,
      false,
      `engine store schema unsupported: ${input.detail} (application_id ${input.applicationId}, user_version ${input.userVersion})`,
    );
    this.name = "StoreSchemaUnsupportedError";
    this.applicationId = input.applicationId;
    this.userVersion = input.userVersion;
  }
}

/** The flusher died before the requested generation was proven durable. The
 * commit itself is intact (crash-class); only the power-loss barrier is
 * unproven. A false refusal after an already completed barrier is safe. */
export class StoreFlushUnavailableError extends StoreError {
  readonly generation: number;

  constructor(generation: number, detail: string) {
    super(
      "store_flush_unavailable",
      503,
      true,
      `engine store flush unavailable for generation ${generation}: ${detail}`,
    );
    this.name = "StoreFlushUnavailableError";
    this.generation = generation;
  }
}

/** ENOSPC / SQLITE_FULL on the database or an external file. */
export class StoreFullError extends StoreError {
  constructor(detail: string, cause?: unknown) {
    super(
      "store_full",
      507,
      true,
      `engine store is out of space: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "StoreFullError";
  }
}

/** SQLITE_CORRUPT / SQLITE_NOTADB surfaced by a statement. */
export class StoreCorruptError extends StoreError {
  constructor(detail: string, cause?: unknown) {
    super(
      "store_corrupt",
      503,
      false,
      `engine store is corrupt: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "StoreCorruptError";
  }
}

/** The busy fuse blew: a statement waited the whole busy timeout. */
export class StoreBusyError extends StoreError {
  constructor(detail: string, cause?: unknown) {
    super(
      "store_busy",
      503,
      true,
      `engine store is busy: ${detail}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "StoreBusyError";
  }
}

interface SqliteErrorShape {
  code?: unknown;
  errcode?: unknown;
  errstr?: unknown;
  message?: unknown;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

/** Primary SQLite result code of a `node:sqlite` error, or null for any other error. */
export function sqlitePrimaryCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const shape = error as SqliteErrorShape;
  if (shape.code !== "ERR_SQLITE_ERROR" || typeof shape.errcode !== "number") return null;
  return shape.errcode & 0xff;
}

/** Map a statement failure to the store's typed classes; anything else is returned as is. */
export function mapStoreError(error: unknown, context: string): unknown {
  if (error instanceof StoreError) return error;
  const primary = sqlitePrimaryCode(error);
  const detail = `${context}: ${error instanceof Error ? error.message : String(error)}`;
  if (primary === SQLITE_FULL) return new StoreFullError(detail, error);
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB)
    return new StoreCorruptError(detail, error);
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED)
    return new StoreBusyError(detail, error);
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOSPC")
    return new StoreFullError(detail, error);
  return error;
}

/** Whether a mapped error means the busy fuse blew (counted as `busy_waits`). */
export function isBusyFailure(error: unknown): boolean {
  return error instanceof StoreBusyError;
}
