import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createPartition } from "./partitions.js";
import { commandRetentionReferences } from "./retention-command-references.js";
import { RETENTION_ROW_WINDOW, retentionPages } from "./retention-pages.js";
import { EngineStore } from "./store.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-inventory-")));
});
afterEachClosed(async () => {
  for (const store of stores.splice(0)) await store.close();
  return () => rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<EngineStore> {
  const entry = resolve(import.meta.dirname, "../../dist/store/flusher-worker.js");
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: entry,
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}

interface Row {
  id: string;
  pid: number;
  kind: string;
  state: string;
  runId?: string;
  runDir?: string;
  params?: Record<string, unknown>;
  /** Explicit rowid, as left by deleted history; omitted rows take max+1. */
  rowid?: number;
}
function seed(store: EngineStore, rows: readonly Row[]): void {
  const blob = store.prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,?,?)");
  const insert = store.prepare(
    `INSERT INTO command(rowid,id,pid,operation,state,run_id,run_dir,continue_from,created_at,finished_at,
       summary,params_sha,kind) VALUES(?,?,?,'op',?,?,?,?,'2026-01-01',?,x'7b7d',?,?)`,
  );
  store.transaction(() => {
    for (const row of rows) {
      const body = Buffer.from(JSON.stringify(row.params ?? {}));
      const digest = createHash("sha256").update(body).digest("hex");
      blob.run(digest, body.length, body);
      const terminal = !["queued", "running"].includes(row.state);
      insert.run(
        row.rowid ?? null,
        row.id,
        row.pid,
        row.state,
        row.runId ?? null,
        row.runDir ?? null,
        (row.params?.continueFrom as string | undefined) ?? null,
        terminal ? "2026-01-01" : null,
        digest,
        row.kind,
      );
    }
  });
}

/** Rows read through `prepare(...).all` on the command table, plus window seeks (`get`). */
function counting(store: EngineStore) {
  const fetched = { rows: 0, reads: 0, seeks: 0 };
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as Function).bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/FROM command NOT INDEXED/.test(sql)) return statement;
        return new Proxy(statement, {
          get(inner, name) {
            const value = Reflect.get(inner, name, inner) as Function;
            if (name === "get")
              return (...args: unknown[]) => {
                fetched.seeks += 1;
                return value.apply(inner, args);
              };
            if (name !== "all") return typeof value === "function" ? value.bind(inner) : value;
            return (...args: unknown[]) => {
              const rows = value.apply(inner, args) as unknown[];
              fetched.reads += 1;
              fetched.rows += rows.length;
              return rows;
            };
          },
        });
      };
    },
  });
  return { store: proxy, fetched };
}

async function inventory(store: EngineStore, live: number, filtered: boolean) {
  const result = await commandRetentionReferences(
    store,
    (pid) => pid === live,
    new Set(["seed-run"]),
    undefined,
    ...(filtered ? [] : [null]),
  );
  return {
    records: result.records,
    referencedRunIds: [...result.referencedRunIds].sort(),
    nativeRunDirs: [...result.nativeRunDirs].sort(),
    nativeWatchRunDirs: [...result.nativeWatchRunDirs].sort(),
    nativeReferenceError: result.nativeReferenceError(),
    hasActiveCommands: result.hasActiveCommands(),
  };
}

describeStore("disk-retention command inventory reads only kinds it acts on (#638)", () => {
  it("matches the unfiltered page order across live/archived generations, unknown states and history", async () => {
    const store = await openStore();
    const [live, archived] = store.transaction(() => [
      createPartition(store, "global").pid,
      createPartition(store, "global", { epoch: "archived" }).pid,
    ]);
    const dir = join(root, "runs", "dir-run");
    mkdirSync(dir, { recursive: true });
    const noise = (prefix: string, pid: number, count: number): Row[] =>
      Array.from({ length: count }, (_, n) => ({
        id: `${prefix}-${n}`,
        pid,
        kind: n % 3 === 0 ? "maintenance" : "model",
        state: n % 5 === 0 ? "running" : "succeeded",
      }));
    seed(store, [
      ...noise("old-model", archived, 1500),
      { id: "arch-product", pid: archived, kind: "product", state: "succeeded", runId: "arch-run" },
      { id: "arch-queued", pid: archived, kind: "product", state: "queued" },
      ...noise("model-a", live, 1200),
      { id: "base", pid: live, kind: "product", state: "succeeded", runId: "base-run" },
      {
        id: "child",
        pid: live,
        kind: "product",
        state: "failed",
        runId: "child-run",
        params: { continueFrom: "base", retryOf: "retry-run", planRunId: "plan-run" },
      },
      { id: "account-reset-1", pid: live, kind: "account_reset", state: "succeeded" },
      ...noise("model-b", live, 2300),
      { id: "waiting", pid: live, kind: "product", state: "queued" },
      { id: "lost-owner", pid: live, kind: "product", state: "running", runId: "lost-run" },
      { id: "mystery", pid: live, kind: "product", state: "unexpected" },
      { id: "dir", pid: live, kind: "product", state: "running", runId: "dir-run", runDir: dir },
      { id: "delivery-1", pid: live, kind: "delivery", state: "succeeded" },
      { id: "seed-alias", pid: live, kind: "product", state: "succeeded", runId: "seed-run" },
      ...noise("model-c", live, 400),
    ]);
    const before = counting(store);
    const after = counting(store);
    const expected = await inventory(before.store, live, false);
    const actual = await inventory(after.store, live, true);
    expect(actual).toEqual(expected);
    // Sanity: the fixture exercises each branch the inventory owns.
    expect(expected.referencedRunIds).toEqual(
      expect.arrayContaining(["base-run", "retry-run", "plan-run", "seed-run"]),
    );
    expect(expected.records.map((r) => r.runId)).toContain("arch-run");
    expect(expected.nativeReferenceError).toMatch(/lost-owner.*mystery|mystery.*lost-owner/s);
    expect(expected.hasActiveCommands).toBe(true);
    expect(expected.nativeWatchRunDirs).toEqual([dir]);
    // Work: the unfiltered pass hydrates every row; the filtered pass only the 10 it acts on.
    const total = Number(
      (store.prepare("SELECT count(*) AS n FROM command").get() as { n: number }).n,
    );
    expect(before.fetched.rows).toBe(total);
    expect(after.fetched.rows).toBe(10);
    expect(after.fetched.reads).toBe(Math.ceil(total / RETENTION_ROW_WINDOW));
  });

  it("keeps the pass closed on an unsettled retained delivery, exactly as before", async () => {
    const store = await openStore();
    const live = store.transaction(() => createPartition(store, "global").pid);
    seed(store, [
      ...Array.from({ length: 1500 }, (_, n) => ({
        id: `m-${n}`,
        pid: live,
        kind: "model",
        state: "succeeded",
      })),
      { id: "delivery-open", pid: live, kind: "delivery", state: "running" },
    ]);
    for (const filtered of [false, true])
      await expect(inventory(store, live, filtered)).rejects.toThrow(
        /delivery-open.*unsettled|unsettled.*delivery/s,
      );
    // Both statements are rowid-keyset seeks, never a scan of the whole table.
    const plan = (sql: string) =>
      (store.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join("\n");
    expect(
      plan(
        "SELECT rowid FROM command NOT INDEXED WHERE rowid>?1 AND rowid<=?2 AND (kind IN ('product','delivery')) ORDER BY rowid",
      ),
    ).toMatch(/SEARCH command USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(
      plan(
        "SELECT max(r) AS n FROM (SELECT rowid AS r FROM command NOT INDEXED WHERE rowid>? ORDER BY rowid LIMIT ?)",
      ),
    ).toMatch(/SEARCH command USING INTEGER PRIMARY KEY \(rowid>\?\)/);
  });

  it("pays for existing rows, not the rowid gaps deleted history leaves", async () => {
    const store = await openStore();
    const [live, archived] = store.transaction(() => [
      createPartition(store, "global").pid,
      createPartition(store, "global", { epoch: "archived" }).pid,
    ]);
    const models = (prefix: string, count: number, rowid?: number): Row[] =>
      Array.from({ length: count }, (_, n) => ({
        id: `${prefix}-${n}`,
        pid: live,
        kind: "model",
        state: "succeeded",
        ...(n === 0 && rowid ? { rowid } : {}),
      }));
    seed(store, [
      // Leading gap: the oldest retained row sits at rowid 10,000,000.
      {
        id: "lead",
        pid: live,
        kind: "product",
        state: "succeeded",
        runId: "lead-run",
        rowid: 10_000_000,
      },
      ...models("m-a", 1500),
      // Internal gaps between later history.
      { id: "mid", pid: live, kind: "product", state: "queued", rowid: 20_000_000 },
      ...models("m-b", 700, 25_000_000),
      { id: "delivery-done", pid: live, kind: "delivery", state: "succeeded", rowid: 40_000_000 },
      { id: "arch", pid: archived, kind: "product", state: "succeeded", runId: "arch-run" },
    ]);
    const before = counting(store);
    const after = counting(store);
    const expected = await inventory(before.store, live, false);
    expect(await inventory(after.store, live, true)).toEqual(expected);
    expect(expected.records.map((r) => r.runId).sort()).toEqual(["arch-run", "lead-run"]);
    expect(expected.hasActiveCommands).toBe(true);
    const total = 1 + 1500 + 1 + 700 + 1 + 1;
    expect(before.fetched.rows).toBe(total);
    expect(after.fetched.rows).toBe(4);
    // 2,204 existing rows: three occupied windows, plus the seek that finds none left.
    expect(after.fetched.reads).toBe(Math.ceil(total / RETENTION_ROW_WINDOW));
    expect(after.fetched.seeks).toBe(Math.ceil(total / RETENTION_ROW_WINDOW) + 1);
  });

  it("still reads a row reusing a deleted max rowid during the pass, like the unfiltered keyset", async () => {
    const store = await openStore();
    const live = store.transaction(() => createPartition(store, "global").pid);
    const rows: Row[] = Array.from({ length: 1500 }, (_, n) => ({
      id: `r-${n}`,
      pid: live,
      kind: n % 2 ? "model" : "product",
      state: "succeeded",
    }));
    seed(store, rows);
    for (const where of [undefined, "kind IN ('product','delivery')"]) {
      const seen: string[] = [];
      let mutated = false;
      for await (const page of retentionPages<{ id: string }>(
        store,
        "command",
        "id",
        undefined,
        where,
      )) {
        seen.push(...page.map((row) => row.id));
        if (!mutated) {
          // Between reads: delete the max row, then insert one that reuses its rowid.
          mutated = true;
          store.transaction(() => {
            store.prepare("DELETE FROM command WHERE id='r-1499'").run();
          });
          seed(store, [
            { id: `reused-${where ? "f" : "u"}`, pid: live, kind: "product", state: "succeeded" },
          ]);
          expect(
            store.prepare("SELECT rowid AS r FROM command WHERE id LIKE 'reused-%'").get(),
          ).toEqual({ r: 1500 });
        }
      }
      const products = seen.filter((id) => !/^r-\d*[13579]$/.test(id));
      expect(products.at(-1)).toBe(`reused-${where ? "f" : "u"}`);
      expect(products).toHaveLength(751);
      store.transaction(() => {
        store.prepare("DELETE FROM command WHERE id LIKE 'reused-%'").run();
      });
      seed(store, [{ id: "r-1499", pid: live, kind: "model", state: "succeeded" }]);
    }
  });
});
