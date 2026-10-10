import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(root, { recursive: true, force: true });
});
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
        "command_prunable",
        "command_result",
        "command_request_resource",
        "command_response_resource",
        "command_terminal",
        "event_group",
        "event_payload",
        "event_slot",
        "interaction_pending",
        "project_root_active",
        "project_current_pid",
        "turn_run",
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
