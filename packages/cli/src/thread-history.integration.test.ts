import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { sha256 } from "@claudexor/util";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadHistoryInput,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  RunFacts,
  RunEvent,
  RunTelemetry,
  SCHEMA_VERSION,
  makeOutcomeFacts,
  THREAD_HISTORY_PAGE_BYTES,
  THREAD_HISTORY_PROMPT_BYTES,
  THREAD_HISTORY_HEADER_BYTES,
  THREAD_HISTORY_FACT_BYTES,
} from "@claudexor/schema";
import { SqlThreadHistoryRead } from "@claudexor/daemon";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { applyCommandInTx, prepareCommandRow } from "../../daemon/src/store/command-rows.js";
import { sqlThreadHistoryReads } from "./sql-thread-history.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanup: (() => Promise<void>)[] = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0);
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
async function fixture(count = 0, prompt = "hello") {
  const root = mkdtempSync(join(tmpdir(), "cx-history-"));
  const f = await sqlFixture(root);
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(async () => {
    await f.close();
  });
  const thread = f.graph.threads.createThread({ title: "history" });
  const pid = f.graph.threads.generationForThread(thread.id)!.pid;
  const ids: string[] = [];
  if (count) {
    const first = f.graph.threads.createTurn(thread.id, prompt);
    ids.push(first.id);
    f.store.transaction(() => {
      const insert = f.store
        .prepare(`INSERT INTO turn(id,pid,thread_id,ordinal,run_id,created_at,prompt_sha,body)
        SELECT ?,pid,thread_id,?,NULL,created_at,prompt_sha,CAST(json_set(CAST(body AS TEXT),'$.id',?) AS BLOB) FROM turn WHERE id=?`);
      for (let i = 1; i < count; i++) {
        const id = `turn-${i}`;
        ids.push(id);
        insert.run(id, i, id, first.id);
      }
    });
  }
  const reads = sqlThreadHistoryReads(() => f.graph);
  const read = (extra: Partial<ThreadHistoryInput> = {}) =>
    reads.threadHistory(ThreadHistoryInput.parse({ threadId: thread.id, ...extra }));
  function bind(index: number, state = "running", mode = "ask") {
    const id = `run-${index}`;
    const runDir = join(root, id);
    mkdirSync(join(runDir, "final"), { recursive: true });
    const record = {
      id: `job-${index}`,
      runId: id,
      runDir,
      taskId: `task-${index}`,
      state: state as "running",
      createdAt: "2026-10-26T10:00:00Z",
      startedAt: "2026-10-26T10:00:01Z",
      params: { mode, prompt, threadId: thread.id, turnId: ids[index], harnesses: ["fake"] },
    };
    const prepared = prepareCommandRow(
      record,
      { pid, live: true, operation: mode, clientId: null },
      (bytes) => f.graph.blobs.prepareBody(bytes),
    );
    f.store.transaction(() => applyCommandInTx(f.store, prepared, "accept"));
    f.graph.threads.bindTurnRun(ids[index]!, id);
    return { id, runDir, record };
  }
  return { ...f, root, thread, pid, ids, reads, read, bind };
}

describe("bounded SQL thread history", () => {
  it.each([0, 1, 20, 21, 3000])(
    "selects indexed keys and decodes only emitted bodies (%s turns)",
    async (count) => {
      const f = await fixture(count);
      const probe = { keys: 0, bodies: 0, promptBytes: 0 };
      const reader = new SqlThreadHistoryRead(f.store, f.graph.blobs, probe);
      const query = ThreadHistoryInput.parse({ threadId: f.thread.id });
      const selected = reader.select(query, null);
      for (const key of selected.keys) reader.turn(f.thread.id, key);
      expect(probe.keys).toBe(Math.min(count, 21));
      expect(probe.bodies).toBe(Math.min(count, 20));
      const plan = f.store
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id,ordinal FROM turn INDEXED BY turn_thread WHERE thread_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 21",
        )
        .all(f.thread.id, 3000);
      expect(JSON.stringify(plan)).toContain("turn_thread");
      const fullRead = vi.spyOn(f.graph.blobs, "read");
      const page = f.read();
      expect(fullRead).not.toHaveBeenCalled();
      expect(page.turns.map((t) => t.id)).toEqual(f.ids.slice(-20));
      expect(page.hasOlder).toBe(count > 20);
      expect(page.hasNewer).toBe(false);
      expect(page.header.thread).not.toHaveProperty("runIds");
      expect(page.header.latestTurnId).toBe(f.ids.at(-1) ?? null);
      expect(page.header).toHaveProperty("latestOrdinal", count ? count - 1 : null);
    },
  );

  it("packs the session preview into the header budget and reports completeness", async () => {
    const f = await fixture(1);
    f.graph.threads.recordSession(f.thread.id, "fake", "small");
    const complete = f.read();
    expect(complete.header.sessions).toHaveLength(1);
    expect(complete.header.sessionsComplete).toBe(true);
    for (let i = 0; i < 16; i++)
      f.graph.threads.recordSession(f.thread.id, `fake-${i}`, "x".repeat(4000));
    const page = f.read();
    expect(page.turns).toHaveLength(1);
    expect(page.header.sessions.length).toBeGreaterThan(0);
    expect(page.header.sessions.length).toBeLessThan(16);
    expect(page.header.sessionsComplete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(page.header))).toBeLessThanOrEqual(
      THREAD_HISTORY_HEADER_BYTES,
    );
  });

  it("walks emitted edges in both directions with no skipped or duplicate turn", async () => {
    const f = await fixture(55);
    let page = f.read();
    const older = [...page.turns].reverse().map((t) => t.id);
    while (page.olderCursor) {
      page = f.read({ cursor: page.olderCursor });
      older.push(...[...page.turns].reverse().map((t) => t.id));
    }
    expect(older).toEqual([...f.ids].reverse());
    const newer = page.turns.map((t) => t.id);
    while (page.newerCursor) {
      page = f.read({ cursor: page.newerCursor });
      newer.push(...page.turns.map((t) => t.id));
    }
    expect(newer).toEqual(f.ids);
    expect(f.read({ beforeTurnId: f.ids[35], limit: 3 }).turns.map((t) => t.id)).toEqual(
      f.ids.slice(32, 35),
    );
    expect(f.read({ afterTurnId: f.ids[40], limit: 3 }).turns.map((t) => t.id)).toEqual(
      f.ids.slice(41, 44),
    );
    expect(f.read({ aroundTurnId: f.ids[28] }).turns.at(-1)?.id).toBe(f.ids[28]);
  });

  it("replays fixed membership across appends and refreshes an idempotent bind/refusal", async () => {
    const f = await fixture(21);
    const page = f.read();
    f.graph.threads.createTurn(f.thread.id, "appended");
    const replay = f.read({ cursor: page.replayCursor! });
    expect(replay.turns.map((t) => t.id)).toEqual(page.turns.map((t) => t.id));
    f.graph.threads.setTurnEnqueueError(f.ids[20]!, {
      message: "retry",
      retryable: true,
      code: null,
      required_actions: [],
      context: {},
    });
    expect(f.read({ cursor: page.replayCursor! }).turns.at(-1)?.enqueueError?.message).toBe(
      "retry",
    );
    f.bind(20);
    f.graph.threads.bindTurnRun(f.ids[20]!, "run-20");
    const bound = f.read({ cursor: page.replayCursor! });
    expect(bound.turns.at(-1)).toMatchObject({
      id: f.ids[20],
      ordinal: 20,
      runId: "run-20",
      enqueueError: null,
    });
    expect(bound.revision.sequence).toBeGreaterThan(replay.revision.sequence);
    expect(replay.hasNewer).toBe(false); // cursor traversal has a frozen tail
    expect(f.read({ afterTurnId: f.ids[20] }).turns).toHaveLength(1); // fresh mounted edge sees arrival
  });

  it("replays an accepted creation key without adding an arrival and refuses a changed request", async () => {
    const f = await fixture();
    const idempotency = { key: "history-turn", client: "test", request: { prompt: "same" } };
    const accepted = f.graph.threads.createTurn(f.thread.id, "same", { idempotency });
    const before = f.read();
    expect(f.graph.threads.createTurn(f.thread.id, "same", { idempotency }).id).toBe(accepted.id);
    expect(f.read().turns.map((t) => [t.id, t.ordinal])).toEqual(
      before.turns.map((t) => [t.id, t.ordinal]),
    );
    expect(() =>
      f.graph.threads.createTurn(f.thread.id, "changed", {
        idempotency: { ...idempotency, request: { prompt: "changed" } },
      }),
    ).toThrow();
  });

  it("keeps current head and latest queued admission when reading an old page", async () => {
    const f = await fixture(21);
    f.bind(20);
    const old = f.read({ beforeTurnId: f.ids[5], limit: 2 });
    expect(old.header.latestTurnId).toBe(f.ids[20]);
    expect(old.header.headRun).toMatchObject({ runId: "run-20", run: { state: "running" } });
    const queued = f.graph.threads.createTurn(f.thread.id, "next");
    f.graph.commands.current().accept({
      id: "queued-job",
      params: { mode: "ask", threadId: f.thread.id, turnId: queued.id, prompt: "next" },
      idempotencyKey: "queued-key",
      clientId: "test",
    });
    const page = f.read({ cursor: old.replayCursor!, limit: 2 });
    expect(page.header.latestAdmission).toMatchObject({
      id: queued.id,
      jobId: "queued-job",
      state: "queued",
      runId: null,
    });
    expect(page.turns.map((t) => t.id)).toEqual(old.turns.map((t) => t.id));
  });

  it("refuses a real partition epoch change and an unserved partition, then permits a fresh served read", async () => {
    const f = await fixture(21);
    const page = f.read();
    f.store.transaction(() =>
      f.store.prepare("UPDATE partition SET epoch=? WHERE id=?").run("new-history-epoch", f.pid),
    );
    expect(() => f.read({ cursor: page.olderCursor! })).toThrow(
      expect.objectContaining({ code: "thread_history_cursor_stale", status: 409 }),
    );
    expect(f.read().turns).toHaveLength(20);
    f.store.transaction(() =>
      f.store.prepare("UPDATE partition SET status='quarantined' WHERE id=?").run(f.pid),
    );
    expect(() => f.read()).toThrow(expect.objectContaining({ status: 503 }));
    f.store.transaction(() =>
      f.store.prepare("UPDATE partition SET status='ready' WHERE id=?").run(f.pid),
    );
    expect(f.read().turns).toHaveLength(20);
  });

  it("continues a replay whose answers grew without shrinking its original membership", async () => {
    const f = await fixture(20, "\u0001".repeat(32_768));
    // Before answers exist this membership spans more rows than after settlement.
    for (let i = 0; i < 20; i++) f.bind(i);
    const before = f.read();
    for (let i = 0; i < 20; i++)
      writeFileSync(join(f.root, `run-${i}`, "final/answer.md"), "\u0001".repeat(65_536));
    let replay = f.read({ cursor: before.replayCursor! });
    expect(replay.replayNextCursor).not.toBeNull();
    const seen = replay.turns.map((t) => t.id);
    do {
      expect(replay.replayCursor).toBe(before.replayCursor);
      expect(Buffer.byteLength(JSON.stringify(replay))).toBeLessThanOrEqual(
        THREAD_HISTORY_PAGE_BYTES,
      );
      if (!replay.replayNextCursor) break;
      replay = f.read({ cursor: replay.replayNextCursor });
      seen.push(...replay.turns.map((t) => t.id));
    } while (true);
    expect(seen).toEqual(before.turns.map((t) => t.id));
  });

  it("rejects a cursor before looking up its thread in a replacement store", async () => {
    const first = await fixture(21),
      replacement = await fixture(1);
    let active = first;
    const reads = sqlThreadHistoryReads(() => active.graph);
    const query = ThreadHistoryInput.parse({ threadId: first.thread.id });
    const page = reads.threadHistory(query);
    active = replacement;
    expect(() => reads.threadHistory({ ...query, cursor: page.olderCursor! })).toThrow(
      expect.objectContaining({ code: "thread_history_cursor_stale", status: 409 }),
    );
    const fresh = reads.threadHistory(
      ThreadHistoryInput.parse({ threadId: replacement.thread.id }),
    );
    expect(fresh.turns).toHaveLength(1);
    expect(fresh.revision.epoch).not.toBe(page.revision.epoch);
  });

  it("rejects wrong cursor scope, malformed selectors and unavailable/purged threads without empty success", async () => {
    const f = await fixture(21);
    const page = f.read();
    for (const field of ["storeId", "epoch", "threadId"] as const) {
      const cursor = encodeThreadHistoryCursor({
        ...decodeThreadHistoryCursor(page.olderCursor!),
        [field]: field === "storeId" ? "11111111-1111-4111-8111-111111111111" : "different",
      });
      expect(() => f.read({ cursor })).toThrow(
        expect.objectContaining({
          code: "thread_history_cursor_stale",
          status: 409,
          requiredActions: ["resnapshot"],
        }),
      );
    }
    expect(() => f.read({ cursor: page.olderCursor!, limit: 1 })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => f.read({ cursor: "bad==" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => f.read({ cursor: "x".repeat(2049) })).toThrow();
    expect(() => f.read({ beforeTurnId: "foreign" })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => f.read({ beforeTurnId: f.ids[1], afterTurnId: f.ids[2] })).toThrow();
    expect(() => f.read({ expectedStoreId: "different" })).toThrow(
      expect.objectContaining({ code: "store_mismatch" }),
    );
    f.store.transaction(() =>
      f.store.prepare("UPDATE thread SET state='purged' WHERE id=?").run(f.thread.id),
    );
    expect(() => f.read()).toThrow(expect.objectContaining({ status: 410 }));
  });

  it("bounds prompt reads before decoding and reconstructs a runless refused UTF-8 prompt", async () => {
    const prompt = '\u0001\\"😀'.repeat(20_000);
    const f = await fixture(1, prompt);
    f.graph.threads.setTurnEnqueueError(f.ids[0]!, {
      message: "refused",
      retryable: false,
      code: null,
      required_actions: [],
      context: {},
    });
    const row = f.read().turns[0]!;
    expect(row.promptInfo).toMatchObject({
      truncated: true,
      totalTextBytes: Buffer.byteLength(prompt),
    });
    expect(Buffer.byteLength(row.prompt)).toBeLessThanOrEqual(THREAD_HISTORY_PROMPT_BYTES);
    let offset = 0,
      text = "",
      sha = "";
    do {
      const part = f.reads.threadPromptPart({
        threadId: f.thread.id,
        turnId: row.id,
        offset,
        maxBytes: 4001,
      });
      expect(part.nextOffset - part.offset).toBeLessThanOrEqual(4001);
      expect(part.sha256).toMatch(/^[a-f0-9]{64}$/);
      sha = part.sha256;
      text += part.text;
      offset = part.nextOffset;
    } while (offset < row.promptInfo.totalTextBytes!);
    expect(text).toBe(prompt);
    expect(sha).toBe(sha256(prompt).slice(7));
    expect(() =>
      f.reads.threadPromptPart({ threadId: f.thread.id, turnId: row.id, offset: 4, maxBytes: 4 }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("orders revisions across pending, output publication, terminal read, and missing output", async () => {
    const f = await fixture(1);
    const run = f.bind(0, "running", "plan");
    const pending = f.read();
    expect(pending.turns[0]?.run?.outputReadyState).toBe("pending");
    expect(pending.turns[0]?.run).toHaveProperty("runDir", run.runDir);
    expect(pending.turns[0]?.run).toHaveProperty("authRoute", null);
    writeFileSync(join(run.runDir, "final/plan.md"), "answer 😀");
    const ready = f.read();
    expect(ready.turns[0]?.primaryOutput?.text).toBe("answer 😀");
    expect(ready.revision.sequence).toBeGreaterThan(pending.revision.sequence);
    const time = "2026-10-26T11:00:00Z";
    const facts = RunFacts.parse({
      schema_version: SCHEMA_VERSION,
      run_id: run.id,
      task_id: "task-0",
      mode: "plan",
      outcome: makeOutcomeFacts("succeeded"),
      deliverable: {
        present: true,
        kind: "plan",
        path: "final/plan.md",
        producer_attempt_id: "p01",
      },
      participants: {
        planners: 1,
        attempts: [
          {
            attempt_id: "p01",
            harness_id: "fake",
            role: "planner",
            deliverable_present: true,
            status: "success",
          },
        ],
      },
      gates: {
        configured: false,
        required: 0,
        total: 0,
        executed: false,
        state: "not_configured",
        receipt_attempt_id: null,
      },
      review: { state: "not_run", blocker_ids: [], blockers: 0 },
      apply: { eligibility: null, operator_decision_present: false },
      required_actions: [],
      generated_at: time,
      presentation: { state: "ready", primary: { kind: "plan", path: "final/plan.md" } },
    });
    const telemetry = RunTelemetry.parse({
      schema_version: SCHEMA_VERSION,
      run_id: run.id,
      task_id: "task-0",
      mode: "plan",
      auth_route: {
        requested: "auto",
        effective: "local_session",
        source: "native_session",
        reason: "native_first",
        harness_id: "fake",
        attempt_id: "p01",
        profile_id: "profile-a",
      },
      requested_access: "full",
      effective_access: "full",
      external_context_policy: "off",
      effective_web_mode: "off",
      web: {},
      attempts: [],
      generated_at: time,
      run_facts: facts,
    });
    f.graph.threads.persistTerminal(
      "job-0",
      RunEvent.parse({
        seq: 1,
        ts: time,
        run_id: run.id,
        task_id: "task-0",
        type: "run.completed",
        payload: {
          lifecycle: "succeeded",
          reason: facts.outcome.reason,
          facts: facts.outcome,
          run_facts: facts,
        },
      }),
      telemetry,
    );
    const terminal = f.read();
    expect(terminal.turns[0]?.run?.state).toBe("succeeded");
    expect(terminal.turns[0]?.run).toHaveProperty("authRoute.profileId", "profile-a");
    expect(terminal.revision.sequence).toBeGreaterThan(ready.revision.sequence);
    expect(terminal.turns[0]?.run?.runFacts?.run_id).toBe(run.id);
    rmSync(join(run.runDir, "final/plan.md"));
    const missing = f.read();
    expect(missing.turns[0]?.run?.outputReadyState).toBe("diagnostic");
    expect(missing.turns[0]?.primaryOutput?.text).toContain("unavailable");
    expect(missing.revision.sequence).toBeGreaterThan(terminal.revision.sequence);
    writeFileSync(
      join(run.runDir, "tombstone.yaml"),
      JSON.stringify({ run_id: run.id, reason: "retention", deleted_at: time }),
    );
    const retained = f.read();
    expect(retained.turns[0]?.primaryOutput?.path).toBe("tombstone.yaml");
    expect(retained.revision.sequence).toBeGreaterThan(missing.revision.sequence);
  });

  it("does not stamp an old projection with a revision taken after a nested newer read", async () => {
    const f = await fixture(1);
    const run = f.bind(0);
    const original = SqlThreadHistoryRead.prototype.turn;
    let newer: ReturnType<typeof f.read> | undefined;
    vi.spyOn(SqlThreadHistoryRead.prototype, "turn").mockImplementationOnce(function (
      this: SqlThreadHistoryRead,
      threadId,
      key,
    ) {
      const row = original.call(this, threadId, key);
      writeFileSync(
        join(run.runDir, "final/answer.md"),
        "published while older response is outstanding",
      );
      newer = f.read();
      return row;
    });
    const older = f.read();
    expect(older.turns[0]?.primaryOutput).toBeNull();
    expect(newer?.turns[0]?.primaryOutput?.text).toContain("published");
    expect(newer!.revision.sequence).toBeGreaterThan(older.revision.sequence);
  });

  it.each([
    "context/task.yaml",
    "final/telemetry.yaml",
    "final/failure.yaml",
    "arbitration/decision.yaml",
    "final/run_facts.yaml",
    "final/work_product.yaml",
    "final/delivery_state.yaml",
    "final/questions.json",
    "tombstone.yaml",
  ])(
    "bounds the canonical metadata read for %s without turning overflow into absence",
    async (relative) => {
      const f = await fixture(1);
      const run = f.bind(0, "running", "plan");
      const path = join(run.runDir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "x".repeat(THREAD_HISTORY_FACT_BYTES + 1));
      expect(() => f.read()).toThrow(
        expect.objectContaining({ code: "artifact_read_limit", status: 503 }),
      );
      rmSync(path);
      expect(f.read().turns).toHaveLength(1);
    },
  );

  it("bounds apply evidence while preserving canonical mutable delivery facts", async () => {
    const f = await fixture(1);
    const run = f.bind(0, "succeeded", "agent");
    writeFileSync(join(run.runDir, "final/patch.diff"), "x".repeat(1_048_577));
    expect(f.read().turns[0]?.run).toMatchObject({
      applyEligibility: null,
      applyEligibilityCoverage: "unavailable",
    });
    writeFileSync(join(run.runDir, "final/patch.diff"), "diff --git a/a b/a\n");
    expect(f.read().turns[0]?.primaryOutput).toMatchObject({ kind: "patch", text: null });
    const prior = f.read();
    writeFileSync(
      join(run.runDir, "final/delivery_state.yaml"),
      JSON.stringify({ applyState: "applied" }),
    );
    const applied = f.read();
    expect(applied.turns[0]?.run?.applyEligibility?.state).toBe("already_applied");
    expect(applied.revision.sequence).toBeGreaterThan(prior.revision.sequence);
    const decision = {
      runId: run.id,
      action: "accept_risk" as const,
      findingIds: [],
      acceptedRisks: [],
      patchSha256: sha256("different content"),
      decidedAt: "2026-10-26T11:00:00Z",
    };
    f.graph.threads.recordOperatorDecision(run.record.params, decision);
    expect(f.read().turns[0]?.run?.operatorDecision).toBeNull();
    f.graph.threads.recordOperatorDecision(run.record.params, {
      ...decision,
      patchSha256: sha256("diff --git a/a b/a\n"),
    });
    const decided = f.read();
    expect(decided.turns[0]?.run?.operatorDecision?.action).toBe("accept_risk");
    expect(decided.revision.sequence).toBeGreaterThan(applied.revision.sequence);
  });

  it("packs escaped maximum text rows within the whole-page budget, decoding only emitted rows", async () => {
    const f = await fixture(21, "\u0001".repeat(32_768));
    for (let i = 0; i < 21; i++) {
      const run = f.bind(i);
      writeFileSync(join(run.runDir, "final/answer.md"), "\u0001".repeat(65_536));
    }
    const decode = vi.spyOn(SqlThreadHistoryRead.prototype, "turn");
    let page = f.read();
    expect(page.limitedBy).toBe("bytes");
    expect(decode).toHaveBeenCalledTimes(page.turns.length);
    const seen = [...page.turns].reverse().map((t) => t.id);
    while (page.olderCursor) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        THREAD_HISTORY_PAGE_BYTES,
      );
      page = f.read({ cursor: page.olderCursor });
      seen.push(...[...page.turns].reverse().map((t) => t.id));
    }
    expect(seen).toEqual([...f.ids].reverse());
    expect(page.turns.length).toBeGreaterThan(0);
    const ascending = page.turns.map((t) => t.id);
    while (page.newerCursor) {
      page = f.read({ cursor: page.newerCursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        THREAD_HISTORY_PAGE_BYTES,
      );
      ascending.push(...page.turns.map((t) => t.id));
    }
    expect(ascending).toEqual(f.ids);
  });

  it("distinguishes unknown counts, complete counts and a bounded partial event tail", async () => {
    const f = await fixture(1);
    const run = f.bind(0);
    expect(f.read().turns[0]?.run?.toolCount).toEqual({ value: null, coverage: "unavailable" });
    const event = (kind: string, use_id: string) =>
      JSON.stringify({
        type: "harness.event",
        payload: { type: "tool_call", tool: { kind, use_id }, attempt_id: "a", harness_id: "fake" },
      }) + "\n";
    const tail = event("file", "one") + event("file", "one") + event("shell", "two");
    writeFileSync(join(run.runDir, "events.jsonl"), tail);
    const complete = f.read().turns[0]!.run!;
    expect(complete.toolCount).toEqual({ value: 2, coverage: "complete" });
    expect(complete.fileCount).toEqual({ value: 1, coverage: "complete" });
    writeFileSync(
      join(run.runDir, "events.jsonl"),
      JSON.stringify({ type: "harness.event", payload: { text: "x".repeat(300_000) } }) +
        "\n" +
        tail,
    );
    expect(f.read().turns[0]?.run?.toolCount).toEqual({ value: 2, coverage: "partial" });
  });
});
