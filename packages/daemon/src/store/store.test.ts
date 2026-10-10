import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineRuntimeUnsupportedError, StoreError } from "./errors.js";
import { MAIN_CONNECTION_PRAGMAS, readPragmas } from "./pragmas.js";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/** The worker runs from the built package: Node loads it with its own loader. */
function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-store-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(daemonDir = join(root, "daemon")): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir,
    workerEntry: builtWorkerEntry("flusher-worker.js"),
  });
  stores.push(store);
  return store;
}

describeStore("EngineStore adapter", () => {
  it("applies and reads back the main-connection pragmas", async () => {
    const store = await openStore();
    expect(readPragmas(store.db, MAIN_CONNECTION_PRAGMAS)).toEqual({
      journal_mode: "wal",
      synchronous: 1,
      wal_autocheckpoint: 4000,
      checkpoint_fullfsync: 1,
      fullfsync: 0,
      journal_size_limit: 67108864,
      busy_timeout: 5000,
      temp_store: 2,
      page_size: 4096,
      auto_vacuum: 0,
    });
    expect(store.paths.database).toBe(join(root, "daemon", "engine.sqlite"));
    expect(store.paths.blobs).toBe(join(root, "daemon", "resource-store", "blobs"));
  });

  it("commits synchronous bodies, rolls back on throw, refuses async and nested bodies", async () => {
    const store = await openStore();
    const insert = store.prepare(
      "INSERT INTO partition(name, epoch, status, next_seq, created_at) VALUES(?, ?, 'ready', 1, ?)",
    );
    const count = () =>
      Number((store.prepare("SELECT count(*) AS n FROM partition").get() as { n: number }).n);
    const id = store.transaction(() => {
      expect(store.inTransaction).toBe(true);
      return Number(insert.run("global", "e1", "t").lastInsertRowid);
    });
    expect(id).toBe(1);
    expect(store.inTransaction).toBe(false);
    expect(count()).toBe(1);

    expect(() =>
      store.transaction(() => {
        insert.run("p1", "e1", "t");
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    expect(store.inTransaction).toBe(false);
    expect(count()).toBe(1);

    let async: unknown;
    try {
      store.transaction(async () => {
        insert.run("p2", "e1", "t");
      });
    } catch (error) {
      async = error;
    }
    expect(async).toBeInstanceOf(StoreError);
    expect(async).toMatchObject({ code: "store_transaction_async", status: 500 });
    expect(count()).toBe(1);

    expect(() =>
      store.transaction(() => {
        store.transaction(() => undefined);
      }),
    ).toThrow(/do not nest/);
    expect(store.inTransaction).toBe(false);
  });

  it("caches prepared statements per SQL text", async () => {
    const store = await openStore();
    const a = store.prepare("SELECT 1 AS one");
    expect(store.prepare("SELECT 1 AS one")).toBe(a);
    expect(store.prepare("SELECT 2 AS two")).not.toBe(a);
  });

  it("numbers generations, resolves flushed(), and reports facts", async () => {
    const store = await openStore();
    const gone = join(root, "gone");
    const g1 = store.registerExternal(root);
    const g2 = store.registerExternal(gone);
    expect(g2).toBe(g1 + 1);
    store.transaction(() => {
      store
        .prepare(
          "INSERT INTO partition(name, epoch, status, next_seq, created_at) VALUES('global','e','ready',1,'t')",
        )
        .run();
    });
    await store.flushed();
    const facts = store.facts();
    expect(facts.flusher.state).toBe("up");
    expect(facts.flusher.acknowledged_generation).toBeGreaterThanOrEqual(g2 + 1);
    expect(facts.flusher.pending_registrations).toBe(0);
    expect(facts.flusher.counters.barriers).toBeGreaterThanOrEqual(1);
    expect(facts.flusher.counters.dirSyncs).toBe(1);
    expect(facts.flusher.state).toBe("up");
    expect(facts.flusher.counters.deaths).toBe(0);
    expect(facts.last_barrier_at).toMatch(/T/);
    expect(facts.interval_ms).toBe(200);
    expect(facts.flush_lag_ms).toBe(0);
    expect(facts.busy_waits).toBe(0);
    expect(facts.obligations_open).toBe(0);
    expect(facts.integrity).toBe("pending");
    expect(facts.migration).toBeNull();
    expect(typeof facts.wal_bytes).toBe("number");
  });

  it("closes idempotently and refuses use afterwards", async () => {
    const store = await openStore();
    await store.close();
    await store.close();
    expect(() => store.prepare("SELECT 1")).toThrow(/closed/);
    expect(() => store.facts()).toMatchObject({});
    try {
      store.facts();
    } catch (error) {
      expect(error).toMatchObject({ code: "store_closed", status: 503 });
    }
  });

  it("refuses an unsupported runtime before touching the root", async () => {
    const daemonDir = join(root, "untouched");
    const failure = await EngineStore.open({
      daemonDir,
      runtime: { versions: { node: "22.22.0", sqlite: "3.51.2" } },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EngineRuntimeUnsupportedError);
    expect(existsSync(daemonDir)).toBe(false);
  });

  it("refuses a foreign database typed and leaves it untouched", async () => {
    const daemonDir = join(root, "foreign");
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(daemonDir, { recursive: true });
    const theirs = new DatabaseSync(join(daemonDir, "engine.sqlite"));
    theirs.exec(
      "CREATE TABLE theirs(x INTEGER) STRICT; PRAGMA application_id=99; PRAGMA user_version=1",
    );
    theirs.close();
    const failure = await EngineStore.open({
      daemonDir,
      workerEntry: builtWorkerEntry("flusher-worker.js"),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "store_schema_unsupported", applicationId: 99 });
    const check = new DatabaseSync(join(daemonDir, "engine.sqlite"));
    expect(
      (check.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    ).toEqual(["theirs"]);
    expect(
      (check.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    ).toBe("delete");
    check.close();
  });
});
