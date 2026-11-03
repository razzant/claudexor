import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { StoreSchemaUnsupportedError } from "./errors.js";
import { applyPragmas, MAIN_CONNECTION_PRAGMAS } from "./pragmas.js";
import {
  ENGINE_APPLICATION_ID,
  ENGINE_SCHEMA_VERSION,
  ENGINE_TABLES,
  assertSchemaServable,
  ensureSchema,
  readSchemaIdentity,
} from "./schema.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

let root: string;
const open: DatabaseSync[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-store-schema-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
async function connect(name = "engine.sqlite"): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(root, name));
  open.push(db);
  return db;
}
function masterRows(
  db: DatabaseSync,
): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
    .all() as never;
}

/** Frozen COMPLETE version-2 schema owner from 36f8230d551037c53d566018d381007a2ba95b0d.
 * This supplies both shipped DDL and the actual old reader; never derive it from current DDL.
 * Kept inline because this task's test-only lease does not include a fixture module. */
const V2_SCHEMA_SOURCE = `import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { StoreSchemaUnsupportedError } from "./errors.js";

/** \`PRAGMA application_id\` of every engine store ("CXEN"). */
export const ENGINE_APPLICATION_ID = 0x4358454e;
/** \`PRAGMA user_version\`: the one schema this engine creates and serves. */
export const ENGINE_SCHEMA_VERSION = 2;

/**
 * Version 2: the latest request each account served per requested model
 * (INV-135 last-served tie-break). One current row per (harness, row,
 * requested-model key, credential-binding digest); the model key is the JSON
 * encoding, so the default model (\`null\`), \`""\` and \`"null"\` stay distinct.
 * \`service_seq\` orders services by acceptance in the single writer, never by
 * the wall clock.
 */
const ACCOUNT_LAST_SERVICE_SQL = \`
CREATE TABLE account_last_service(harness_id TEXT NOT NULL, profile_id TEXT NOT NULL, requested_model_key TEXT NOT NULL,
  binding_digest TEXT NOT NULL, service_seq INTEGER NOT NULL, observed_at TEXT NOT NULL, run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, try_index INTEGER NOT NULL,
  PRIMARY KEY(harness_id, profile_id, requested_model_key, binding_digest)) WITHOUT ROWID, STRICT;
\`;

/**
 * SYNTHESIS_R5 §5 with R5_AMENDMENTS A1 (\`command.kind\`/\`live\` replace
 * \`retention_exempt\`; obligation \`state\`/\`materialized_g\`). STRICT everywhere; WITHOUT ROWID where the
 * primary key is the access path; partial indexes carry the retention and
 * listing predicates so a query over the current generation never visits
 * history. \`pid\` is the surrogate of one partition generation and the only
 * partition key a row carries.
 */
export const ENGINE_SCHEMA_SQL = \`
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
\${ACCOUNT_LAST_SERVICE_SQL}\`;

/** Every table the DDL creates, in creation order (for tests and the importer seam). */
export const ENGINE_TABLES: readonly string[] = Object.freeze(
  [...ENGINE_SCHEMA_SQL.matchAll(/CREATE TABLE (\\w+)\\(/g)].map((match) => match[1]!),
);

/**
 * Migrations from an older \`user_version\` to the current one, keyed by the
 * version they start from; a stored version with no entry here (older without
 * a path, or newer than this engine) is refused. Each step only adds: an
 * older engine refuses the upgraded file as newer, so the upgrade is one-way.
 */
const SCHEMA_MIGRATIONS: ReadonlyMap<number, (db: DatabaseSync) => void> = new Map([
  [1, (db: DatabaseSync) => db.exec(ACCOUNT_LAST_SERVICE_SQL)],
]);

export interface SchemaIdentity {
  applicationId: number;
  userVersion: number;
  pageCount: number;
  /** Rows in \`sqlite_master\`: a header-only file (journal mode set, no schema yet) is still fresh. */
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
      db.exec(\`PRAGMA application_id=\${ENGINE_APPLICATION_ID}\`);
      const meta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
      meta.run("schema_version", String(ENGINE_SCHEMA_VERSION));
      meta.run("store_id", randomUUID());
      meta.run("created_at", now().toISOString());
    } else {
      let version = readSchemaIdentity(db).userVersion;
      while (version < ENGINE_SCHEMA_VERSION) {
        const step = SCHEMA_MIGRATIONS.get(version);
        if (!step) throw new Error(\`schema migration from version \${version} is missing\`);
        step(db);
        version += 1;
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(ENGINE_SCHEMA_VERSION),
      );
    }
    db.exec(\`PRAGMA user_version=\${ENGINE_SCHEMA_VERSION}\`);
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
`;

function version2Owner(): { ENGINE_SCHEMA_SQL: string; ensureSchema(db: DatabaseSync): void } {
  const executable = stripTypeScriptTypes(V2_SCHEMA_SOURCE)
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  return new Function(
    "randomUUID",
    "StoreSchemaUnsupportedError",
    `${executable}\nreturn { ENGINE_SCHEMA_SQL, ensureSchema };`,
  )(randomUUID, StoreSchemaUnsupportedError);
}

const GROUP = "11111111-1111-4111-8111-111111111111";
/** Group indexes of either generation: version 3 expressions or the version 5 column. */
function groupIndexes(db: DatabaseSync) {
  return masterRows(db).filter(
    (row) =>
      row.type === "index" &&
      (row.sql?.includes("$.params.taskGroupId") || row.sql?.includes("task_group_id")),
  );
}
/** Membership is the canonical column, read through two ordered partial indexes. */
function assertGroupIndexes(db: DatabaseSync) {
  const indexes = groupIndexes(db);
  expect(indexes).toHaveLength(2);
  const keys: string[][] = [];
  for (const index of indexes) {
    const sql = index.sql!.replace(/\s+/g, "");
    expect(sql).not.toContain("$.params.taskGroupId");
    expect(sql).toContain("WHERElive=1ANDkind='product'ANDtask_group_idISNOTNULL");
    const info = db.prepare(`PRAGMA index_xinfo('${index.name}')`).all() as Array<{
      name: string | null;
      desc: number;
      key: number;
    }>;
    const columns = info.filter((row) => row.key === 1);
    expect(columns.slice(-2).map((row) => [row.name, row.desc])).toEqual([
      ["created_at", 1],
      ["id", 1],
    ]);
    keys.push(columns.map((row) => row.name ?? "expression"));
  }
  expect(keys).toContainEqual(["task_group_id", "created_at", "id"]);
  expect(keys).toContainEqual(["task_group_id", "state", "created_at", "id"]);
}
/** Each command's derived membership; `tableSnapshot` leaves this column out. */
function membership(db: DatabaseSync) {
  return db.prepare("SELECT id, task_group_id AS taskGroupId FROM command ORDER BY id").all();
}
function tableSnapshot(db: DatabaseSync) {
  return Object.fromEntries(
    masterRows(db)
      .filter((row) => row.type === "table")
      .map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM ${name}`)
          .all()
          .map(({ task_group_id: _derived, ...row }) =>
            JSON.stringify(row, (_key, value) =>
              value instanceof Uint8Array ? [...value] : value,
            ),
          )
          .sort(),
      ]),
  );
}
async function populatedOldStore(version: 1 | 2) {
  const db = await connect();
  applyPragmas(db, MAIN_CONNECTION_PRAGMAS);
  // Both fixtures begin at the frozen v2 DDL; v1 differs ONLY by this shipped v2 addition.
  db.exec(version2Owner().ENGINE_SCHEMA_SQL);
  if (version === 1) db.exec("DROP TABLE account_last_service");
  db.exec(`PRAGMA application_id=${ENGINE_APPLICATION_ID}; PRAGMA user_version=${version}`);
  for (const [key, value] of [
    ["schema_version", String(version)],
    ["store_id", "22222222-2222-4222-8222-222222222222"],
    ["created_at", "2026-10-01T00:00:00.000Z"],
  ])
    db.prepare("INSERT INTO meta VALUES(?,?)").run(key!, value!);
  db.exec(
    "INSERT INTO partition VALUES(1,'global','epoch','ready',2,NULL,'2026-10-01'); INSERT INTO thread VALUES('thread',1,'active','2026-10-01',0,x'7b7d'); INSERT INTO event(pid,seq,time,type,payload) VALUES(1,1,'2026-10-01','fixture',x'7b7d')",
  );
  const params = Buffer.from(JSON.stringify({ prompt: "old body" }));
  const result = Buffer.from(JSON.stringify({ answer: "old result" }));
  for (const [sha, bytes] of [
    ["params", params],
    ["result", result],
  ] as const)
    db.prepare("INSERT INTO blob VALUES(?,?,?)").run(sha, bytes.length, bytes);
  const insert = db.prepare(
    "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,result_sha,kind,live) VALUES(?,1,'run.create','queued','2026-10-01',?,'params','result',?,?)",
  );
  for (const [id, kind, live, params] of [
    ["untagged", "product", 1, {}],
    ["tagged", "product", 1, { taskGroupId: "11111111-1111-4111-8111-111111111111" }],
    ["archived", "product", 0, {}],
    ["model", "model", 1, {}],
  ] as const)
    insert.run(id, Buffer.from(JSON.stringify({ id, params })), kind, live);
  db.prepare(
    "INSERT INTO idempotency VALUES('command',1,'key','run.create','digest','untagged',NULL,'2026-10-01')",
  ).run();
  if (version === 2)
    db.exec(
      "INSERT INTO account_last_service VALUES('codex','work','null','binding',1,'2026-10-01','run','attempt',0)",
    );
  return db;
}

describeStore("task group storage upgrade", () => {
  // Exact shipped v3 additive statements from 2202b8f6 schema.ts, applied to
  // the independent frozen v2 owner above; not derived from the current DDL.
  async function populatedV3() {
    const db = await populatedOldStore(2);
    db.exec(`
CREATE INDEX command_task_group ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),created_at DESC,id DESC)
  WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT)) AND CASE WHEN json_valid(CAST(summary AS TEXT))
  THEN json_extract(CAST(summary AS TEXT),'$.params.taskGroupId') END IS NOT NULL;
CREATE INDEX command_task_group_state ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),state,created_at DESC,id DESC)
  WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT)) AND CASE WHEN json_valid(CAST(summary AS TEXT))
  THEN json_extract(CAST(summary AS TEXT),'$.params.taskGroupId') END IS NOT NULL;
UPDATE meta SET value='3' WHERE key='schema_version';
PRAGMA user_version=3;`);
    return db;
  }

  it("migrates the populated v3 owner to the current version atomically without changing existing rows", async () => {
    const db = await populatedV3();
    const before = tableSnapshot(db);
    ensureSchema(db);
    expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
    expect({ ...tableSnapshot(db), meta: [] }).toEqual({
      ...before,
      meta: [],
      deferred_message: [],
    });
    expect(membership(db)).toEqual([
      { id: "archived", taskGroupId: null },
      { id: "model", taskGroupId: null },
      { id: "tagged", taskGroupId: GROUP },
      { id: "untagged", taskGroupId: null },
    ]);
    const fresh = await connect("fresh.sqlite");
    ensureSchema(fresh);
    expect(masterRows(db)).toEqual(masterRows(fresh));
    for (const [query, index] of [
      [
        "SELECT id FROM deferred_message WHERE pid=1 AND predecessor_job_id='job' AND state IN ('waiting','held')",
        "deferred_message_slot",
      ],
      ["SELECT id FROM deferred_message WHERE body_sha='digest'", "deferred_message_body"],
      [
        "SELECT DISTINCT pid FROM deferred_message WHERE state IN ('waiting','held') AND state='waiting'",
        "deferred_message_slot",
      ],
    ]) {
      expect(
        db
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all()
          .map((row) => row["detail"])
          .join("\n"),
      ).toContain(index);
    }
    const add = db.prepare(
      "INSERT INTO deferred_message(id,pid,predecessor_job_id,revision,state,created_at) VALUES(?,1,'job',1,?,'now')",
    );
    add.run("draft-1", "waiting");
    expect(() => add.run("draft-2", "held")).toThrow(/UNIQUE/);
    db.prepare("UPDATE deferred_message SET state='cleared' WHERE id='draft-1'").run();
    expect(add.run("draft-2", "held").changes).toBe(1);
  });

  it("rolls back the v3-to-v5 chain on a late deferred-message DDL fault", async () => {
    const db = await populatedV3();
    const beforeRows = tableSnapshot(db),
      beforeSchema = masterRows(db),
      beforeIdentity = readSchemaIdentity(db);
    const original = db.exec.bind(db);
    const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE deferred_message")) {
        const prefix = sql.slice(0, sql.indexOf("CREATE INDEX deferred_message_body"));
        original(prefix);
        expect(
          db.prepare("SELECT 1 FROM sqlite_master WHERE name='deferred_message'").get(),
        ).toBeDefined();
        throw new Error("injected last draft index failure");
      }
      return original(sql);
    });
    expect(() => ensureSchema(db)).toThrow("injected last draft index failure");
    fault.mockRestore();
    expect(tableSnapshot(db)).toEqual(beforeRows);
    expect(masterRows(db)).toEqual(beforeSchema);
    expect(readSchemaIdentity(db)).toEqual(beforeIdentity);
    ensureSchema(db);
    expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
  });

  it("rolls back the membership column, its backfill and its indexes together on a late index fault", async () => {
    const db = await populatedV3();
    const beforeRows = tableSnapshot(db),
      beforeSchema = masterRows(db),
      beforeIdentity = readSchemaIdentity(db);
    const exec = db.exec.bind(db);
    const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (!sql.includes("ADD COLUMN task_group_id")) return exec(sql);
      for (const statement of sql.split(";").filter((part) => part.trim())) {
        if (statement.includes("CREATE INDEX command_task_group_state ON command(task_group_id")) {
          // The column, its backfill and the first new index exist inside the transaction.
          expect(db.prepare("SELECT task_group_id FROM command WHERE id='tagged'").get()).toEqual({
            task_group_id: GROUP,
          });
          expect(groupIndexes(db).map((row) => row.name)).toEqual(["command_task_group"]);
          throw new Error("injected last membership index failure");
        }
        exec(statement);
      }
    });
    expect(() => ensureSchema(db)).toThrow("injected last membership index failure");
    fault.mockRestore();
    expect(readSchemaIdentity(db)).toEqual(beforeIdentity);
    expect(masterRows(db)).toEqual(beforeSchema);
    expect(tableSnapshot(db)).toEqual(beforeRows);
    expect(
      (db.prepare("PRAGMA table_info(command)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).not.toContain("task_group_id");
    ensureSchema(db); // The untouched v3 file remains upgradeable.
    assertGroupIndexes(db);
    expect(membership(db)).toContainEqual({ id: "tagged", taskGroupId: GROUP });
  });

  it("backfills canonical lower-case membership for live and archived tagged rows without touching their summaries", async () => {
    const db = await populatedV3();
    const insert = db.prepare(
      "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind,live) VALUES(?,1,'run.create','succeeded','2026-10-02',?,'params',?,?)",
    );
    // Letters make the spellings differ; the fixture's GROUP is all digits.
    const lettered = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    for (const [id, kind, live, group] of [
      ["upper-live", "product", 1, lettered.toUpperCase()],
      ["upper-archived", "product", 0, lettered.toUpperCase()],
      ["mixed-live", "product", 1, "AaAaAaAa-BbBb-4CcC-8dDd-EeEeEeEeEeEe"],
      ["tagged-model", "model", 1, lettered],
    ] as const)
      insert.run(id, Buffer.from(JSON.stringify({ params: { taskGroupId: group } })), kind, live);
    insert.run("raw-bytes", Buffer.from([0xff, 0x00]), "product", 1);
    const before = tableSnapshot(db);
    ensureSchema(db);
    expect({ ...tableSnapshot(db), meta: [], deferred_message: [] }).toEqual({
      ...before,
      meta: [],
      deferred_message: [],
    });
    expect(membership(db)).toEqual([
      { id: "archived", taskGroupId: null },
      { id: "mixed-live", taskGroupId: lettered },
      { id: "model", taskGroupId: null },
      { id: "raw-bytes", taskGroupId: null },
      { id: "tagged", taskGroupId: GROUP },
      { id: "tagged-model", taskGroupId: null },
      { id: "untagged", taskGroupId: null },
      { id: "upper-archived", taskGroupId: lettered },
      { id: "upper-live", taskGroupId: lettered },
    ]);
    // Archived members return when their generation is restored; live ones are listed now.
    expect(
      db
        .prepare(
          "SELECT id FROM command WHERE live=1 AND kind='product' AND task_group_id=? ORDER BY created_at DESC,id DESC",
        )
        .all(lettered),
    ).toEqual([{ id: "upper-live" }, { id: "mixed-live" }]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("migrates a version-3 store whose group indexes have broader predicates", async () => {
    const db = await populatedOldStore(2);
    // The predicates of PR498 at 5b9d6d75: same version, broader membership.
    db.exec(`
CREATE INDEX command_task_group ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),created_at DESC,id DESC)
  WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT));
CREATE INDEX command_task_group_state ON command(json_extract(CAST(summary AS TEXT),'$.params.taskGroupId'),state,created_at DESC,id DESC)
  WHERE live=1 AND kind='product' AND json_valid(CAST(summary AS TEXT));
UPDATE meta SET value='3' WHERE key='schema_version';
PRAGMA user_version=3;`);
    ensureSchema(db);
    assertGroupIndexes(db);
    expect(membership(db)).toEqual([
      { id: "archived", taskGroupId: null },
      { id: "model", taskGroupId: null },
      { id: "tagged", taskGroupId: GROUP },
      { id: "untagged", taskGroupId: null },
    ]);
    const fresh = await connect("fresh.sqlite");
    ensureSchema(fresh);
    expect(masterRows(db)).toEqual(masterRows(fresh));
  });

  it("fresh DDL indexes membership by the canonical column at the current version", async () => {
    const db = await connect();
    ensureSchema(db);
    expect(ENGINE_SCHEMA_VERSION).toBe(6);
    expect(readSchemaIdentity(db).userVersion).toBe(6);
    assertGroupIndexes(db);
  });

  it.each(["fresh", "v2"] as const)(
    "%s group indexes preserve legal raw product summaries alongside tagged JSON",
    async (source) => {
      const db = source === "v2" ? await populatedOldStore(2) : await connect();
      if (source === "fresh") {
        ensureSchema(db);
        db.exec("INSERT INTO partition VALUES(1,'global','epoch','ready',1,NULL,'2026-10-22')");
      }
      const insert = db.prepare(
        "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind,live) VALUES(?,1,'run.create','running','2026-10-22',?,'raw-params','product',1)",
      );
      for (const [id, bytes] of [
        ["raw-null", Buffer.from([0])],
        ["raw-benchmark", Buffer.alloc(400, 0x62)],
        ["raw-truncated-json", Buffer.from('{"params":')],
        ["json-null", Buffer.from("null")],
        ["no-params", Buffer.from("{}")],
        ["null-params", Buffer.from('{"params":null}')],
        ["null-group", Buffer.from('{"params":{"taskGroupId":null}}')],
      ] as const)
        expect(insert.run(id, bytes).changes).toBe(1);
      insert.run("compat-tagged", Buffer.from(JSON.stringify({ params: { taskGroupId: GROUP } })));
      // A fresh store's command writer fills the column; the v2 file gets it by backfill.
      if (source === "fresh")
        db.prepare("UPDATE command SET task_group_id=? WHERE id='compat-tagged'").run(GROUP);
      const before = tableSnapshot(db);
      // The v2 fixture contains the raw bytes BEFORE the migration reads summaries.
      // The fresh fixture proves writes AFTER both indexes already exist.
      ensureSchema(db);
      expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
      expect({ ...tableSnapshot(db), meta: [] }).toEqual({
        ...before,
        deferred_message: [],
        meta: [],
      });
      assertGroupIndexes(db);
      // Count actual B-tree entries, not SELECT rows filtered by the query.
      // Untagged, JSON null, and invalid JSON must occupy neither group index.
      const expectedMembers = source === "v2" ? 2 : 1;
      expect(
        db
          .prepare(
            "SELECT name,sum(ncell) AS entries FROM dbstat WHERE name IN ('command_task_group','command_task_group_state') GROUP BY name ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "command_task_group", entries: expectedMembers },
        { name: "command_task_group_state", entries: expectedMembers },
      ]);
      expect(
        db
          .prepare("SELECT count(*) AS n FROM command WHERE json_valid(CAST(summary AS TEXT))=0")
          .get(),
      ).toEqual({ n: 3 });
      expect(
        db.prepare("SELECT count(*) AS n FROM command WHERE task_group_id IS NOT NULL").get(),
      ).toEqual({ n: expectedMembers });
      expect(
        db
          .prepare(
            "SELECT id FROM command INDEXED BY command_task_group_state WHERE live=1 AND kind='product' AND task_group_id=? AND state='running' ORDER BY created_at DESC,id DESC",
          )
          .all(GROUP),
      ).toEqual([{ id: "compat-tagged" }]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    },
  );

  it.each([1, 2] as const)(
    "upgrades populated v%s to the current version without rewriting params, results or membership",
    async (version) => {
      const db = await populatedOldStore(version);
      const before = tableSnapshot(db);
      ensureSchema(db);
      expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
      expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
        value: String(ENGINE_SCHEMA_VERSION),
      });
      const after = tableSnapshot(db);
      expect({ ...after, meta: [], account_last_service: [] }).toEqual({
        ...before,
        deferred_message: [],
        meta: [],
        account_last_service: [],
      });
      expect(
        db.prepare("SELECT key,value FROM meta WHERE key!='schema_version' ORDER BY key").all(),
      ).toEqual([
        { key: "created_at", value: "2026-10-01T00:00:00.000Z" },
        { key: "store_id", value: "22222222-2222-4222-8222-222222222222" },
      ]);
      if (version === 2) expect(after.account_last_service).toEqual(before.account_last_service);
      assertGroupIndexes(db);
      expect(membership(db)).toContainEqual({ id: "tagged", taskGroupId: GROUP });
      const fresh = await connect("fresh.sqlite");
      ensureSchema(fresh);
      expect(masterRows(db)).toEqual(masterRows(fresh));
    },
  );

  it.each([1, 2] as const)(
    "rolls back the entire v%s migration when the second group index fails",
    async (version) => {
      const db = await populatedOldStore(version);
      const beforeRows = tableSnapshot(db),
        beforeSchema = masterRows(db),
        beforeIdentity = readSchemaIdentity(db);
      const observer = await connect();
      const dataVersion = () => observer.prepare("PRAGMA data_version").get();
      const beforeVersion = dataVersion();
      const exec = db.exec.bind(db);
      let groupCreates = 0;
      const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
        // Execute statements separately so the first index REALLY exists in the transaction before failure.
        for (const statement of sql.split(";").filter((part) => part.trim())) {
          if (/CREATE\s+INDEX/i.test(statement) && statement.includes("$.params.taskGroupId")) {
            groupCreates += 1;
            if (groupCreates === 2) {
              expect(groupIndexes(db)).toHaveLength(1);
              throw new Error("injected second group index failure");
            }
          }
          exec(statement);
        }
      });
      expect(() => ensureSchema(db)).toThrow("injected second group index failure");
      fault.mockRestore();
      expect(groupCreates).toBe(2);
      expect(readSchemaIdentity(db)).toEqual(beforeIdentity);
      expect(masterRows(db)).toEqual(beforeSchema);
      expect(tableSnapshot(db)).toEqual(beforeRows);
      expect(dataVersion()).toEqual(beforeVersion);
      ensureSchema(db); // The same untouched old file remains upgradeable.
      assertGroupIndexes(db);
    },
  );

  it("current-version reopen and a real frozen v2 reader leave a populated current file untouched", async () => {
    const writer = await populatedOldStore(2);
    ensureSchema(writer);
    expect(readSchemaIdentity(writer).userVersion).toBe(ENGINE_SCHEMA_VERSION);
    const observer = await connect();
    const beforeRows = tableSnapshot(writer),
      beforeSchema = masterRows(writer);
    const beforeVersion = observer.prepare("PRAGMA data_version").get();
    writer.close();
    const reopened = await connect();
    const exec = vi.spyOn(reopened, "exec");
    ensureSchema(reopened);
    expect(exec).not.toHaveBeenCalled();
    expect(() => version2Owner().ensureSchema(reopened)).toThrow(
      expect.objectContaining({
        code: "store_schema_unsupported",
        status: 503,
        retryable: false,
        userVersion: ENGINE_SCHEMA_VERSION,
      }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(tableSnapshot(reopened)).toEqual(beforeRows);
    expect(masterRows(reopened)).toEqual(beforeSchema);
    expect(observer.prepare("PRAGMA data_version").get()).toEqual(beforeVersion);
  });
});

describeStore("engine schema (SYNTHESIS_R5 §5)", () => {
  it("creates the R5 DDL on a fresh file: STRICT tables, WITHOUT ROWID keys, partial indexes, identity", async () => {
    const db = await connect();
    applyPragmas(db, MAIN_CONNECTION_PRAGMAS);
    ensureSchema(db);
    const rows = masterRows(db);
    const tables = rows.filter((row) => row.type === "table").map((row) => row.name);
    expect(tables.sort()).toEqual([...ENGINE_TABLES].sort());
    for (const row of rows.filter((row) => row.type === "table")) {
      expect(row.sql, row.name).toMatch(/\bSTRICT\b/);
    }
    const withoutRowid = rows
      .filter((row) => row.type === "table" && /WITHOUT ROWID/.test(row.sql ?? ""))
      .map((row) => row.name)
      .sort();
    expect(withoutRowid).toEqual(
      [
        "account_last_service",
        "effect_obligation",
        "event",
        "idempotency",
        "lane_checkpoint",
        "session",
        "unclassified",
      ].sort(),
    );
    const partial = rows.filter((row) => row.type === "index" && /\bWHERE\b/.test(row.sql ?? ""));
    expect(partial.map((row) => row.name).sort()).toEqual(
      [
        "command_active",
        "command_expiry",
        "command_list",
        "command_list_state",
        "command_maintenance_harness",
        "command_prunable",
        "command_result",
        "command_request_resource",
        "command_response_resource",
        "command_task_group",
        "command_task_group_state",
        "command_terminal",
        "deferred_message_body",
        "deferred_message_slot",
        "deferred_message_successor",
        "event_group",
        "event_command_age",
        "event_payload",
        "event_slot",
        "interaction_pending",
        "interaction_partition_pending",
        "project_root_active",
        "project_current_pid",
        "turn_run",
        "turn_plan_answer",
        "upload_finalize",
      ].sort(),
    );
    expect(readSchemaIdentity(db)).toMatchObject({
      applicationId: ENGINE_APPLICATION_ID,
      userVersion: ENGINE_SCHEMA_VERSION,
    });
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>
      ).map((row) => [row.key, row.value]),
    );
    expect(meta["schema_version"]).toBe(String(ENGINE_SCHEMA_VERSION));
    expect(meta["store_id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats a header-only WAL file (journal mode set, no objects) as fresh", async () => {
    const db = await connect();
    applyPragmas(db, MAIN_CONNECTION_PRAGMAS);
    const identity = readSchemaIdentity(db);
    expect(identity.pageCount).toBeGreaterThan(0);
    expect(assertSchemaServable(identity)).toBe("fresh");
    ensureSchema(db);
    expect(assertSchemaServable(readSchemaIdentity(db))).toBe("current");
  });

  it("keeps stable session entities when profile migration makes their lanes equal", async () => {
    const db = await connect();
    ensureSchema(db);
    const insert = db.prepare(
      "INSERT INTO session(id,thread_id,harness_id,profile_id,pid,insertion_ordinal,body) VALUES(?,'thread','codex',?,1,?,x'7b7d')",
    );
    insert.run("session-default", "", 1);
    insert.run("session-named", "named", 2);
    db.prepare("UPDATE session SET profile_id='named' WHERE id='session-default'").run();
    expect(
      db
        .prepare(
          "SELECT id FROM session WHERE thread_id='thread' AND harness_id='codex' AND profile_id='named' ORDER BY insertion_ordinal",
        )
        .all(),
    ).toEqual([{ id: "session-default" }, { id: "session-named" }]);
  });

  it("addresses partition transitions and continuity scans through their pid indexes", async () => {
    const db = await connect();
    ensureSchema(db);
    for (const [query, index] of [
      ["UPDATE command SET live=0 WHERE pid=1", "command_partition"],
      ["SELECT body FROM session WHERE pid=1 ORDER BY insertion_ordinal", "session_partition"],
      [
        "SELECT body FROM lane_checkpoint WHERE pid=1 ORDER BY insertion_ordinal",
        "lane_checkpoint_partition",
      ],
      [
        "SELECT DISTINCT run_id FROM interaction WHERE pid=1 AND state='pending'",
        "interaction_partition_pending",
      ],
    ]) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join("\n");
      expect(plan).toContain(index);
      expect(plan).not.toMatch(/SCAN (command|session|lane_checkpoint|interaction)|TEMP B-TREE/);
    }
  });

  it("reopening a current schema writes nothing", async () => {
    const writer = await connect();
    applyPragmas(writer, MAIN_CONNECTION_PRAGMAS);
    ensureSchema(writer);
    const observer = await connect();
    const version = () =>
      Number(
        (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
      );
    const before = version();
    ensureSchema(writer);
    expect(version()).toBe(before);
  });

  it("refuses a foreign database before any write", async () => {
    const foreign = await connect();
    foreign.exec(
      "CREATE TABLE theirs(x INTEGER) STRICT; PRAGMA application_id=7; PRAGMA user_version=3",
    );
    const observer = await connect();
    const version = () =>
      Number(
        (observer.prepare("PRAGMA data_version").get() as { data_version: number }).data_version,
      );
    const before = version();
    expect(() => ensureSchema(foreign)).toThrow(StoreSchemaUnsupportedError);
    try {
      ensureSchema(foreign);
    } catch (error) {
      expect(error).toMatchObject({
        code: "store_schema_unsupported",
        status: 503,
        retryable: false,
        applicationId: 7,
        userVersion: 3,
      });
    }
    expect(version()).toBe(before);
    expect(masterRows(foreign).map((row) => row.name)).toEqual(["theirs"]);
  });

  it("refuses an unknown schema version in both directions and keeps the file untouched", async () => {
    const db = await connect();
    applyPragmas(db, MAIN_CONNECTION_PRAGMAS);
    ensureSchema(db);
    db.exec(`PRAGMA user_version=${ENGINE_SCHEMA_VERSION + 1}`);
    expect(() => ensureSchema(db)).toThrow(/newer engine/);
    db.exec("PRAGMA user_version=0");
    expect(() => ensureSchema(db)).toThrow(/no migration path/);
    expect(
      assertSchemaServable({ ...readSchemaIdentity(db), userVersion: ENGINE_SCHEMA_VERSION }),
    ).toBe("current");
  });
});
