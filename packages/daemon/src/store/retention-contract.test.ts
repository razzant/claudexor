import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  WorkspaceManager,
  retainForInspection,
  releaseRetainedEnvelope,
} from "@claudexor/workspace";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BlobFiles } from "./blob-files.js";
import { applyCommandPruneInTx, SqlCommandPruner } from "./command-prune.js";
import { applyCommandInTx, prepareCommandRow } from "./command-rows.js";
import { SqlEventLedger } from "./event-store.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { SqlInteractionStore } from "./interactions.js";
import { runMutation } from "./mutation.js";
import { createPartition } from "./partitions.js";
import { RetentionReferenceReader } from "./retention-reference-reader.js";
import { diskRetentionReferences } from "./retention-references.js";
import { commandRetentionCandidates } from "./retention.js";
import { EngineStore } from "./store.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

const OLD = "2026-01-01T00:00:00.000Z",
  NOW = Date.parse("2026-10-10T00:00:00.000Z"),
  MONTH = 30 * 86400000;
const cleanup: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cx-sql-prune-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
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
  it("decodes NUL-delimited interaction IDs before pruning their event groups and bodies", async () => {
    const f = await fixture(),
      generation = f.generations[0]!,
      events = new SqlEventLedger(f.store, f.blobs, generation),
      interactions = new SqlInteractionStore(f.store, events);
    const victim = "run-π",
      keeper = "run-keeper",
      ids = ["question:first", "question:β"];
    for (const runId of [victim, keeper]) {
      const command = prepareCommandRow(
        { id: runId, runId, state: "succeeded", params: {}, createdAt: OLD, finishedAt: OLD },
        { pid: generation.pid, live: true, operation: "run.create", clientId: "fixture" },
        (bytes) => f.blobs.prepareBody(bytes),
      );
      runMutation(f.store, (tx) => applyCommandInTx(tx, command, "accept"));
      for (const interactionId of runId === victim ? ids : [ids[0]!])
        interactions.request({
          runId,
          taskId: "task",
          attemptId: "a01",
          harnessId: "codex",
          requestedAt: OLD,
          timeoutAt: null,
          request: {
            interaction_id: interactionId,
            source_tool: "AskUserQuestion",
            questions: [
              {
                id: "q",
                question: "q".repeat(70_000),
                header: null,
                options: [],
                multi_select: false,
              },
            ],
          },
        });
    }
    const before = f.store
      .prepare("SELECT group_key,payload_sha FROM event ORDER BY group_key")
      .all() as Array<{ group_key: string; payload_sha: string }>;
    const victimKeys = ids.map((id) => `i:${victim}:${id}`);
    const keeperKey = `i:${keeper}:${ids[0]}`;
    expect(before.map((row) => row.group_key).sort()).toEqual([...victimKeys, keeperKey].sort());
    for (const row of before) expect(existsSync(f.blobs.filePath(row.payload_sha))).toBe(true);
    const kept = before.find((row) => row.group_key === keeperKey)!;
    const keptBytes = f.blobs.read(kept.payload_sha);

    const returnedIds: unknown[] = [];
    const prepare = f.store.prepare.bind(f.store);
    vi.spyOn(f.store, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("DELETE FROM interaction ")) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: unknown[]) => {
          const rows = Reflect.apply(all, statement, args) as ReturnType<typeof statement.all>;
          // Emulate Node 24.15's TEXT truncation on newer Node too; BLOBs stay intact.
          for (const row of rows) {
            if (typeof row.id === "string") row.id = row.id.split("\0")[0]!;
            returnedIds.push(row.id);
          }
          return rows;
        });
      }
      return statement;
    });
    const gc = vi.spyOn(f.blobs, "gc");
    f.pruner.prune([victim]);
    expect(f.store.prepare("SELECT group_key FROM event").all()).toEqual([
      { group_key: keeperKey },
    ]);
    expect(f.store.prepare("SELECT run_id FROM interaction").all()).toEqual([{ run_id: keeper }]);
    expect(f.store.prepare("SELECT id FROM command").all()).toEqual([{ id: keeper }]);
    for (const id of returnedIds) expect(id).toBeInstanceOf(Uint8Array);
    expect(
      new Set(returnedIds.map((id) => Buffer.from(id as Uint8Array).toString("utf8"))),
    ).toEqual(new Set(ids.map((id) => `${victim}\0${id}`)));
    const retired = before.filter((row) => victimKeys.includes(row.group_key));
    expect(gc.mock.calls.map(([sha]) => sha).sort()).toEqual(
      retired.map((row) => row.payload_sha).sort(),
    );
    f.store.flusherControl.tick();
    await Promise.all(gc.mock.results.map((result) => result.value));
    for (const row of retired) {
      expect(
        f.store.prepare("SELECT 1 FROM blob WHERE sha256=?").get(row.payload_sha),
      ).toBeUndefined();
      expect(existsSync(f.blobs.filePath(row.payload_sha))).toBe(false);
    }
    expect(f.blobs.read(kept.payload_sha)).toEqual(keptBytes);
    expect(existsSync(f.blobs.filePath(kept.payload_sha))).toBe(true);
  });

  it("refreshes full NUL-delimited interaction IDs published during a retention pass", async () => {
    const f = await fixture(),
      events = new SqlEventLedger(f.store, f.blobs, f.generations[0]!),
      interactions = new SqlInteractionStore(f.store, events);
    const runId = "run-π",
      interactionId = "question:β",
      fullId = `${runId}\0${interactionId}`;
    const changes: Array<{ table: unknown; id: unknown }> = [];
    const register = f.store.db.function.bind(f.store.db);
    vi.spyOn(f.store.db, "function").mockImplementation((name, callback) => {
      if (name !== "disk_retention_changed") return register(name, callback);
      register(name, (table, id, root) => {
        changes.push({ table, id });
        // Emulate Node 24.15's TEXT truncation on newer Node too; BLOBs stay intact.
        return callback(table, typeof id === "string" ? id.split("\0")[0]! : id, root);
      });
    });
    const refresh = vi.spyOn(RetentionReferenceReader.prototype, "refresh");
    const proof = await diskRetentionReferences(f.store);
    cleanup.push(() => proof.close?.());
    expect(proof.referencedRunIds.size).toBe(0);
    interactions.request({
      runId,
      taskId: "task",
      attemptId: "a01",
      harnessId: "codex",
      requestedAt: OLD,
      timeoutAt: null,
      request: {
        interaction_id: interactionId,
        source_tool: "AskUserQuestion",
        questions: [
          { id: "q", question: "Continue?", header: null, options: [], multi_select: false },
        ],
      },
    });
    expect(proof.referencedRunIds.has(runId)).toBe(false);
    await proof.refresh!();
    expect(proof.referencedRunIds).toEqual(new Set([runId]));
    expect(refresh).toHaveBeenCalledExactlyOnceWith("interaction", fullId);
    expect(changes).toEqual([{ table: "interaction", id: expect.any(Uint8Array) }]);
    expect(Buffer.from(changes[0]!.id as Uint8Array).toString("utf8")).toBe(fullId);
  });

  it("last-owner inline cleanup waits for every writer in the composed transaction", async () => {
    const f = await fixture(),
      pid = f.generations[0]!.pid;
    const row = prepareCommandRow(
      {
        id: "victim",
        params: { prompt: "keep exact bytes" },
        state: "succeeded",
        createdAt: OLD,
        finishedAt: OLD,
      },
      { pid, live: true, operation: "legacy", clientId: null },
      (bytes) => f.blobs.prepareBody(bytes),
    );
    runMutation(f.store, (tx) => {
      applyCommandInTx(tx, row, "accept");
      tx.changes.blobChanged(row.row.params_sha);
    });
    const before = f.blobs.read(row.row.params_sha);
    runMutation(f.store, (tx) => {
      tx.changes.blobChanged(...applyCommandPruneInTx(tx, [row.row]));
      tx.prepare(
        "INSERT INTO turn(id,pid,thread_id,ordinal,created_at,prompt_sha,body) VALUES('turn',?,'thread',1,?,?,x'7b7d')",
      ).run(pid, OLD, row.row.params_sha);
    });
    expect(f.blobs.read(row.row.params_sha)).toEqual(before);
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 0 });
    runMutation(f.store, (tx) => {
      tx.prepare("DELETE FROM turn WHERE id='turn'").run();
      tx.changes.blobChanged(row.row.params_sha);
    });
    expect(f.store.prepare("SELECT count(*) AS n FROM blob").get()).toEqual({ n: 0 });
  });
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

  it("keeps an expired inspection holder addressable until explicit source release", async () => {
    const f = await fixture();
    const repo = join(f.root, "project");
    const runDir = join(f.root, "run-inspection");
    mkdirSync(repo);
    mkdirSync(runDir);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-q");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    );
    const manager = new WorkspaceManager(repo);
    const envelope = await manager.create({
      taskId: "inspection-task",
      attemptId: "a01",
      baseRef: "HEAD",
    });
    writeFileSync(join(envelope.worktree_path, "kept.txt"), "unique source");
    const custody = retainForInspection(envelope, { runId: "run-inspection", runDir });
    cleanup.push(async () => {
      await releaseRetainedEnvelope(custody);
    });
    const rows = Array.from({ length: 501 }, (_, i) =>
      prepareCommandRow(
        {
          id: `old-${String(i).padStart(4, "0")}`,
          state: "succeeded",
          params: {},
          createdAt: new Date(Date.parse(OLD) + i).toISOString(),
          finishedAt: OLD,
          ...(i === 0 ? { runId: "run-inspection", runDir } : {}),
        },
        { pid: f.generations[0]!.pid, live: true, operation: "run.create", clientId: null },
        (bytes) => f.blobs.prepareBody(bytes),
      ),
    );
    runMutation(f.store, (tx) => {
      for (const row of rows) applyCommandInTx(tx, row, "accept");
    });
    expect(f.pruner.pruneHistory(500, MONTH, NOW)).toEqual(["old-0001"]);
    expect(f.store.prepare("SELECT id FROM command WHERE run_id=?").get("run-inspection")).toEqual({
      id: "old-0000",
    });
    expect(readFileSync(join(envelope.worktree_path, "kept.txt"), "utf8")).toBe("unique source");
    await releaseRetainedEnvelope(custody);
    expect(f.pruner.pruneHistory(499, MONTH, NOW)).toEqual(["old-0000"]);
  });

  it("holds only a candidate whose inspection addresses cannot be read and prunes the rest", async () => {
    const f = await fixture();
    const lines: string[] = [];
    const pruner = new SqlCommandPruner(f.store, f.blobs, { log: (line) => lines.push(line) });
    const runDir = join(f.root, "run-unreadable");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "attempts"), "not a directory");
    const rows = Array.from({ length: 502 }, (_, i) =>
      prepareCommandRow(
        {
          id: `old-${String(i).padStart(4, "0")}`,
          state: "succeeded",
          params: {},
          createdAt: new Date(Date.parse(OLD) + i).toISOString(),
          finishedAt: OLD,
          ...(i === 0 ? { runId: "run-unreadable", runDir } : {}),
        },
        { pid: f.generations[0]!.pid, live: true, operation: "run.create", clientId: null },
        (bytes) => f.blobs.prepareBody(bytes),
      ),
    );
    runMutation(f.store, (tx) => {
      for (const row of rows) applyCommandInTx(tx, row, "accept");
    });
    expect(pruner.pruneHistory(500, MONTH, NOW)).toEqual(["old-0001", "old-0002"]);
    expect(f.store.prepare("SELECT id FROM command WHERE run_id=?").get("run-unreadable")).toEqual({
      id: "old-0000",
    });
    expect(lines).toEqual([expect.stringMatching(/old-0000\b.*run-unreadable.*ENOTDIR/)]);
  });

  it("holds a candidate whose inspection pointer is invalid and prunes the rest", async () => {
    const f = await fixture();
    const lines: string[] = [];
    const pruner = new SqlCommandPruner(f.store, f.blobs, { log: (line) => lines.push(line) });
    const runDir = join(f.root, "run-invalid-pointer");
    mkdirSync(join(runDir, "attempts", "a01"), { recursive: true });
    writeFileSync(join(runDir, "attempts", "a01", "retained-envelope.json"), "{");
    const rows = Array.from({ length: 502 }, (_, i) =>
      prepareCommandRow(
        {
          id: `old-${String(i).padStart(4, "0")}`,
          state: "succeeded",
          params: {},
          createdAt: new Date(Date.parse(OLD) + i).toISOString(),
          finishedAt: OLD,
          ...(i === 0 ? { runId: "run-invalid-pointer", runDir } : {}),
        },
        { pid: f.generations[0]!.pid, live: true, operation: "run.create", clientId: null },
        (bytes) => f.blobs.prepareBody(bytes),
      ),
    );
    runMutation(f.store, (tx) => {
      for (const row of rows) applyCommandInTx(tx, row, "accept");
    });
    expect(pruner.pruneHistory(500, MONTH, NOW)).toEqual(["old-0001", "old-0002"]);
    expect(
      f.store.prepare("SELECT id FROM command WHERE run_id=?").get("run-invalid-pointer"),
    ).toEqual({ id: "old-0000" });
    expect(lines).toEqual([
      expect.stringMatching(
        /old-0000\b.*run-invalid-pointer.*invalid retained-envelope pointer at .*a01[\\/]retained-envelope\.json/,
      ),
    ]);
    // A readable, released address is legitimately nothing held: the row prunes.
    rmSync(join(runDir, "attempts", "a01", "retained-envelope.json"));
    expect(pruner.pruneHistory(499, MONTH, NOW)).toEqual(["old-0000"]);
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

  it("retires 30-day model receipts with their events and bindings, keeping account resets and only aging their event copies", async () => {
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
    const models = rows.filter((_, i) => i % 2 === 0).map(({ prepared }) => prepared.row.id);
    // Product cap/age are 0 here: model receipts follow only their own 30 days.
    expect(f.pruner.pruneHistory(0, 0, Date.parse(OLD) + MONTH - 1)).toEqual([]);
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 120 });
    expect(f.pruner.pruneHistory(0, 0, NOW)).toEqual(models);
    // One batch removed each model receipt's own event keys; reset copies age separately.
    expect(f.store.prepare("SELECT count(*) AS n FROM event").get()).toEqual({ n: 0 });
    expect(f.pruner.pruneHistory(0, 0, NOW)).toEqual([]);
    expect(f.store.prepare("SELECT DISTINCT kind FROM command").all()).toEqual([
      { kind: "account_reset" },
    ]);
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 60 });
    expect(f.store.prepare("SELECT count(*) AS n FROM idempotency").get()).toEqual({ n: 60 });
    expect(
      f.store.prepare("SELECT count(*) AS n FROM idempotency WHERE target_id LIKE 'model-%'").get(),
    ).toEqual({ n: 0 });
  });
});
