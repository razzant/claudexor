import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { SqlCommandPruner } from "./command-prune.js";
import { applyCommandInTx, prepareCommandRow } from "./command-rows.js";
import { SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { runMutation } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { commandRetentionCandidates } from "./retention.js";
import { EngineStore } from "./store.js";

const OLD = "2026-01-01T00:00:00.000Z",
  NOW = Date.parse("2026-10-10T00:00:00.000Z"),
  MONTH = 30 * 86400000;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-sql-prune-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    now: () => new Date(OLD),
  });
  cleanup.push(() => store.close());
  const generations = store.transaction(() => [
    createPartition(store, "global"),
    createPartition(store, "project:p"),
  ]);
  const blobs = new BlobFiles(store),
    pruner = new SqlCommandPruner(store, blobs);
  return { root, store, generations, blobs, pruner };
}

describe("SQL command retention contract", () => {
  it("T-RET-1: one global cap, at most 100 per pass, without params/result hydration", async () => {
    const f = await fixture();
    const prepared = Array.from({ length: 800 }, (_, i) =>
      prepareCommandRow(
        {
          id: `c${String(i).padStart(4, "0")}`,
          state: "succeeded",
          params: {
            mode: "ask",
            prompt: "retained",
            scope: { kind: "project", root: `/fixture/p${i % 2}` },
          },
          createdAt: new Date(Date.parse(OLD) + i).toISOString(),
          finishedAt: OLD,
          result: { summary: `result-${i}` },
        },
        {
          pid: f.generations[i % 2]!.pid,
          live: true,
          operation: "run.create",
          clientId: "fixture",
        },
        (bytes) => f.blobs.prepareBody(bytes),
      ),
    );
    runMutation(f.store, (tx) => {
      for (const row of prepared) {
        applyCommandInTx(tx, row, "accept");
        bindIdempotencyInTx(tx, {
          owner: "command",
          pid: row.row.pid,
          keyDigest: row.row.id,
          requestDigest: "request",
          operation: "run.create",
          targetId: row.row.id,
          createdAt: OLD,
        });
      }
    });
    const reads = vi.spyOn(f.blobs, "read");
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const removed = f.pruner.pruneHistory(500, MONTH, NOW);
      expect(removed).toHaveLength(100);
      counts.push(
        Number((f.store.prepare("SELECT count(*) AS n FROM command").get() as { n: number }).n),
      );
    }
    expect(counts).toEqual([700, 600, 500]);
    expect(reads).not.toHaveBeenCalled();
    expect(f.store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 500 });
    expect(f.store.prepare("SELECT root FROM pruned_root ORDER BY root").all()).toEqual([
      { root: "/fixture/p0" },
      { root: "/fixture/p1" },
    ]);
    // Unique inline results disappear with their last owner, while shared params remain.
    expect(f.store.prepare("SELECT count(*) AS n FROM blob").get()).toEqual({ n: 502 });
  });

  it("keeps needs-decision, retained custody, continuation and recent rows; hides old generations", async () => {
    const f = await fixture(),
      pid = f.generations[0]!.pid;
    const specs = [
      { id: "blocked", params: {}, result: { facts: { review: "blocked" } } },
      { id: "checks", params: {}, result: { facts: { checks: "failed" } } },
      { id: "holder", params: {}, runId: "run-holder", runDir: join(f.root, "retained") },
      { id: "successor", params: { continueFrom: "run-holder" } },
      { id: "victim", params: {} },
      { id: "recent", params: {}, finishedAt: new Date(NOW).toISOString() },
      { id: "old-generation", params: {}, live: false },
    ];
    const rows = specs.map((spec) =>
      prepareCommandRow(
        { state: "succeeded", createdAt: OLD, finishedAt: OLD, ...spec },
        { pid, live: spec.live !== false, operation: "legacy", clientId: null },
        (bytes) => f.blobs.prepareBody(bytes),
      ),
    );
    runMutation(f.store, (tx) => {
      for (const row of rows) applyCommandInTx(tx, row, "accept");
    });
    const probes: string[] = [];
    const select = commandRetentionCandidates(f.store, {
      now: new Date(NOW),
      retentionMs: MONTH,
      cap: 0,
      exempt: (row) => {
        probes.push(row.id);
        return row.id === "holder";
      },
    });
    expect(select.victims.map((row) => row.id)).toEqual(["victim"]);
    expect(new Set(probes).size).toBe(probes.length);
    expect(probes).not.toContain("blocked");
    expect(probes).not.toContain("checks");
    expect(probes).not.toContain("old-generation");
    expect(
      f.store
        .prepare(
          "SELECT id,needs_decision FROM command WHERE id IN ('blocked','checks') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "blocked", needs_decision: 1 },
      { id: "checks", needs_decision: 1 },
    ]);
  });

  it("a mid-prune fault rolls every row/binding/event/root back and retained turns keep their keys", async () => {
    const f = await fixture(),
      pid = f.generations[0]!.pid,
      events = new SqlEventLedger(f.store, f.blobs, f.generations[0]!);
    const row = prepareCommandRow(
      {
        id: "victim",
        state: "succeeded",
        params: { scope: { kind: "project", root: "/fixture" } },
        runId: "run-victim",
        createdAt: OLD,
        finishedAt: OLD,
      },
      { pid, live: true, operation: "run.create", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    const event = events.prepare("command.accepted", { record: { id: "victim" } });
    runMutation(f.store, (tx) => {
      applyCommandInTx(tx, row, "accept");
      events.appendInTx(tx, event);
      bindIdempotencyInTx(tx, {
        owner: "command",
        pid,
        keyDigest: "command",
        requestDigest: "request",
        operation: "run.create",
        targetId: "victim",
        createdAt: OLD,
      });
      bindIdempotencyInTx(tx, {
        owner: "turn",
        pid,
        keyDigest: "turn",
        requestDigest: "request",
        operation: "turn.create",
        targetId: "victim",
        createdAt: OLD,
      });
      bindIdempotencyInTx(tx, {
        owner: "decision",
        pid,
        keyDigest: "decision",
        requestDigest: "request",
        operation: "run.decision",
        targetId: "run-victim",
        createdAt: OLD,
      });
      tx.prepare(
        "INSERT INTO turn(id,pid,thread_id,ordinal,created_at,prompt_sha,body) VALUES('victim',?,'thread',1,?,?,x'7b7d')",
      ).run(pid, OLD, row.row.params_sha);
      tx.prepare(
        "INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,'run-victim','resolved',x'7b7d')",
      ).run("run-victim\0q", pid);
      tx.prepare(
        "INSERT INTO operator_decision(run_id,pid,body) VALUES('run-victim',?,x'7b7d')",
      ).run(pid);
      tx.prepare("INSERT INTO run_terminal(run_id,pid,event) VALUES('run-victim',?,x'7b7d')").run(
        pid,
      );
    });
    f.store.transaction(() =>
      f.store.exec(
        "CREATE TRIGGER fail_prune BEFORE DELETE ON command BEGIN SELECT RAISE(ABORT,'prune failure'); END",
      ),
    );
    expect(() => f.pruner.prune(["victim"])).toThrow(/prune failure/);
    for (const table of [
      "command",
      "turn",
      "interaction",
      "operator_decision",
      "run_terminal",
      "event",
    ])
      expect(f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
    expect(f.store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 3 });
    expect(f.store.prepare("SELECT count(*) AS n FROM pruned_root").get()).toEqual({ n: 0 });
    f.store.transaction(() => f.store.exec("DROP TRIGGER fail_prune"));
    f.pruner.prune(["victim"]);
    for (const table of ["command", "interaction", "operator_decision", "run_terminal", "event"])
      expect(f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.store.prepare("SELECT owner FROM idempotency").all()).toEqual([{ owner: "turn" }]);
    expect(f.store.prepare("SELECT id FROM turn").all()).toEqual([{ id: "victim" }]);
    expect(f.store.prepare("SELECT sha256 FROM blob").all()).toEqual([
      { sha256: row.row.params_sha },
    ]);
  });

  it("retires only aged model/reset event copies in bounded passes and keeps their receipts/bindings forever", async () => {
    const f = await fixture(),
      pid = f.generations[0]!.pid,
      events = new SqlEventLedger(f.store, f.blobs, f.generations[0]!);
    const rows = Array.from({ length: 120 }, (_, i) => {
      const id = i % 2 ? `account-reset-${i}` : `model-${i}`;
      const record = {
        id,
        state: "succeeded" as const,
        params:
          i % 2
            ? { kind: "account_reset" }
            : { kind: "model", request: { resourceId: `request-${i}` } },
        createdAt: OLD,
        finishedAt: OLD,
      };
      return {
        prepared: prepareCommandRow(
          record,
          { pid, live: true, operation: "legacy", clientId: null },
          (bytes) => f.blobs.prepareBody(bytes),
        ),
        event: events.prepare("command.accepted", { record }),
      };
    });
    runMutation(f.store, (tx) => {
      for (const { prepared, event } of rows) {
        applyCommandInTx(tx, prepared, "accept");
        events.appendInTx(tx, event);
        bindIdempotencyInTx(tx, {
          owner: "command",
          pid,
          keyDigest: prepared.row.id,
          requestDigest: "request",
          operation: "legacy",
          targetId: prepared.row.id,
          createdAt: OLD,
        });
      }
    });
    expect(f.pruner.pruneHistory(0, 0, NOW)).toEqual([]);
    expect(f.store.prepare("SELECT count(*) AS n FROM event").get()).toEqual({ n: 20 });
    expect(f.pruner.pruneHistory(0, 0, NOW)).toEqual([]);
    expect(f.store.prepare("SELECT count(*) AS n FROM event").get()).toEqual({ n: 0 });
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 120 });
    expect(f.store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 120 });
  });
});
