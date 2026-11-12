import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreSchemaUnsupportedError } from "./errors.js";
import { ENGINE_SCHEMA_VERSION, ensureSchema, readSchemaIdentity } from "./schema.js";

const sqlite = await import("node:sqlite").catch(() => null);
const roots: string[] = [];
const connections: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  // This test's folders, taken before its closes: a later test never removes them.
  const ownedRoots = roots.splice(0);
  for (const db of connections.splice(0)) db.close();
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function connect() {
  const root = mkdtempSync(join(tmpdir(), "cx-schema-history-"));
  roots.push(root);
  const db = new sqlite!.DatabaseSync(join(root, "engine.sqlite"));
  connections.push(db);
  return db;
}

/** Exact owners from 711cee0e5 (v3), bc979941f (v4) and 4e870bea0 (v5), never
 * derived from current DDL. */
function frozenOwner(version: 3 | 4 | 5): { ensureSchema(db: DatabaseSync): void } {
  const source = readFileSync(
    new URL(`./test-support/fixtures/schema-v${version}.ts.txt`, import.meta.url),
    "utf8",
  );
  const executable = stripTypeScriptTypes(source)
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  return new Function(
    "randomUUID",
    "StoreSchemaUnsupportedError",
    `${executable}\nreturn { ensureSchema };`,
  )(randomUUID, StoreSchemaUnsupportedError);
}
function schema(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
}
function rows(db: DatabaseSync) {
  return Object.fromEntries(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]),
  );
}
function seed(db: DatabaseSync) {
  db.exec("INSERT INTO partition VALUES(1,'global','epoch','ready',2,NULL,'2026-10-26')");
  db.exec("INSERT INTO thread VALUES('thread',1,'active','2026-10-26',0,x'7b7d')");
  db.exec("INSERT INTO blob VALUES('prompt',2,x'6869')");
  db.exec(
    "INSERT INTO event(pid,seq,time,type,payload) VALUES(1,1,'2026-10-26','fixture',x'7b7d')",
  );
  const insert = db.prepare(
    `INSERT INTO turn(id,pid,thread_id,ordinal,run_id,created_at,prompt_sha,body)
    VALUES(?,1,'thread',?,?,'2026-10-26','prompt',?)`,
  );
  const bodies = [
    { answers_plan_run_id: "plan", run_id: "run" },
    { answers_plan_run_id: "plan", run_id: null },
    { answers_plan_run_id: "plan", enqueue_error: { retryable: true } },
    { answers_plan_run_id: "plan", enqueue_error: { retryable: false } },
    { answers_plan_run_id: null },
    {},
  ];
  bodies.forEach((body, i) =>
    insert.run(`turn-${i}`, i, i === 0 ? "run" : null, Buffer.from(JSON.stringify(body))),
  );
  for (const [i, body] of [
    Buffer.from([0]),
    Buffer.from('{"answers_plan_run_id":'),
    Buffer.from("null"),
  ].entries())
    insert.run(`raw-${i}`, bodies.length + i, null, body);
}
function assertIndex(db: DatabaseSync) {
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name='turn_plan_answer'").get() as {
    sql: string;
  };
  expect(index.sql).toContain("CASE WHEN json_valid(CAST(body AS TEXT))");
  expect(index.sql).not.toContain("retryable");
  expect(index.sql).not.toContain("run_id IS NOT NULL");
  const columns = db.prepare("PRAGMA index_xinfo('turn_plan_answer')").all() as {
    cid: number;
    name: string | null;
    key: number;
  }[];
  expect(columns.filter((c) => c.key === 1).map((c) => [c.name, c.cid === -2])).toEqual([
    ["thread_id", false],
    [null, true],
    ["ordinal", false],
  ]);
  // Refusals occupy the index too. Null/missing/malformed relations never do.
  expect(
    db.prepare("SELECT sum(ncell) AS n FROM dbstat WHERE name='turn_plan_answer'").get(),
  ).toEqual({ n: 4 });
}

function seedDeferredMessages(db: DatabaseSync) {
  db.exec("INSERT INTO blob VALUES('draft-body',5,x'6472616674')");
  const insert = db.prepare(`INSERT INTO deferred_message
    (id,pid,predecessor_job_id,revision,state,body_sha,hold,successor_job_id,dispatched_revision,created_at)
    VALUES(?,1,?,3,?,'draft-body',?,?,?,'2026-10-27')`);
  for (const state of ["waiting", "held", "dispatched", "cleared"] as const) {
    insert.run(
      `draft-${state}`,
      `predecessor-${state}`,
      state,
      state === "held" ? Buffer.from('{"code":"settlement_unknown"}') : null,
      state === "dispatched" ? "successor" : null,
      state === "dispatched" ? 3 : null,
    );
  }
  expect(db.prepare("SELECT count(*) AS n FROM deferred_message").get()).toEqual({ n: 4 });
}

describe.skipIf(!sqlite)("thread-history schema v5", () => {
  it("creates a fresh current store with deferred messages and a minimal answer-present index", () => {
    const db = connect();
    ensureSchema(db);
    expect(ENGINE_SCHEMA_VERSION).toBe(8);
    expect(readSchemaIdentity(db).userVersion).toBe(8);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: "8",
    });
    seed(db);
    seedDeferredMessages(db);
    assertIndex(db);
  });

  it.each([3, 4, 5] as const)(
    "migrates frozen populated v%s to the current version without changing domain rows or other indexes",
    (version) => {
      const db = connect();
      frozenOwner(version).ensureSchema(db);
      expect(readSchemaIdentity(db).userVersion).toBe(version);
      seed(db); // Invalid JSON and refusals predate index creation.
      if (version >= 4) seedDeferredMessages(db);
      const before = rows(db),
        previousSchema = schema(db);
      ensureSchema(db);
      expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
      // Version 7 adds two nullable next-message columns, the nullable dispatch fact of
      // turns and an empty holder table.
      const drafts = ((before.deferred_message ?? []) as Record<string, unknown>[]).map((row) => ({
        ...row,
        held_revision: null,
        resumed: null,
      }));
      const turns = ((before.turn ?? []) as Record<string, unknown>[]).map((row) => ({
        ...row,
        dispatched_at: null,
      }));
      expect({ ...rows(db), meta: [] }).toEqual({
        ...before,
        deferred_message: drafts,
        turn: turns,
        resource_use: [],
        meta: [],
      });
      expect(rows(db).meta).toEqual(
        (before.meta as { key: string; value: string }[]).map((row) =>
          row.key === "schema_version" ? { ...row, value: String(ENGINE_SCHEMA_VERSION) } : row,
        ),
      );
      // Version 6 adds the membership column and rebuilds both group indexes on it;
      // version 7 adds the resource holders and alters the next-message and turn tables;
      // version 8 adds the question-delivery column and its covering pending index.
      const replaced = new Set([
        "command",
        "command_task_group",
        "command_task_group_state",
        "deferred_message",
        "interaction",
        "turn",
      ]);
      const added = new Set([
        ...replaced,
        "resource_use",
        "resource_use_owner",
        "resource_use_sha",
        "interaction_pending_delivery",
        ...(version < 5 ? ["turn_plan_answer"] : []),
        ...(version === 3
          ? [
              "deferred_message",
              "sqlite_autoindex_deferred_message_1",
              "deferred_message_slot",
              "deferred_message_predecessor",
              "deferred_message_successor",
              "deferred_message_body",
            ]
          : []),
      ]);
      expect(schema(db).filter((row) => !added.has(row.name as string))).toEqual(
        previousSchema.filter((row) => !replaced.has(row.name as string)),
      );
      expect(
        (db.prepare("PRAGMA table_info(command)").all() as { name: string }[]).at(-1)?.name,
      ).toBe("task_group_id");
      assertIndex(db);
      const fresh = connect();
      ensureSchema(fresh);
      expect(schema(db)).toEqual(schema(fresh));
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      const exec = vi.spyOn(db, "exec");
      ensureSchema(db);
      expect(exec).not.toHaveBeenCalled();
      for (const oldVersion of [3, 4, 5] as const)
        expect(() => frozenOwner(oldVersion).ensureSchema(db)).toThrow(
          expect.objectContaining({
            code: "store_schema_unsupported",
            userVersion: ENGINE_SCHEMA_VERSION,
          }),
        );
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it.each([3, 4] as const)(
    "rolls back failed v%s-to-v5 index creation and permits a subsequent upgrade",
    (version) => {
      const db = connect();
      frozenOwner(version).ensureSchema(db);
      seed(db);
      if (version === 4) seedDeferredMessages(db);
      const before = rows(db),
        previousSchema = schema(db);
      const exec = db.exec.bind(db);
      const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (sql.includes("CREATE INDEX turn_plan_answer")) throw new Error("index failure");
      });
      expect(() => ensureSchema(db)).toThrow("index failure");
      fault.mockRestore();
      expect(readSchemaIdentity(db).userVersion).toBe(version);
      expect(rows(db)).toEqual(before);
      expect(schema(db)).toEqual(previousSchema);
      ensureSchema(db);
      expect(readSchemaIdentity(db).userVersion).toBe(ENGINE_SCHEMA_VERSION);
      assertIndex(db);
    },
  );

  it("refuses a newer store before writes and still opens a current store", () => {
    const db = connect();
    ensureSchema(db);
    seed(db);
    db.exec(`PRAGMA user_version=${ENGINE_SCHEMA_VERSION + 1}`);
    const before = rows(db),
      previousSchema = schema(db);
    const exec = vi.spyOn(db, "exec");
    expect(() => ensureSchema(db)).toThrow(
      expect.objectContaining({
        code: "store_schema_unsupported",
        userVersion: ENGINE_SCHEMA_VERSION + 1,
        status: 503,
      }),
    );
    expect(exec).not.toHaveBeenCalled();
    expect(rows(db)).toEqual(before);
    expect(schema(db)).toEqual(previousSchema);
    exec.mockRestore();
    db.exec(`PRAGMA user_version=${ENGINE_SCHEMA_VERSION}`); // Fixture-only header restoration.
    ensureSchema(db);
    assertIndex(db);
  });
});
