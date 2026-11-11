import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBusyError, StoreCorruptError } from "./errors.js";
import { EngineStore, type EngineStoreOptions } from "./store.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

function builtWorkerEntry(): string {
  const entry = resolve(import.meta.dirname, "../../dist/store/flusher-worker.js");
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-commit-facts-"));
});
afterEachClosed(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close();
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
});

async function openStore(options: Partial<EngineStoreOptions> = {}): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry(),
    ...options,
  });
  stores.push(store);
  return store;
}

/** Records every native `exec` and charges each statement a known clock cost. */
function chargeStatements(store: EngineStore, clock: { t: number }, costs: Record<string, number>) {
  const db = store.db;
  const exec = db.exec.bind(db);
  const statements: string[] = [];
  vi.spyOn(db, "exec").mockImplementation((sql: string) => {
    statements.push(sql);
    clock.t += costs[sql] ?? 0;
    return exec(sql);
  });
  return statements;
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const none = { attempts: 0, failures: 0, last_ms: null, max_ms: null, p50_ms: null, p99_ms: null };

describeStore("COMMIT facts of EngineStore.transaction", () => {
  it("start as a known zero and time only the native COMMIT of a successful transaction", async () => {
    const clock = { t: 1_000 };
    const store = await openStore({ monotonicNow: () => clock.t });
    const fresh = store.facts().commit;
    const costs: Record<string, number> = { "BEGIN IMMEDIATE": 100, COMMIT: 7.25, ROLLBACK: 1_000 };
    const statements = chargeStatements(store, clock, costs);
    const insert = store.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
    const value = { returned: true };
    const result = store.transaction(() => {
      clock.t += 50;
      insert.run("first", "1");
      return value;
    });
    expect(result).toBe(value);
    expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    expect(fresh).toEqual(none);
    expect(store.facts().commit).toMatchObject({
      attempts: 1,
      failures: 0,
      last_ms: 7.25,
      max_ms: 7.25,
    });

    // A COMMIT below the clock's resolution is a measured zero, never unknown.
    costs.COMMIT = 0;
    store.transaction(() => void insert.run("second", "2"));
    expect(store.facts().commit).toMatchObject({
      attempts: 2,
      failures: 0,
      last_ms: 0,
      max_ms: 7.25,
    });
    costs.COMMIT = 12.0004;
    store.transaction(() => void insert.run("third", "3"));
    expect(store.facts().commit).toMatchObject({
      attempts: 3,
      failures: 0,
      last_ms: 12,
      max_ms: 12,
    });
    expect(store.facts().commit.p50_ms!).toBeCloseTo(7.25, 1);
    expect(store.facts().commit.p99_ms).toBe(12);
    expect(statements.filter((sql) => sql !== "BEGIN IMMEDIATE" && sql !== "COMMIT")).toEqual([]);
    expect(
      store.prepare("SELECT count(*) AS n FROM meta WHERE key IN ('first','second','third')").get(),
    ).toEqual({ n: 3 });
  });

  it("does not count bodies that fail, return a thenable, nest, or a BEGIN SQLite refuses", async () => {
    const clock = { t: 0 };
    const store = await openStore({ monotonicNow: () => clock.t });
    const statements = chargeStatements(store, clock, { COMMIT: 3, ROLLBACK: 1_000 });
    const insert = store.prepare("INSERT INTO meta(key, value) VALUES(?, 'uncommitted')");
    const bodyError = new Error("body failed");
    expect(
      thrownBy(() =>
        store.transaction(() => {
          insert.run("body");
          throw bodyError;
        }),
      ),
    ).toBe(bodyError);
    expect(
      thrownBy(() =>
        store.transaction(async () => {
          insert.run("async");
        }),
      ),
    ).toMatchObject({ code: "store_transaction_async" });
    expect(
      thrownBy(() => store.transaction(() => store.transaction(() => insert.run("nested")))),
    ).toMatchObject({ code: "store_transaction_nested" });
    expect(statements).toEqual([
      ...["BEGIN IMMEDIATE", "ROLLBACK"],
      ...["BEGIN IMMEDIATE", "ROLLBACK"],
      ...["BEGIN IMMEDIATE", "ROLLBACK"],
    ]);

    // A real writer lock held by another connection: BEGIN IMMEDIATE fails busy.
    const { DatabaseSync } = await import("node:sqlite");
    const holder = new DatabaseSync(store.paths.database);
    let busy: unknown;
    try {
      holder.exec("BEGIN IMMEDIATE");
      store.db.exec("PRAGMA busy_timeout=0");
      statements.length = 0;
      busy = thrownBy(() => store.transaction(() => insert.run("busy")));
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
      store.db.exec("PRAGMA busy_timeout=5000");
    }
    expect(busy).toBeInstanceOf(StoreBusyError);
    expect(statements[0]).toBe("BEGIN IMMEDIATE");
    expect(statements).not.toContain("COMMIT");
    expect(store.prepare("SELECT count(*) AS n FROM meta WHERE value='uncommitted'").get()).toEqual(
      { n: 0 },
    );
    expect(store.facts()).toMatchObject({ busy_waits: 1, commit: none });
    store.transaction(
      () => void store.prepare("INSERT INTO meta(key, value) VALUES('after', 'committed')").run(),
    );
    expect(store.facts().commit).toMatchObject({ attempts: 1, failures: 0, last_ms: 3, max_ms: 3 });
  });

  it("counts a real failed COMMIT, rethrows the original error and still rolls back", async () => {
    const clock = { t: 0 };
    const store = await openStore({ monotonicNow: () => clock.t });
    store.db.exec("PRAGMA foreign_keys = ON");
    store.transaction(() => {
      store.exec("CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY)");
      store.exec(
        "CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id) DEFERRABLE INITIALLY DEFERRED)",
      );
    });
    const statements = chargeStatements(store, clock, {
      "BEGIN IMMEDIATE": 100,
      COMMIT: 4.5,
      ROLLBACK: 1_000,
    });
    const failure = vi.spyOn(store, "failure");
    const thrown = thrownBy(() =>
      store.transaction(() => {
        clock.t += 50;
        store.prepare("INSERT INTO fixture_child(id) VALUES(9)").run();
      }),
    );
    // SQLite refuses the deferred constraint at COMMIT itself (SQLITE_CONSTRAINT_FOREIGNKEY).
    expect(thrown).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 787 });
    expect((thrown as Error).message).toMatch(/FOREIGN KEY constraint failed/);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(thrown, "committing a transaction");
    expect(failure.mock.results[0]).toEqual({ type: "return", value: thrown });
    expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    expect(store.inTransaction).toBe(false);
    expect(store.prepare("SELECT count(*) AS n FROM fixture_child").get()).toEqual({ n: 0 });
    // The schema transaction above committed in zero clock time; the failure is the latest call.
    expect(store.facts().commit).toMatchObject({
      attempts: 2,
      failures: 1,
      last_ms: 4.5,
      max_ms: 4.5,
    });
  });

  it("times a mapped COMMIT failure without its mapping, notification or ROLLBACK", async () => {
    const clock = { t: 0 };
    const onCorrupt = vi.fn(() => {
      clock.t += 500;
    });
    const store = await openStore({ monotonicNow: () => clock.t, onCorrupt });
    const native = Object.assign(new Error("database disk image is malformed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 11,
    });
    const db = store.db;
    const exec = db.exec.bind(db);
    const statements: string[] = [];
    vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      statements.push(sql);
      if (sql === "ROLLBACK") clock.t += 1_000;
      if (sql !== "COMMIT") return exec(sql);
      clock.t += 2.5;
      throw native;
    });
    const thrown = thrownBy(() =>
      store.transaction(
        () => void store.prepare("INSERT INTO meta(key, value) VALUES('lost', 'x')").run(),
      ),
    );
    expect(thrown).toBeInstanceOf(StoreCorruptError);
    expect((thrown as Error).cause).toBe(native);
    expect(onCorrupt).toHaveBeenCalledTimes(1);
    expect(onCorrupt).toHaveBeenCalledWith(thrown);
    expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"]);
    expect(store.inTransaction).toBe(false);
    expect(store.prepare("SELECT value FROM meta WHERE key='lost'").get()).toBeUndefined();
    expect(store.facts()).toMatchObject({
      integrity: "failed",
      commit: { attempts: 1, failures: 1, last_ms: 2.5, max_ms: 2.5 },
    });
  });

  it("returns snapshots and starts again from zero with every store lifetime", async () => {
    const store = await openStore();
    const insert = store.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
    store.transaction(() => void insert.run("before", "1"));
    const snapshot = store.facts().commit;
    expect(snapshot).toMatchObject({ attempts: 1, failures: 0 });
    expect(snapshot.last_ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.max_ms).toBe(snapshot.last_ms);
    const copy = structuredClone(snapshot);
    store.transaction(() => void insert.run("after", "2"));
    expect(snapshot).toEqual(copy);
    snapshot.attempts = 999;
    const later = store.facts().commit;
    expect(later.attempts).toBe(2);
    expect(later.max_ms).toBeGreaterThanOrEqual(later.last_ms!);
    await store.close();
    expect(() => store.facts()).toThrow(expect.objectContaining({ code: "store_closed" }));

    const reopened = await openStore();
    expect(reopened.facts().commit).toEqual(none);
    expect(
      reopened.prepare("SELECT count(*) AS n FROM meta WHERE key IN ('before','after')").get(),
    ).toEqual({ n: 2 });
  });
});
