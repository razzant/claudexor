import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBusyError, StoreCorruptError, StoreFullError } from "./errors.js";
import { EngineStore, type EngineStoreOptions } from "./store.js";

const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;
let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-statement-observer-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function open(onCorrupt?: EngineStoreOptions["onCorrupt"]) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    onCorrupt,
  });
  stores.push(store);
  return store;
}
function damageTable(store: EngineStore, table: string) {
  const page = Number(
    (
      store.prepare("SELECT rootpage FROM sqlite_schema WHERE name=?").get(table) as {
        rootpage: number;
      }
    ).rootpage,
  );
  store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.exec("PRAGMA shrink_memory");
  const fd = openSync(store.paths.database, "r+");
  try {
    writeSync(fd, Buffer.from([0xff]), 0, 1, (page - 1) * 4096);
  } finally {
    closeSync(fd);
  }
}

describeStore("native statement execution observation", () => {
  it.each(["get", "all", "run", "iterate"] as const)(
    "maps real corruption after prepare through %s, before caller catch",
    async (method) => {
      const events: string[] = [];
      let observed: StoreCorruptError | undefined;
      const store = await open((problem) => {
        observed = problem;
        events.push("observer");
      });
      store.transaction(() =>
        store.exec(
          "CREATE TABLE good(v); CREATE TABLE bad(v); INSERT INTO good VALUES('first'),('second'); INSERT INTO bad VALUES('third')",
        ),
      );
      const statement = store.prepare(
        method === "run"
          ? "UPDATE bad SET v='changed'"
          : method === "iterate"
            ? "SELECT v FROM good UNION ALL SELECT v FROM bad"
            : "SELECT v FROM bad",
      );
      damageTable(store, "bad");
      let caught: unknown;
      try {
        if (method === "iterate") {
          const rows = statement.iterate();
          expect(rows[Symbol.iterator]()).toBe(rows);
          expect(rows.next()).toEqual({ done: false, value: { v: "first" } });
          expect(rows.next()).toEqual({ done: false, value: { v: "second" } });
          expect(events).toEqual([]);
          rows.next(); // The first corrupt page is reached lazily here.
        } else statement[method]();
      } catch (error) {
        caught = error;
        events.push("catch");
      }
      expect(caught).toBeInstanceOf(StoreCorruptError);
      expect(caught).toBe(observed);
      expect(caught).toMatchObject({
        code: "store_corrupt",
        status: 503,
        retryable: false,
        cause: { code: "ERR_SQLITE_ERROR", errcode: 11 },
      });
      expect(events).toEqual(["observer", "catch"]);
      expect(store.facts()).toMatchObject({
        integrity: "failed",
        obligations_open: null,
        flusher: { state: "up" },
      });
    },
  );

  it("keeps the native API, cached identity, bindings and iterator return/reset", async () => {
    const onCorrupt = vi.fn();
    const store = await open(onCorrupt);
    store.exec("CREATE TABLE values_table(id INTEGER PRIMARY KEY, value)");
    const insert = store.prepare("INSERT INTO values_table(value) VALUES(?)");
    expect(Object.getPrototypeOf(insert)).toBe(Object.getPrototypeOf(store.db.prepare("SELECT 1")));
    expect(store.prepare("INSERT INTO values_table(value) VALUES(?)")).toBe(insert);
    expect(store.transaction(() => insert.run("one"))).toMatchObject({
      changes: 1,
      lastInsertRowid: 1,
    });
    insert.setReadBigInts(true);
    expect(store.transaction(() => insert.run("two"))).toMatchObject({
      changes: 1n,
      lastInsertRowid: 2n,
    });
    const named = store.prepare("SELECT :value AS value, ? AS positional");
    named.setAllowBareNamedParameters(true);
    named.setAllowUnknownNamedParameters(true);
    named.setReadBigInts(true);
    expect(named.get({ value: 9007199254740993n, ignored: 4 }, "bound")).toEqual({
      value: 9007199254740993n,
      positional: "bound",
    });
    expect(named.sourceSQL).toBe("SELECT :value AS value, ? AS positional");
    expect(named.expandedSQL).toContain("9007199254740993");
    expect(named.columns().map((column) => column.name)).toEqual(["value", "positional"]);
    named.setReturnArrays(true);
    expect(named.get({ value: 7n }, "array")).toEqual([7n, "array"]);
    named.setAllowUnknownNamedParameters(false);
    expect(() => named.get({ value: 7n, ignored: 1 }, "x")).toThrow();
    named.setAllowBareNamedParameters(false);
    expect(() => named.get({ value: 7n }, "x")).toThrow();
    expect(named.get({ ":value": 7n }, "explicit")).toEqual([7n, "explicit"]);

    const query = store.prepare("SELECT value FROM values_table ORDER BY id");
    const iterator = query.iterate();
    const nativeIterator = store.db.prepare("SELECT 1").iterate();
    expect(Object.getPrototypeOf(iterator)).toBe(Object.getPrototypeOf(nativeIterator));
    nativeIterator.return?.();
    expect(iterator[Symbol.iterator]()).toBe(iterator);
    expect(iterator.next()).toEqual({ done: false, value: { value: "one" } });
    expect(iterator.return?.()).toEqual({ done: true, value: null });
    expect(iterator.next()).toEqual({ done: true, value: null });
    for (const value of query.iterate()) {
      expect(value).toEqual({ value: "one" });
      break;
    }
    expect(query.all()).toEqual([{ value: "one" }, { value: "two" }]);
    expect(store.facts()).toMatchObject({ integrity: "pending", obligations_open: 0 });
    expect(onCorrupt).not.toHaveBeenCalled();
  });

  it("preserves constraint/JS errors and maps busy/full without reporting corruption", async () => {
    const onCorrupt = vi.fn();
    const store = await open(onCorrupt);
    store.exec(
      "CREATE TABLE unique_values(id INTEGER PRIMARY KEY); INSERT INTO unique_values VALUES(1)",
    );
    expect(() => store.prepare("INSERT INTO unique_values VALUES(1)").run()).toThrow(
      expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 1555 }),
    );
    const plain = new Error("application callback");
    store.db.function("plain_failure", () => {
      throw plain;
    });
    expect(() => store.prepare("SELECT plain_failure()").get()).toThrow(plain);
    let actual: unknown;
    try {
      store.prepare("SELECT plain_failure()").get();
    } catch (error) {
      actual = error;
    }
    expect(actual).toBe(plain);
    for (const [name, code, Type] of [
      ["full_failure", 13, StoreFullError],
      ["busy_failure", 5, StoreBusyError],
    ] as const) {
      const cause = Object.assign(new Error(name), { code: "ERR_SQLITE_ERROR", errcode: code });
      store.db.function(name, () => {
        throw cause;
      });
      expect(() => store.prepare(`SELECT ${name}()`).get()).toThrow(Type);
    }
    expect(store.facts()).toMatchObject({ integrity: "pending", busy_waits: 1 });
    expect(onCorrupt).not.toHaveBeenCalled();
  });

  it("records failed before notification, keeps it after stale ok, and contains a throwing observer", async () => {
    let store: EngineStore;
    let factsAtNotification: ReturnType<EngineStore["facts"]> | undefined;
    const onCorrupt = vi.fn((_problem: StoreCorruptError) => {
      factsAtNotification = store.facts();
      throw new Error("observer failure must not escape");
    });
    store = await open(onCorrupt);
    const cause = Object.assign(new Error("not a database"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    });
    store.db.function("not_a_database", () => {
      throw cause;
    });
    let caught: unknown;
    try {
      store.prepare("SELECT not_a_database()").get();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(onCorrupt.mock.calls[0]?.[0]);
    expect(caught).toMatchObject({ code: "store_corrupt", cause });
    expect(factsAtNotification).toMatchObject({ integrity: "failed", obligations_open: null });
    store.recordIntegrity("ok");
    expect(store.facts().integrity).toBe("failed");
    expect(() => store.recordIntegrity("failed", "repeat witness")).not.toThrow();
    expect(onCorrupt).toHaveBeenCalledOnce();
    // Observing physical failure does not invent a second SQL admission gate.
    expect(store.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
  });

  it("keeps health facts available when its own obligation count hits corruption", async () => {
    const onCorrupt = vi.fn();
    const store = await open(onCorrupt);
    damageTable(store, "effect_obligation");
    expect(store.facts()).toMatchObject({
      integrity: "failed",
      obligations_open: null,
      interval_ms: 200,
      flusher: { state: "up" },
    });
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(store.facts().obligations_open).toBeNull();
  });
});
