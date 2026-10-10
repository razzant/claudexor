import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "./test-support/fixtures/legacy/journal/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { journalFoldPolicy } from "../journal-fold-policy.js";
import { createPartition } from "./partitions.js";
import {
  COMMAND_PRUNABLE_PAGE_SQL,
  COMMAND_TERMINAL_COUNT_SQL,
  RETAINED_PREDECESSOR_SQL,
  appendEvent,
  commandKind,
  commandRetentionCandidates,
  queryPlan,
  terminalCommandCount,
} from "./retention.js";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
const journals: DurableJournal[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-retention-")));
});
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function openStore(): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  stores.push(store);
  return store;
}

/** A realistic record sequence spanning every verdict kind of the daemon fold policy. */
function recordSequence(): Array<{ type: string; payload: unknown }> {
  const run = (runId: string, type: string, extra: Record<string, unknown> = {}) => ({
    type: "run.event",
    payload: {
      run_id: runId,
      task_id: `task-${runId}`,
      type,
      ts: "2026-10-10T00:00:00.000Z",
      ...extra,
    },
  });
  const command = (id: string, type: "command.accepted" | "command.updated", state: string) => ({
    type,
    payload: {
      record: { id, state, createdAt: "t" },
      keyDigest: `k-${id}`,
      requestDigest: `r-${id}`,
    },
  });
  return [
    command("c1", "command.accepted", "queued"),
    command("c1", "command.updated", "running"),
    run("run-1", "run.created"),
    run("run-1", "output.ready"),
    { type: "interaction.requested", payload: { runId: "run-1", interactionId: "q1" } },
    { type: "interaction.resolved", payload: { runId: "run-1", interactionIds: ["q1"] } },
    run("run-1", "run.completed", { run_facts: { outcome: { lifecycle: "succeeded" } } }),
    command("c1", "command.updated", "succeeded"),
    { type: "thread.head.updated", payload: { thread_id: "thr-1", revision: 1 } },
    { type: "thread.head.updated", payload: { thread_id: "thr-1", revision: 2 } },
    { type: "quota.projection.updated", payload: { projection_signature: "a" } },
    { type: "quota.projection.updated", payload: { projection_signature: "b" } },
    { type: "setup.job.log", payload: { jobId: "job-1", line: "one" } },
    { type: "setup.job.log", payload: { jobId: "job-1", line: "two" } },
    { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "running" } } },
    { type: "setup.job.saved", payload: { job: { jobId: "job-1", state: "completed" } } },
    command("c2", "command.accepted", "queued"),
    run("run-2", "run.created"),
    run("run-2", "run.failed", { run_facts: { outcome: { lifecycle: "failed" } } }),
    command("c2", "command.updated", "failed"),
    { type: "command.pruned", payload: { ids: ["c1"], roots: ["/r"], run_ids: ["run-1"] } },
    { type: "unknown.type", payload: { kept: true } },
    { type: "command.pruned", payload: { ids: ["c2"], roots: ["/r"], run_ids: ["run-2"] } },
  ];
}

describeStore("event retention through the journal fold verdicts (SYNTHESIS_R5 §6.6)", () => {
  it("retains exactly the sequence numbers the folded journal retains", async () => {
    const options = {
      rootDir: join(root, "journal"),
      partition: "global",
      fold: journalFoldPolicy,
    };
    const writer = new DurableJournal(options);
    for (const record of recordSequence()) writer.append(record.type, record.payload);
    writer.close();
    const reader = new DurableJournal(options);
    journals.push(reader);
    const expected = reader.records().map((record) => [record.seq, record.type] as const);
    expect(reader.currentSequence()).toBe(recordSequence().length);
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "global"));
    const appended = recordSequence().map((record) =>
      store.transaction(() => appendEvent(store, generation.pid, record)),
    );
    expect(appended.map((a) => a.seq)).toEqual(recordSequence().map((_, index) => index + 1));
    const retained = (
      store
        .prepare("SELECT seq, type FROM event WHERE pid = ? ORDER BY seq")
        .all(generation.pid) as Array<{
        seq: number;
        type: string;
      }>
    ).map((row) => [Number(row.seq), row.type] as const);
    expect(retained).toEqual(expected);
    expect(retained.map(([, type]) => type)).toContain("unknown.type");
    expect(retained.some(([, type]) => type === "interaction.resolved")).toBe(false);
    expect(
      Number(
        (
          store.prepare("SELECT next_seq FROM partition WHERE id = ?").get(generation.pid) as {
            next_seq: number;
          }
        ).next_seq,
      ),
    ).toBe(recordSequence().length + 1);
  });

  it("reports the payload digests its retire/slot deletes released (owner changes for the GC)", async () => {
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "global"));
    const digestA = "a".repeat(64);
    const digestB = "b".repeat(64);
    const first = store.transaction(() =>
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 1 },
        payloadSha: digestA,
      }),
    );
    expect(first.releasedDigests).toEqual([]);
    const live = store.transaction(() =>
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "harness.started", ts: "t" },
        payloadSha: digestB,
      }),
    );
    expect(live.releasedDigests).toEqual([]);
    // The slot replacement releases digest A; the terminal retires the live group and releases B.
    const replaced = store.transaction(() =>
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 2 },
      }),
    );
    expect(replaced.releasedDigests).toEqual([digestA]);
    const terminal = store.transaction(() =>
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "run.completed", ts: "t", run_facts: {} },
      }),
    );
    expect(terminal.releasedDigests).toEqual([digestB]);
    // Rows without a digest release nothing.
    const plain = store.transaction(() =>
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 3 },
      }),
    );
    expect(plain.releasedDigests).toEqual([]);
  });

  it("writes slot and group keys the way the policy names them", async () => {
    const store = await openStore();
    const generation = store.transaction(() => createPartition(store, "global"));
    store.transaction(() => {
      appendEvent(store, generation.pid, {
        type: "thread.head.updated",
        payload: { thread_id: "t", revision: 1 },
      });
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "run.created", ts: "t" },
      });
      appendEvent(store, generation.pid, {
        type: "run.event",
        payload: { run_id: "r", task_id: "k", type: "harness.started", ts: "t" },
      });
    });
    const rows = store
      .prepare("SELECT seq, slot_key, group_key FROM event WHERE pid = ? ORDER BY seq")
      .all(generation.pid) as Array<{
      seq: number;
      slot_key: string | null;
      group_key: string | null;
    }>;
    expect(rows).toEqual([
      { seq: 1, slot_key: "t:t", group_key: null },
      { seq: 2, slot_key: "r:r:c", group_key: null },
      { seq: 3, slot_key: null, group_key: "r:r:live" },
    ]);
  });
});

describeStore("command kind (R5_AMENDMENTS A1)", () => {
  it("classifies at accept from id prefix and params", () => {
    expect(commandKind("account-reset-1", {})).toBe("account_reset");
    expect(commandKind("delivery-1", {})).toBe("delivery");
    expect(commandKind("cmd-1", { kind: "model", request: {} })).toBe("model");
    expect(commandKind("cmd-2", { kind: "harness_maintenance", harness: "codex" })).toBe(
      "maintenance",
    );
    expect(commandKind("cmd-3", { prompt: "hi" })).toBe("product");
  });
});

interface Seed {
  prefix: string;
  pid: number;
  count: number;
  live?: 0 | 1;
  kind?: string;
  needsDecision?: number;
  continuations?: number;
  /** ISO day the rows were created/finished on. */
  day?: string;
}
function seedCommands(store: EngineStore, seed: Seed): void {
  const insert = store.prepare(
    `INSERT INTO command(id, pid, operation, state, run_id, continue_from, created_at, finished_at, summary, params_sha, kind, live, needs_decision)
     VALUES(?, ?, 'run.create', 'succeeded', ?, ?, ?, ?, x'00', 'sha', ?, ?, ?)`,
  );
  const base = Date.parse(seed.day ?? "2026-01-01T00:00:00.000Z");
  store.transaction(() => {
    for (let i = 0; i < seed.count; i += 1) {
      const id = `${seed.prefix}-${String(i).padStart(6, "0")}`;
      const created = new Date(base + i * 60_000).toISOString();
      const needsDecision = i < (seed.needsDecision ?? 0) ? 1 : 0;
      const continuation =
        i >= seed.count - (seed.continuations ?? 0)
          ? `run-${seed.prefix}-${String(i - 1).padStart(6, "0")}`
          : null;
      insert.run(
        id,
        seed.pid,
        `run-${id}`,
        continuation,
        created,
        created,
        seed.kind ?? "product",
        seed.live ?? 1,
        needsDecision,
      );
    }
  });
}
const NOW = new Date("2026-10-10T00:00:00.000Z");
const MONTH = 30 * 86_400_000;

describeStore("bounded command retention (R5_AMENDMENTS B1/C1, T-RET-1)", () => {
  it("counts today's terminal set over live generations, bounded by cap + batch", async () => {
    const store = await openStore();
    seedCommands(store, { prefix: "a", pid: 1, count: 300 });
    seedCommands(store, { prefix: "b", pid: 2, count: 300 });
    seedCommands(store, { prefix: "old", pid: 3, count: 500, live: 0 });
    seedCommands(store, { prefix: "model", pid: 1, count: 50, kind: "model" });
    seedCommands(store, { prefix: "reset", pid: 1, count: 50, kind: "account_reset" });
    seedCommands(store, { prefix: "deliv", pid: 1, count: 10, kind: "delivery" });
    expect(terminalCommandCount(store, 500, 100)).toBe(600); // 610 live terminal rows, bounded at 600
    expect(terminalCommandCount(store, 1000, 100)).toBe(610);
  });

  it("two partitions of 400 expired rows under one cap of 500 → 300 victims over three calls", async () => {
    const store = await openStore();
    seedCommands(store, { prefix: "p1", pid: 1, count: 400 });
    seedCommands(store, { prefix: "p2", pid: 2, count: 400 });
    const victims: string[] = [];
    for (let call = 0; call < 3; call += 1) {
      const selection = commandRetentionCandidates(store, { now: NOW, retentionMs: MONTH });
      expect(selection.victims).toHaveLength(100);
      expect(selection.pages).toBe(1);
      store.transaction(() => {
        const remove = store.prepare("DELETE FROM command WHERE id = ?");
        for (const victim of selection.victims) remove.run(victim.id);
      });
      victims.push(...selection.victims.map((v) => v.id));
    }
    expect(victims).toHaveLength(300);
    expect(new Set(victims).size).toBe(300);
    expect(victims.slice(0, 2)).toEqual(["p1-000000", "p2-000000"]);
    expect(commandRetentionCandidates(store, { now: NOW, retentionMs: MONTH }).victims).toEqual([]);
  });

  it("skips needs-decision rows, retained-envelope holders, continuations of retained predecessors, and never sees live=0", async () => {
    const store = await openStore();
    seedCommands(store, {
      prefix: "cur",
      pid: 1,
      count: 640,
      needsDecision: 30,
      continuations: 20,
    });
    seedCommands(store, { prefix: "old", pid: 2, count: 1500, live: 0 });
    const envelopeHolders = new Set(["cur-000040", "cur-000041"]);
    const selection = commandRetentionCandidates(store, {
      now: NOW,
      retentionMs: MONTH,
      cap: 20,
      batch: 1000,
      exempt: (candidate) => envelopeHolders.has(candidate.id),
    });
    expect(selection.excess).toBe(620);
    // 640 − 30 needs-decision (outside the index) − 2 envelope holders − 20 continuations = 588
    expect(selection.victims).toHaveLength(588);
    expect(selection.victims[0]!.id).toBe("cur-000030");
    expect(selection.victims.some((v) => envelopeHolders.has(v.id))).toBe(false);
    expect(selection.victims.some((v) => Number(v.id.slice(4)) >= 620)).toBe(false);
    expect(selection.victims.every((v) => v.id.startsWith("cur-"))).toBe(true);
    // Nothing is eligible before the retention window; no excess means no candidates.
    expect(
      commandRetentionCandidates(store, {
        now: new Date("2026-01-02T00:00:00.000Z"),
        retentionMs: MONTH,
      }).victims,
    ).toEqual([]);
    expect(
      commandRetentionCandidates(store, { now: NOW, retentionMs: 0, cap: 640 }).victims,
    ).toEqual([]);
  });

  it("keyset paging visits exempt prefixes once (C1) and the plans stay index-bound at 1x/10x history (T-PLAN)", async () => {
    const store = await openStore();
    // 1000 exempt continuations created before 200 victims: every call reads the prefix once, never OFFSET-style.
    seedCommands(store, {
      prefix: "pre",
      pid: 1,
      count: 1001,
      continuations: 1000,
      day: "2026-01-01T00:00:00.000Z",
    });
    seedCommands(store, { prefix: "vic", pid: 1, count: 200, day: "2026-02-01T00:00:00.000Z" });
    const plans = () => ({
      count: queryPlan(store, COMMAND_TERMINAL_COUNT_SQL),
      page: queryPlan(store, COMMAND_PRUNABLE_PAGE_SQL),
      predecessor: queryPlan(store, RETAINED_PREDECESSOR_SQL),
      cursor: queryPlan(
        store,
        "SELECT seq, time, type, payload FROM event WHERE pid = ? AND seq > ? ORDER BY seq",
      ),
    });
    const oneX = plans();
    expect(oneX.count.join("\n")).toMatch(/SCAN command USING (COVERING )?INDEX command_terminal/);
    expect(oneX.page.join("\n")).toMatch(
      /SEARCH command USING INDEX command_prunable \(created_at>\?|\(\(created_at,id\)>/,
    );
    expect(oneX.page.join("\n")).not.toMatch(/TEMP B-TREE|SCAN command/);
    expect(oneX.predecessor.join("\n")).toMatch(/MULTI-INDEX OR|command_run|PRIMARY KEY/);
    expect(oneX.cursor.join("\n")).toMatch(/SEARCH event USING PRIMARY KEY \(pid=\? AND seq>\?\)/);
    const selection = commandRetentionCandidates(store, {
      now: NOW,
      retentionMs: MONTH,
      cap: 500,
      batch: 100,
    });
    // excess = 1201 − 500 = 701 → one batch of 100 victims: `pre-000000` (the
    // one non-continuation of the prefix) and 99 `vic` rows, after visiting
    // the 1000 exempt continuations exactly once (11 pages of 100), never
    // re-reading the prefix per page.
    expect(selection.victims).toHaveLength(100);
    expect(selection.victims[0]!.id).toBe("pre-000000");
    expect(selection.victims[1]!.id).toBe("vic-000000");
    expect(selection.visited).toBe(1001 + 99);
    expect(selection.pages).toBe(11);
    seedCommands(store, { prefix: "hist", pid: 9, count: 12_000, live: 0, needsDecision: 6000 });
    expect(plans()).toEqual(oneX);
    const tenX = commandRetentionCandidates(store, {
      now: NOW,
      retentionMs: MONTH,
      cap: 500,
      batch: 100,
    });
    expect(tenX.visited).toBe(selection.visited);
    expect(tenX.victims).toEqual(selection.victims);
  });
});
