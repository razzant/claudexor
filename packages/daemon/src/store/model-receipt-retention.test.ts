import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { createPartition } from "./partitions.js";
import {
  MODEL_RECEIPT_PAGE_SQL,
  MODEL_RECEIPT_RETENTION_MS,
  modelReceiptCandidates,
  queryPlan,
} from "./retention.js";
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
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-model-receipts-")));
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

const NOW = new Date("2026-11-09T00:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - MODEL_RECEIPT_RETENTION_MS).toISOString();
const OLD = "2026-09-01T00:00:00.000Z";
const YOUNG = new Date(Date.parse(CUTOFF) + 1).toISOString();

interface ModelRow {
  id: string;
  pid: number;
  state?: string;
  finishedAt?: string | null;
  response?: string | null;
  request?: { id: string; state: string | null };
  responseResource?: { id: string; state: string | null };
  kind?: string;
  live?: 0 | 1;
  /** Explicit rowid, as left by deleted history; omitted rows take max+1. */
  rowid?: number;
}
function seed(store: EngineStore, rows: readonly ModelRow[]): void {
  const command = store.prepare(
    `INSERT INTO command(rowid,id,pid,operation,state,created_at,finished_at,summary,params_sha,kind,live,
       response_state,request_resource_id,response_resource_id)
     VALUES(?,?,?,'model.operation.create',?,?,?,x'7b7d',?,?,?,?,?,?)`,
  );
  const blob = store.prepare("INSERT OR IGNORE INTO blob(sha256,size,inline) VALUES(?,2,x'7b7d')");
  const resource = store.prepare(
    `INSERT INTO resource(id,purpose,kind,sha256,size_bytes,state,created_at,body)
     VALUES(?, 'model', 'file', 'sha', 1, ?, ?, x'7b7d')`,
  );
  store.transaction(() => {
    for (const row of rows) {
      const finished = row.finishedAt === undefined ? OLD : row.finishedAt;
      blob.run(`params-${row.id}`);
      command.run(
        row.rowid ?? null,
        row.id,
        row.pid,
        row.state ?? "succeeded",
        finished ?? OLD,
        finished,
        `params-${row.id}`,
        row.kind ?? "model",
        row.live ?? 1,
        row.response === undefined ? "acknowledged" : row.response,
        row.request?.id ?? null,
        row.responseResource?.id ?? null,
      );
      for (const owned of [row.request, row.responseResource])
        if (owned?.state) resource.run(owned.id, owned.state, finished ?? OLD);
    }
  });
}

describeStore("model receipt retention (#637)", () => {
  it("selects only 30-day terminal receipts whose result custody and resources settled", async () => {
    const store = await openStore();
    const pid = store.transaction(() => createPartition(store, "global").pid);
    const released = (id: string) => ({ id, state: "released" });
    seed(store, [
      // Eligible: every settled response state, exact boundary and a missing resource row.
      {
        id: "e-acknowledged",
        pid,
        request: released("rq-1"),
        responseResource: released("rs-1"),
      },
      {
        id: "e-expired",
        pid,
        state: "failed",
        response: "expired",
        responseResource: { id: "rs-2", state: "expired" },
      },
      { id: "e-absent-unknown", pid, state: "interrupted", response: "absent" },
      {
        id: "e-no-result",
        pid,
        state: "cancelled",
        response: null,
        request: { id: "gone", state: null },
      },
      { id: "e-boundary", pid, finishedAt: CUTOFF },
      // Kept.
      { id: "k-young", pid, finishedAt: YOUNG },
      {
        id: "k-ready-unreconciled",
        pid,
        response: "ready",
        responseResource: { id: "rs-3", state: "ready" },
      },
      { id: "k-running", pid, state: "running", finishedAt: null, response: null },
      { id: "k-queued", pid, state: "queued", finishedAt: null, response: null },
      { id: "k-unknown-lifecycle", pid, state: "mystery" },
      { id: "k-unknown-response", pid, response: "mystery" },
      { id: "k-shared-request", pid, request: { id: "rq-live", state: "ready" } },
      { id: "k-unknown-resource", pid, responseResource: { id: "rs-odd", state: "mystery" } },
      { id: "k-archived", pid, live: 0 },
      { id: "k-product", pid, kind: "product" },
      { id: "account-reset-k", pid, kind: "account_reset" },
    ]);
    const selection = modelReceiptCandidates(store, { now: NOW, after: 0 });
    expect(selection.ids).toEqual([
      "e-acknowledged",
      "e-expired",
      "e-absent-unknown",
      "e-no-result",
      "e-boundary",
    ]);
    expect(selection.next).toBe(16); // rests on the last of 16 rows; the next call wraps
    const plan = queryPlan(store, MODEL_RECEIPT_PAGE_SQL).join("\n");
    expect(plan).toMatch(/SEARCH command USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(plan).not.toMatch(/SCAN command|TEMP B-TREE/);
  });

  it("bounds each call to one occupied window and one batch, resuming across calls and restarts", async () => {
    const store = await openStore();
    const pid = store.transaction(() => createPartition(store, "global").pid);
    // 2,500 young receipts first in rowid order, then 250 expired ones.
    seed(
      store,
      Array.from({ length: 2500 }, (_, n) => ({ id: `young-${n}`, pid, finishedAt: YOUNG })),
    );
    seed(
      store,
      Array.from({ length: 250 }, (_, n) => ({ id: `old-${String(n).padStart(3, "0")}`, pid })),
    );
    const plan: Array<{ ids: number; next: number }> = [];
    let after = 0;
    const victims: string[] = [];
    for (let call = 0; call < 6; call++) {
      const selection = modelReceiptCandidates(store, { now: NOW, after, window: 1000 });
      plan.push({ ids: selection.ids.length, next: selection.next });
      victims.push(...selection.ids);
      after = selection.next;
    }
    // Windows (0,1000] and (1000,2000] hold nothing; (2000,2750] holds 250 → 100, 100, 50;
    // then no row follows 2750, so the same call wraps to the oldest window.
    expect(plan).toEqual([
      { ids: 0, next: 1000 },
      { ids: 0, next: 2000 },
      { ids: 100, next: 2600 },
      { ids: 100, next: 2700 },
      { ids: 50, next: 2750 },
      { ids: 0, next: 1000 },
    ]);
    expect(victims).toHaveLength(250);

    // The pruner owns the deletion and its disposable cursor; a new pruner restarts at 0.
    const blobs = new BlobFiles(store);
    store.transaction(() =>
      bindIdempotencyInTx(store, {
        owner: "command",
        pid,
        keyDigest: "old-key",
        requestDigest: "request",
        operation: "model.operation.create",
        targetId: "old-000",
        createdAt: OLD,
      }),
    );
    const removed: string[] = [];
    for (let call = 0; call < 3; call++) {
      const pruner = new SqlCommandPruner(store, blobs); // a restart each call
      removed.push(...pruner.pruneHistory(500, 0, NOW.getTime()));
    }
    // Each fresh cursor starts at rowid 0; one window per call bounds the work.
    expect(removed).toEqual([]);
    const pruner = new SqlCommandPruner(store, blobs);
    for (let call = 0; call < 8; call++)
      removed.push(...pruner.pruneHistory(500, 0, NOW.getTime()));
    expect(removed.sort()).toEqual(victims.sort());
    expect(store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 2500 });
    expect(store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 0 });
  });

  it("crosses leading and internal rowid gaps in one window and wraps past a deleted, reused max row", async () => {
    const store = await openStore();
    const pid = store.transaction(() => createPartition(store, "global").pid);
    // Deleted history left one aged receipt at rowid 10,000,000, young rows, then a
    // second gap to 20,000,000; one window of existing rows spans both gaps.
    seed(store, [
      { id: "aged-leading", pid, rowid: 10_000_000 },
      ...Array.from({ length: 5 }, (_, n) => ({ id: `young-${n}`, pid, finishedAt: YOUNG })),
      { id: "aged-internal", pid, rowid: 20_000_000 },
      { id: "young-last", pid, finishedAt: YOUNG },
    ]);
    const first = modelReceiptCandidates(store, { now: NOW, after: 0 });
    expect(first).toEqual({ ids: ["aged-leading", "aged-internal"], next: 20_000_001 });
    // A small window still advances by existing rows, never by rowid arithmetic.
    const narrow = [0, 0, 0].reduce<Array<{ ids: string[]; next: number }>>((calls) => {
      const after = calls.at(-1)?.next ?? 0;
      return [...calls, modelReceiptCandidates(store, { now: NOW, after, window: 3 })];
    }, []);
    expect(narrow).toEqual([
      { ids: ["aged-leading"], next: 10_000_002 },
      { ids: [], next: 10_000_005 },
      { ids: ["aged-internal"], next: 20_000_001 },
    ]);
    // The cursor rests on the max row; deleting it lets SQLite reuse that rowid.
    store.transaction(() => store.prepare("DELETE FROM command WHERE id='young-last'").run());
    seed(store, [{ id: "aged-reused", pid }]);
    expect(store.prepare("SELECT rowid AS r FROM command WHERE id='aged-reused'").get()).toEqual({
      r: 20_000_001,
    });
    // No row follows the cursor, so the call wraps and reaches the reused rowid.
    expect(modelReceiptCandidates(store, { now: NOW, after: 20_000_001 })).toEqual({
      ids: ["aged-leading", "aged-internal", "aged-reused"],
      next: 20_000_001,
    });
    // The pruner removes the gap-separated aged rows in one call.
    const pruner = new SqlCommandPruner(store, new BlobFiles(store));
    expect(pruner.pruneHistory(500, 0, NOW.getTime()).sort()).toEqual([
      "aged-internal",
      "aged-leading",
      "aged-reused",
    ]);
    expect(store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 5 });
  });
});
