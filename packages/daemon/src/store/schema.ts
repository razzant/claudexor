import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StoreSchemaUnsupportedError } from "./errors.js";

/** `PRAGMA application_id` of every engine store ("CXEN"). */
export const ENGINE_APPLICATION_ID = 0x4358454e;
/** `PRAGMA user_version`: the one schema this engine creates and serves. */
export const ENGINE_SCHEMA_VERSION = 1;

/**
 * SYNTHESIS_R5 §5 with R5_AMENDMENTS A1 (`command.kind`/`live` replace
 * `retention_exempt`; obligation `state`/`materialized_g`). STRICT everywhere; WITHOUT ROWID where the
 * primary key is the access path; partial indexes carry the retention and
 * listing predicates so a query over the current generation never visits
 * history. `pid` is the surrogate of one partition generation and the only
 * partition key a row carries.
 */
export const ENGINE_SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE partition(id INTEGER PRIMARY KEY, name TEXT NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL,
  next_seq INTEGER NOT NULL, project_id TEXT, created_at TEXT NOT NULL, UNIQUE(name, epoch)) STRICT;
CREATE TABLE event(pid INTEGER NOT NULL, seq INTEGER NOT NULL, time TEXT NOT NULL, type TEXT NOT NULL,
  payload BLOB NOT NULL, payload_sha TEXT, slot_key TEXT, group_key TEXT, PRIMARY KEY(pid, seq)) WITHOUT ROWID, STRICT;
CREATE INDEX event_type    ON event(pid, type, seq);
CREATE INDEX event_slot    ON event(pid, slot_key)  WHERE slot_key  IS NOT NULL;
CREATE INDEX event_group   ON event(pid, group_key) WHERE group_key IS NOT NULL;
CREATE INDEX event_payload ON event(payload_sha)    WHERE payload_sha IS NOT NULL;
CREATE INDEX event_command_age ON event(time,pid,seq) WHERE type IN ('command.accepted','command.updated');
CREATE TABLE blob(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, inline BLOB) STRICT;
CREATE TABLE command(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL, client_id TEXT,
  run_id TEXT, task_id TEXT, run_dir TEXT, thread_id TEXT, turn_id TEXT, delegated_from TEXT, continue_from TEXT, scope_root TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, summary BLOB NOT NULL, params_sha TEXT NOT NULL, result_sha TEXT,
  error BLOB, last_event_seq INTEGER, response_state TEXT, response_expires_at TEXT, request_resource_id TEXT, response_resource_id TEXT,
  kind TEXT NOT NULL, live INTEGER NOT NULL DEFAULT 1, needs_decision INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX command_run       ON command(run_id);
CREATE INDEX command_partition ON command(pid);
CREATE INDEX command_active    ON command(state, pid) WHERE live = 1 AND state IN ('queued','running');
CREATE INDEX command_thread    ON command(thread_id, state);
CREATE INDEX command_turn      ON command(turn_id, created_at);
CREATE INDEX command_request_resource ON command(request_resource_id) WHERE request_resource_id IS NOT NULL;
CREATE INDEX command_response_resource ON command(response_resource_id) WHERE response_resource_id IS NOT NULL;
CREATE INDEX command_parent    ON command(delegated_from);
CREATE INDEX command_continue  ON command(continue_from);
CREATE INDEX command_list      ON command(created_at DESC, id DESC)        WHERE live = 1 AND kind = 'product';
CREATE INDEX command_list_state ON command(state, created_at DESC, id DESC) WHERE live = 1 AND kind = 'product';
CREATE INDEX command_terminal  ON command(created_at, id)
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL;
CREATE INDEX command_prunable  ON command(created_at, id)
  WHERE live = 1 AND kind IN ('product','delivery','maintenance') AND finished_at IS NOT NULL AND needs_decision = 0;
CREATE INDEX command_expiry    ON command(response_state, response_expires_at) WHERE kind = 'model';
CREATE INDEX command_maintenance_harness ON command(json_extract(CAST(summary AS TEXT),'$.params.harness'),created_at)
  WHERE live=1 AND kind='maintenance';
CREATE INDEX command_params    ON command(params_sha);
CREATE INDEX command_result    ON command(result_sha) WHERE result_sha IS NOT NULL;
CREATE TABLE run_terminal(run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, event BLOB NOT NULL) STRICT;
CREATE TABLE effect_obligation(kind TEXT NOT NULL, key TEXT NOT NULL, pid INTEGER NOT NULL, created_at TEXT NOT NULL, payload BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', materialized_g INTEGER, PRIMARY KEY(kind, key)) WITHOUT ROWID, STRICT;
CREATE TABLE idempotency(owner TEXT NOT NULL, pid INTEGER NOT NULL, key_digest TEXT NOT NULL, operation TEXT NOT NULL,
  request_digest TEXT NOT NULL, target_id TEXT NOT NULL, result BLOB, created_at TEXT NOT NULL,
  PRIMARY KEY(owner, pid, key_digest)) WITHOUT ROWID, STRICT;
CREATE INDEX idempotency_target ON idempotency(target_id);
CREATE TABLE thread(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
  head_revision INTEGER NOT NULL DEFAULT 0, body BLOB NOT NULL) STRICT;
CREATE INDEX thread_list ON thread(pid, state, updated_at DESC);
CREATE TABLE turn(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, run_id TEXT,
  created_at TEXT NOT NULL, prompt_sha TEXT NOT NULL, body BLOB NOT NULL) STRICT;
CREATE UNIQUE INDEX turn_thread ON turn(thread_id, ordinal);
CREATE UNIQUE INDEX turn_run    ON turn(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX turn_prompt        ON turn(prompt_sha);
CREATE TABLE session(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, harness_id TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', pid INTEGER NOT NULL,
  insertion_ordinal INTEGER NOT NULL DEFAULT 0, body BLOB NOT NULL) WITHOUT ROWID, STRICT;
CREATE INDEX session_lane ON session(thread_id, harness_id, profile_id);
CREATE INDEX session_order ON session(thread_id, insertion_ordinal);
CREATE INDEX session_partition ON session(pid, insertion_ordinal);
CREATE TABLE lane_checkpoint(thread_id TEXT NOT NULL, harness_id TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', pid INTEGER NOT NULL,
  insertion_ordinal INTEGER NOT NULL DEFAULT 0, turn_id TEXT NOT NULL, body BLOB NOT NULL, PRIMARY KEY(thread_id, harness_id, profile_id)) WITHOUT ROWID, STRICT;
CREATE INDEX lane_checkpoint_order ON lane_checkpoint(thread_id, insertion_ordinal);
CREATE INDEX lane_checkpoint_partition ON lane_checkpoint(pid, insertion_ordinal);
CREATE TABLE interaction(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, run_id TEXT NOT NULL, state TEXT NOT NULL,
  request BLOB NOT NULL, resolution BLOB) STRICT;
CREATE INDEX interaction_pending ON interaction(run_id) WHERE state = 'pending';
CREATE INDEX interaction_run ON interaction(run_id);
CREATE INDEX interaction_partition_pending ON interaction(pid,run_id) WHERE state = 'pending';
CREATE TABLE operator_decision(run_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, body BLOB NOT NULL) STRICT;
CREATE TABLE project(id TEXT PRIMARY KEY, pid INTEGER NOT NULL, root TEXT NOT NULL, status TEXT NOT NULL,
  current_pid INTEGER, creation_key_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, body BLOB NOT NULL) STRICT;
CREATE UNIQUE INDEX project_root_active ON project(pid, root) WHERE status = 'active';
CREATE INDEX project_current_pid ON project(current_pid) WHERE status = 'active';
CREATE TABLE pruned_root(root TEXT PRIMARY KEY) STRICT;
CREATE TABLE resource(id TEXT PRIMARY KEY, purpose TEXT, kind TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, released_at TEXT, body BLOB NOT NULL) STRICT;
CREATE INDEX resource_sha    ON resource(sha256);
CREATE INDEX resource_expiry ON resource(state, expires_at);
CREATE TABLE upload(id TEXT PRIMARY KEY, state TEXT NOT NULL, received_bytes INTEGER NOT NULL, expected_bytes INTEGER,
  finalize_sha TEXT, body BLOB NOT NULL) STRICT;
CREATE INDEX upload_finalize ON upload(finalize_sha) WHERE finalize_sha IS NOT NULL;
CREATE TABLE import_partition(name TEXT PRIMARY KEY, status TEXT NOT NULL, pid INTEGER, epoch TEXT, next_seq INTEGER,
  previous_frame_hash TEXT, source_size INTEGER, source_mtime TEXT, fingerprint TEXT, records INTEGER, digest TEXT, problem TEXT) STRICT;
CREATE TABLE unclassified(pid INTEGER NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL, payload BLOB NOT NULL,
  PRIMARY KEY(pid, seq)) WITHOUT ROWID, STRICT;
`;

/** Every table the DDL creates, in creation order (for tests and the importer seam). */
export const ENGINE_TABLES: readonly string[] = Object.freeze(
  [...ENGINE_SCHEMA_SQL.matchAll(/CREATE TABLE (\w+)\(/g)].map((match) => match[1]!),
);

/**
 * Migrations from an older `user_version` to the current one, keyed by the
 * version they start from. Empty for version 1; a stored version with no
 * entry here (older without a path, or newer than this engine) is refused.
 */
const SCHEMA_MIGRATIONS: ReadonlyMap<number, (db: DatabaseSync) => void> = new Map();

export interface SchemaIdentity {
  applicationId: number;
  userVersion: number;
  pageCount: number;
  /** Rows in `sqlite_master`: a header-only file (journal mode set, no schema yet) is still fresh. */
  objectCount: number;
}

export function readSchemaIdentity(db: DatabaseSync): SchemaIdentity {
  const scalar = (sql: string): number => {
    const row = db.prepare(sql).get() as Record<string, unknown>;
    const value = Object.values(row)[0];
    return typeof value === "bigint" ? Number(value) : Number(value);
  };
  return {
    applicationId: scalar("PRAGMA application_id"),
    userVersion: scalar("PRAGMA user_version"),
    pageCount: scalar("PRAGMA page_count"),
    objectCount: scalar("SELECT count(*) FROM sqlite_master"),
  };
}

/**
 * Refuse a foreign or unknown database BEFORE any write. A database with
 * pages must carry this engine's application id and a schema version this
 * engine can serve or migrate; an empty file is fresh and gets created.
 */
export function assertSchemaServable(identity: SchemaIdentity): "fresh" | "current" | "migrate" {
  const untouched = identity.applicationId === 0 && identity.userVersion === 0;
  if (identity.pageCount === 0 || (identity.objectCount === 0 && untouched)) return "fresh";
  if (identity.applicationId !== ENGINE_APPLICATION_ID) {
    throw new StoreSchemaUnsupportedError({
      applicationId: identity.applicationId,
      userVersion: identity.userVersion,
      detail: "the database file does not belong to the Claudexor engine store",
    });
  }
  if (identity.userVersion === ENGINE_SCHEMA_VERSION) return "current";
  if (identity.userVersion < ENGINE_SCHEMA_VERSION && SCHEMA_MIGRATIONS.has(identity.userVersion))
    return "migrate";
  throw new StoreSchemaUnsupportedError({
    applicationId: identity.applicationId,
    userVersion: identity.userVersion,
    detail:
      identity.userVersion > ENGINE_SCHEMA_VERSION
        ? "the database was written by a newer engine"
        : "no migration path exists from this schema version",
  });
}

/** Create a fresh schema or apply the migration path; never touches a refused file. */
export function ensureSchema(db: DatabaseSync, now: () => Date = () => new Date()): void {
  const disposition = assertSchemaServable(readSchemaIdentity(db));
  if (disposition === "current") return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (disposition === "fresh") {
      db.exec(ENGINE_SCHEMA_SQL);
      db.exec(`PRAGMA application_id=${ENGINE_APPLICATION_ID}`);
      const meta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
      meta.run("schema_version", String(ENGINE_SCHEMA_VERSION));
      meta.run("store_id", randomUUID());
      meta.run("created_at", now().toISOString());
    } else {
      let version = readSchemaIdentity(db).userVersion;
      while (version < ENGINE_SCHEMA_VERSION) {
        const step = SCHEMA_MIGRATIONS.get(version);
        if (!step) throw new Error(`schema migration from version ${version} is missing`);
        step(db);
        version += 1;
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(ENGINE_SCHEMA_VERSION),
      );
    }
    db.exec(`PRAGMA user_version=${ENGINE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the original failure is the report */
    }
    throw error;
  }
}
