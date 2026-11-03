import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { digestPendingIdentities, interactionKey } from "../interactions.js";
import type { JobRecord } from "../job-record.js";
import { applyCommandInTx, prepareCommandRow } from "./command-rows.js";
import { SqlCommandQueries } from "./command-queries.js";
import { SqlEventLedger } from "./event-store.js";
import { setGlobalGenerationInTx } from "./generations.js";
import { SqlInteractionStore } from "./interactions.js";
import { createPartition } from "./partitions.js";
import { resourceFixture } from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const TIME = "2026-10-22T00:00:00.000Z";
const EPOCH = "11111111111111111111111111111111";
const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-observation-query-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const f = await resourceFixture(root, { manualTick: true, now: () => new Date(TIME) });
  cleanup.push(() => f.close());
  const generation = f.store.transaction(() => {
    const value = createPartition(f.store, "global", { epoch: EPOCH });
    setGlobalGenerationInTx(f.store, value.pid);
    return value;
  });
  const queries = new SqlCommandQueries(f.store, f.blobs);
  const pending = new SqlInteractionStore(
    f.store,
    new SqlEventLedger(f.store, f.blobs, generation),
  );
  function seed(id: string, patch: Partial<JobRecord> = {}, pid = generation.pid, live = true) {
    const row = prepareCommandRow(
      {
        id,
        state: "running",
        runId: `run-${id}`,
        createdAt: TIME,
        params: { mode: "ask", prompt: "fixture body" },
        ...patch,
      },
      { pid, live, operation: "ask", clientId: "fixture" },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, row, "accept"));
  }
  function identity(runId: string, id: string, state = "pending", pid = generation.pid) {
    f.store
      .prepare("INSERT INTO interaction(id,pid,run_id,state,request) VALUES(?,?,?,?,?)")
      .run(interactionKey(runId, id), pid, runId, state, Buffer.from("unreadable question body"));
  }
  return { ...f, generation, queries, pending, seed, identity };
}

describe("SQL observationRecords addressed scalar selection", () => {
  it("joins the owning generation and deduplicates aliases without selecting any body column", async () => {
    const f = await fixture();
    const project = f.store.transaction(() =>
      createPartition(f.store, "project:fixture", {
        epoch: "22222222222222222222222222222222",
      }),
    );
    f.seed("job-a", { runId: "run-a", state: "succeeded" });
    f.seed("job-queued", { runId: undefined, state: "queued" });
    f.seed("job-project", { runId: "run-project" }, project.pid);
    f.seed("job-unrelated", { params: { mode: "ask", prompt: "p".repeat(70_000) } });
    // Neither selected nor unrelated compact summaries may be decoded.
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE command SET summary=?")
        .run(Buffer.from(JSON.stringify("invalid command summary shape"))),
    );
    const read = vi.spyOn(f.blobs, "read");
    const prepare = vi.spyOn(f.store, "prepare");
    const rows = f.queries.observationRecords([
      "run-a",
      "job-a",
      "run-a",
      "job-queued",
      "run-project",
      "missing",
    ]);
    expect([...rows].sort((a, b) => a.jobId.localeCompare(b.jobId))).toEqual([
      {
        jobId: "job-a",
        runId: "run-a",
        partition: "global",
        epoch: EPOCH,
        state: "succeeded",
        createdAt: TIME,
      },
      {
        jobId: "job-project",
        runId: "run-project",
        partition: "project:fixture",
        epoch: "22222222222222222222222222222222",
        state: "running",
        createdAt: TIME,
      },
      {
        jobId: "job-queued",
        runId: null,
        partition: "global",
        epoch: EPOCH,
        state: "queued",
        createdAt: TIME,
      },
    ]);
    expect(read).not.toHaveBeenCalled();
    const commandReads = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /\bFROM\s+command\b/i.test(sql));
    expect(commandReads).toHaveLength(1);
    const projection = commandReads[0]!.split(/\bFROM\b/i)[0]!;
    expect(projection).not.toMatch(/\*|\b(summary|params_sha|result_sha|error|run_dir)\b/i);
    expect(commandReads[0]).toMatch(/\bJOIN\s+partition\b/i);
  });

  it("excludes non-product and retired rows even when addressed by their exact handles", async () => {
    const f = await fixture();
    f.seed("job-product", { runId: "run-product" });
    f.seed("job-retired", { runId: "run-retired" }, f.generation.pid, false);
    f.seed("delivery-copy", { runId: "run-delivery" });
    f.seed("job-model", { runId: "run-model", params: { kind: "model" } });
    f.seed("job-maintenance", {
      runId: "run-maintenance",
      params: { kind: "harness_maintenance", harness: "codex" },
    });
    f.seed("account-reset-fixture", { runId: "run-reset", params: { kind: "account_reset" } });
    expect(
      f.queries.observationRecords([
        "job-product",
        "run-product",
        "job-retired",
        "run-retired",
        "delivery-copy",
        "run-delivery",
        "job-model",
        "run-model",
        "job-maintenance",
        "run-maintenance",
        "account-reset-fixture",
        "run-reset",
      ]),
    ).toEqual([
      {
        jobId: "job-product",
        runId: "run-product",
        partition: "global",
        epoch: EPOCH,
        state: "running",
        createdAt: TIME,
      },
    ]);
  });

  it("does not query history for an empty addressed set", async () => {
    const f = await fixture();
    f.seed("job-unrelated");
    const prepare = vi.spyOn(f.store, "prepare");
    expect(f.queries.observationRecords([])).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("SQL pendingIdentityDigest", () => {
  it("hashes the complete sorted identity set independent of insertion order, without request bodies", async () => {
    const f = await fixture();
    f.store.transaction(() => {
      f.identity("run-a", "question-z");
      f.identity("run-a", "question-a");
      f.identity("run-a", "resolved", "resolved");
      f.identity("run-other", "unrelated");
    });
    const prepare = vi.spyOn(f.store, "prepare");
    const bodies = vi.spyOn(f.pending, "pendingForRun");
    const first = f.pending.pendingIdentityDigest("run-a");
    expect(first).toEqual({ pending: true, digest: expect.any(String) });
    expect(first).toEqual(
      digestPendingIdentities([
        interactionKey("run-a", "question-a"),
        interactionKey("run-a", "question-z"),
      ]),
    );
    expect(first.digest.length).toBeGreaterThan(0);
    const reads = prepare.mock.calls.map(([sql]) => sql);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.split(/\bFROM\b/i)[0]).not.toMatch(/\*|\b(request|resolution)\b/i);
    expect(reads[0]).toMatch(/\bORDER\s+BY\s+(?:\w+\.)?id\b/i);
    expect(bodies).not.toHaveBeenCalled();
    f.store.transaction(() => {
      f.store.prepare("DELETE FROM interaction WHERE run_id='run-a'").run();
      f.identity("run-a", "question-a");
      f.identity("run-a", "question-z");
    });
    expect(f.pending.pendingIdentityDigest("run-a")).toEqual(first);
    f.store.transaction(() => f.identity("run-a", "question-middle"));
    expect(f.pending.pendingIdentityDigest("run-a").digest).not.toBe(first.digest);
  });

  it("hashes IDs beyond a large common prefix and distinguishes ambiguous concatenations", async () => {
    const f = await fixture();
    f.store.transaction(() => {
      for (let i = 0; i < 1025; i++) f.identity("run-a", `common-${String(i).padStart(4, "0")}`);
      f.identity("run-a", "zz-tail-A");
    });
    const a = f.pending.pendingIdentityDigest("run-a");
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE interaction SET id=? WHERE id=?")
        .run(interactionKey("run-a", "zz-tail-B"), interactionKey("run-a", "zz-tail-A")),
    );
    const b = f.pending.pendingIdentityDigest("run-a");
    expect(a.pending).toBe(true);
    expect(b.pending).toBe(true);
    expect(b.digest).not.toBe(a.digest);
    f.store.transaction(() => {
      f.store.prepare("DELETE FROM interaction").run();
      f.identity("run-a", "a");
      f.identity("run-a", "bc");
    });
    const ab = f.pending.pendingIdentityDigest("run-a");
    f.store.transaction(() => {
      f.store.prepare("DELETE FROM interaction").run();
      f.identity("run-a", "ab");
      f.identity("run-a", "c");
    });
    expect(f.pending.pendingIdentityDigest("run-a").digest).not.toBe(ab.digest);
    const prefix = "question-" + "q".repeat(4096);
    f.store.transaction(() => {
      f.store.prepare("DELETE FROM interaction").run();
      f.identity("run-a", `${prefix}A`);
    });
    const longA = f.pending.pendingIdentityDigest("run-a");
    f.store.transaction(() =>
      f.store
        .prepare("UPDATE interaction SET id=? WHERE id=?")
        .run(interactionKey("run-a", `${prefix}B`), interactionKey("run-a", `${prefix}A`)),
    );
    expect(f.pending.pendingIdentityDigest("run-a").digest).not.toBe(longA.digest);
  });

  it("uses full storage identity keys, addresses run and partition, and reports a known empty set", async () => {
    const f = await fixture();
    const other = f.store.transaction(() => createPartition(f.store, "project:other"));
    const otherPending = new SqlInteractionStore(
      f.store,
      new SqlEventLedger(f.store, f.blobs, other),
    );
    f.store.transaction(() => {
      f.identity("run-a", "same-question");
      f.identity("run-b", "same-question");
      f.identity("run-c", "only-other-partition", "pending", other.pid);
    });
    const a = f.pending.pendingIdentityDigest("run-a");
    const b = f.pending.pendingIdentityDigest("run-b");
    expect(a.digest).not.toBe(b.digest);
    const empty = f.pending.pendingIdentityDigest("run-missing");
    expect(empty).toEqual({ pending: false, digest: expect.any(String) });
    expect(empty.digest.length).toBeGreaterThan(0);
    expect(f.pending.pendingIdentityDigest("run-c")).toEqual(empty);
    expect(otherPending.pendingIdentityDigest("run-c")).toEqual({
      pending: true,
      digest: expect.any(String),
    });
    f.store.transaction(() =>
      f.store.prepare("UPDATE interaction SET state='resolved' WHERE run_id='run-a'").run(),
    );
    expect(f.pending.pendingIdentityDigest("run-a")).toEqual(empty);
  });
});
