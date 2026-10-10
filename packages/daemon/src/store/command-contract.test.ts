import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableJournal } from "./test-support/fixtures/legacy/journal/index.js";
import { RunEvent, type CommandListQuery } from "@claudexor/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobFiles, deleteUnownedInlineInTx } from "./blob-files.js";
import { SqlCommandStore } from "./commands.js";
import { applyCommandPruneInTx, SqlCommandPruner } from "./command-prune.js";
import { SqlCommandQueries, MODEL_RETAINS_RESOURCE_SQL } from "./command-queries.js";
import { SqlEventLedger } from "./event-store.js";
import { applyInteractionInTx, SqlInteractionStore } from "./interactions.js";
import { applyDecisionInTx, SqlOperatorDecisionStore } from "./operator-decisions.js";
import { Obligations } from "./obligations.js";
import { createPartition, currentGeneration } from "./partitions.js";
import { EngineStore } from "./store.js";
import { SqlTerminalFiles } from "./terminal-files.js";
import { legacyOracle } from "./test-support/legacy-oracle.js";
import {
  applyCommandInTx,
  commandRow,
  maintenanceCommandSummary,
  prepareCommandRow,
  type CommandRow,
} from "./command-rows.js";
import { readLogicalFixture } from "./test-support/fixture-loader.js";
import { bindIdempotencyInTx } from "./idempotency.js";
import { insertEventInTx, restoreEventSequenceInTx } from "./retention.js";
import { applyTerminalInTx, storedTerminal } from "./run-events.js";
import { parseDecisionMutation } from "../operator-decisions.js";
import type { JobRecord } from "../job-record.js";

const TIME = "2026-10-10T00:00:00.000Z";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-sql-command-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    now: () => new Date(TIME),
  });
  cleanup.push(() => store.close());
  const generation = store.transaction(() => createPartition(store, "global"));
  const blobs = new BlobFiles(store),
    obligations = new Obligations(store);
  const terminalFiles = new SqlTerminalFiles(store, obligations),
    pruner = new SqlCommandPruner(store, blobs);
  const commands = new SqlCommandStore(store, blobs, generation, {
    isLive: () => true,
    obligations,
    terminalFiles,
    pruner,
  });
  const queries = new SqlCommandQueries(store, blobs);
  const events = new SqlEventLedger(store, blobs, generation);
  const journal = new DurableJournal({ rootDir: join(root, "legacy"), partition: "global" });
  cleanup.push(() => journal.close());
  const legacy = new legacyOracle.daemonCommandStore.CommandStore(journal, () => new Date(TIME));
  return {
    root,
    store,
    blobs,
    obligations,
    terminalFiles,
    pruner,
    commands,
    queries,
    events,
    journal,
    legacy,
    generation,
  };
}
const request = (id: string, params: unknown = { mode: "ask", prompt: "hello" }) => ({
  id,
  params,
  idempotencyKey: `key-${id}`,
  clientId: "fixture",
});

describe("SQL command authority", () => {
  it.each(["blob", "command", "idempotency"])(
    "accept rolls back a fault in %s before exposing any authority",
    async (table) => {
      const f = await fixture();
      const generation = f.store.facts().flusher.generation;
      f.store.transaction(() =>
        f.store.exec(
          `CREATE TRIGGER accept_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'accept fault'); END`,
        ),
      );
      expect(() => f.commands.accept(request("failed"))).toThrow(/accept fault/);
      for (const name of ["blob", "command", "idempotency", "event"])
        expect(f.store.prepare(`SELECT count(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
      expect(f.store.prepare("SELECT next_seq FROM partition").get()).toEqual({ next_seq: 1 });
      expect(f.store.facts().flusher.generation).toBe(generation);
      f.store.transaction(() => f.store.exec("DROP TRIGGER accept_fault"));
      expect(f.commands.accept(request("failed")).reused).toBe(false);
      expect(f.commands.find(request("failed"))?.id).toBe("failed");
    },
  );
  it("pure import reducers reproduce the frozen logical fixture without runtime mutations", async () => {
    const f = await fixture();
    const source = readLogicalFixture(
      resolve(import.meta.dirname, "test-support/fixtures/global.json"),
    ) as ReturnType<typeof readLogicalFixture> & {
      lookups: {
        command: Parameters<typeof f.commands.find>[0];
        decision: { key: string; client: string; request: unknown };
      };
    };
    f.journal.appendBatch(source.records);
    const legacy = new legacyOracle.daemonCommandStore.CommandStore(f.journal);
    const oldInteractions = new legacyOracle.daemonInteractions.InteractionStore(f.journal);
    const oldDecisions = new legacyOracle.daemonOperatorDecisions.OperatorDecisionStore(f.journal);
    const pid = f.generation.pid;
    for (const entry of f.journal.records()) {
      const payload = entry.payload as {
        record?: JobRecord;
        keyDigest?: string;
        requestDigest?: string;
        ids?: string[];
        roots?: string[];
      };
      const prior = payload.record ? commandRow(f.store, payload.record.id, pid) : undefined;
      const record =
        payload.record && (entry.type === "command.accepted" || entry.type === "command.updated")
          ? {
              ...payload.record,
              params: Object.hasOwn(payload.record, "params")
                ? payload.record.params
                : f.commands.get(payload.record.id)!.params,
            }
          : undefined;
      const prepared = record
        ? prepareCommandRow(
            record,
            { pid, live: true, operation: "legacy", clientId: null, previous: prior },
            (bytes) => f.blobs.prepareBody(bytes),
          )
        : undefined;
      f.store.transaction(() => {
        const released: string[] = [];
        if (prepared)
          applyCommandInTx(
            f.store,
            prepared,
            entry.type === "command.accepted" ? "accept" : "update",
          );
        if (prior?.result_sha && prior.result_sha !== prepared?.row.result_sha)
          released.push(prior.result_sha);
        if (entry.type === "command.accepted")
          bindIdempotencyInTx(f.store, {
            owner: "command",
            pid,
            keyDigest: payload.keyDigest!,
            requestDigest: payload.requestDigest!,
            targetId: payload.record!.id,
            operation: "legacy",
            createdAt: payload.record!.createdAt,
          });
        if (entry.type === "command.pruned") {
          released.push(
            ...applyCommandPruneInTx(
              f.store,
              payload
                .ids!.map((id) => commandRow(f.store, id, pid))
                .filter((row): row is CommandRow => row !== undefined),
            ),
          );
          for (const root of payload.roots ?? [])
            f.store.prepare("INSERT OR IGNORE INTO pruned_root(root) VALUES(?)").run(root);
        }
        if (entry.type === "interaction.requested" || entry.type === "interaction.resolved")
          applyInteractionInTx(f.store, pid, entry.type, entry.payload);
        if (entry.type === "operator.decision_recorded")
          applyDecisionInTx(f.store, pid, parseDecisionMutation(entry.payload));
        if (entry.type === "run.event") {
          const event = RunEvent.parse(entry.payload);
          if (["run.completed", "run.failed", "run.blocked"].includes(event.type))
            applyTerminalInTx(f.store, pid, event);
        }
        released.push(...insertEventInTx(f.store, pid, entry).releasedDigests);
        for (const digest of new Set(released)) deleteUnownedInlineInTx(f.store, digest);
      });
    }
    f.store.transaction(() =>
      restoreEventSequenceInTx(f.store, pid, f.journal.currentSequence() + 1),
    );
    const imported = (
      f.store.prepare("SELECT id FROM command ORDER BY rowid").all() as Array<{ id: string }>
    ).map(({ id }) => f.commands.get(id));
    expect(imported).toEqual(legacy.records());
    expect(f.commands.find(source.lookups.command)).toEqual(legacy.find(source.lookups.command));
    expect(f.commands.prunedScopeRoots()).toEqual(legacy.prunedScopeRoots());
    const interactions = new SqlInteractionStore(f.store, f.events),
      decisions = new SqlOperatorDecisionStore(f.store, f.events);
    for (const id of ["question-closed", "question-open"])
      expect(interactions.status("run-success", id)).toBe(
        oldInteractions.status("run-success", id),
      );
    expect(interactions.pendingForRun("run-success")).toEqual(
      oldInteractions.pendingForRun("run-success"),
    );
    expect(decisions.findByIdempotency("run-success", source.lookups.decision)).toEqual(
      oldDecisions.findByIdempotency("run-success", source.lookups.decision),
    );
    expect(storedTerminal(f.store, "run-success")).toEqual(
      legacyOracle.daemonRunEventTerminalIndex
        .durableTerminalRunEvents(f.journal)
        .get("run-success"),
    );
    expect(f.store.prepare("SELECT next_seq FROM partition").get()).toEqual({
      next_seq: source.records.length + 1,
    });
    expect(f.store.prepare("SELECT DISTINCT operation,client_id FROM command").all()).toEqual([
      { operation: "legacy", client_id: null },
    ]);
  });
  it("maintenance inventory reads bounded canonical evidence by harness without body reads", async () => {
    const f = await fixture();
    const evidence = {
      lifecycle: "succeeded",
      phase: "settled",
      mechanism: "managed_npm",
      target: { kind: "version", version: "2.0.0" },
      before: { version: "1.0.0", binary: "/fixture/vendor", selection: "managed", proved: true },
      after: null,
      mutation: "applied",
      termination: "not_applicable",
      limitations: [],
      progress: ["x".repeat(100000)],
      problem: null,
    };
    for (const [id, harness] of [
      ["first", "codex"],
      ["other", "claude"],
      ["latest", "codex"],
      ["archived", "codex"],
    ]) {
      f.commands.accept(
        request(id!, {
          kind: "harness_maintenance",
          harness,
          target: { kind: "version", version: "2.0.0" },
        }),
      );
      expect(f.commands.get(id!)?.result).toBeUndefined();
      f.commands.update(id!, { state: "succeeded", finishedAt: TIME, result: evidence });
    }
    const expected = ["latest", "first"].map((id) =>
      maintenanceCommandSummary(f.commands.get(id)!),
    );
    f.store.transaction(() =>
      f.store.prepare("UPDATE command SET live=0 WHERE id='archived'").run(),
    );
    const read = vi.spyOn(f.blobs, "read"),
      prepare = vi.spyOn(f.store, "prepare");
    expect(f.queries.maintenanceForHarness("codex")).toEqual(expected);
    expect(f.queries.maintenanceForHarness("unknown")).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const query = prepare.mock.calls.find(([sql]) =>
      sql.includes("INDEXED BY command_maintenance_harness"),
    )![0];
    const plan = (
      f.store.prepare(`EXPLAIN QUERY PLAN ${query}`).all("codex") as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("command_maintenance_harness");
    expect(plan).not.toMatch(/SCAN command|TEMP B-TREE/);
    expect(Buffer.byteLength(JSON.stringify(expected[0]))).toBeLessThan(600);
    expect(f.commands.get("latest")!.result).toEqual(evidence);
    f.commands.update("latest", { result: { phase: "invalid" } });
    expect(f.queries.maintenanceForHarness("codex")[0]?.evidence).toBeNull();
  });
  it("preserves frozen digest/replay/immutable params and separates digest from body identity", async () => {
    const f = await fixture();
    const input = {
      ...request("job", { mode: "agent", prompt: "é".repeat(70_000), nested: { value: 1 } }),
      idempotencyParams: { prompt: "wire request" },
    };
    expect(f.commands.accept(input)).toEqual(f.legacy.accept(input));
    expect(f.commands.accept({ ...input, id: "ignored-on-replay" })).toEqual(
      f.legacy.accept({ ...input, id: "ignored-on-replay" }),
    );
    const update = {
      id: "cannot-rename",
      params: { mutated: true },
      state: "running" as const,
      runId: "run",
      taskId: "task",
    };
    expect(f.commands.update("job", update)).toEqual(f.legacy.update("job", update));
    expect(f.commands.get("job")).toEqual(f.legacy.get("job"));
    const raw = f.store
      .prepare(
        "SELECT c.params_sha,i.request_digest FROM command c JOIN idempotency i ON i.target_id=c.id",
      )
      .get() as { params_sha: string; request_digest: string };
    expect(raw.params_sha).toMatch(/^[a-f0-9]{64}$/);
    expect(raw.request_digest).not.toBe(raw.params_sha);
    expect(() => f.commands.find({ ...input, idempotencyParams: { prompt: "changed" } })).toThrow(
      expect.objectContaining({ code: "idempotency_conflict", status: 409 }),
    );
    expect(() => f.commands.accept({ ...input, idempotencyKey: "" })).toThrow(/1-256/);
    await f.store.close();
    const store = await EngineStore.open({
      daemonDir: join(f.root, "daemon"),
      workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
      flusherHooks: { manualTick: true },
    });
    cleanup.push(() => store.close());
    const blobs = new BlobFiles(store),
      obligations = new Obligations(store);
    const reopened = new SqlCommandStore(store, blobs, currentGeneration(store, "global")!, {
      isLive: () => true,
      obligations,
      terminalFiles: new SqlTerminalFiles(store, obligations),
      pruner: new SqlCommandPruner(store, blobs),
    });
    expect(reopened.find(input)).toEqual(f.legacy.find(input));
    reopened.prune(["job"]);
    expect(
      reopened.accept({ ...input, id: "fresh-target", idempotencyParams: { prompt: "new" } }).record
        .id,
    ).toBe("fresh-target");
  });

  it("accept/update failures leave rows, body references, bindings, sequence and generations unchanged", async () => {
    const f = await fixture();
    f.store.transaction(() =>
      f.store.exec(
        "CREATE TRIGGER fail_event BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT,'injected event failure'); END",
      ),
    );
    const before = f.store.prepare("SELECT next_seq FROM partition").get();
    expect(() => f.commands.accept(request("failed"))).toThrow(/injected event failure/);
    for (const table of ["command", "idempotency", "blob", "event"])
      expect(f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    expect(f.store.prepare("SELECT next_seq FROM partition").get()).toEqual(before);
    f.store.transaction(() => f.store.exec("DROP TRIGGER fail_event"));
    f.commands.accept(request("failed"));
    const accepted = f.commands.get("failed");
    const state = f.store.prepare("SELECT params_sha,result_sha FROM command").get();
    f.store.transaction(() =>
      f.store.exec(
        "CREATE TRIGGER fail_update BEFORE UPDATE ON command BEGIN SELECT RAISE(ABORT,'update failure'); END",
      ),
    );
    expect(() =>
      f.commands.update("failed", { state: "succeeded", result: { data: "x".repeat(100_000) } }),
    ).toThrow(/update failure/);
    expect(f.commands.get("failed")).toEqual(accepted);
    expect(f.store.prepare("SELECT params_sha,result_sha FROM command").get()).toEqual(state);
  });

  it("matches every frozen addressed selector and public projection without collection body reads", async () => {
    const f = await fixture();
    const seeds = [
      ["one", { mode: "agent", prompt: "x".repeat(100_000) }],
      ["retry", { mode: "agent", continueFrom: "run-one", prompt: "retry" }],
      ["thread-a", { mode: "agent", threadId: "thread", turnId: "turn", prompt: "thread prompt" }],
      [
        "thread-b",
        { mode: "ask", threadId: "thread", turnId: "turn", prompt: "later turn command" },
      ],
      ["child", { mode: "agent", delegatedFromRunId: "run-thread-a", prompt: "child" }],
      ["grandchild", { mode: "ask", delegatedFromRunId: "run-child", prompt: "grandchild" }],
    ] as const;
    for (const [id, params] of seeds) {
      f.commands.accept(request(id, params));
      f.legacy.accept(request(id, params));
      const patch = {
        runId: `run-${id}`,
        taskId: `task-${id}`,
        state: id === "one" ? ("succeeded" as const) : ("running" as const),
      };
      f.commands.update(id, patch);
      f.legacy.update(id, patch);
    }
    const selectors: CommandListQuery[] = [
      { id: "run-one" },
      { turnId: "turn" },
      { ids: ["one", "run-child"] },
      { threadId: "thread" },
      { threadId: "thread", activeOnly: true },
      { threadIds: ["thread"] },
      { delegatedFromRunId: "run-thread-a" },
      { delegatedDescendantsOf: "run-thread-a" },
      { continuationChainOf: "run-one" },
      { activeOnly: true },
      { page: { limit: 2, state: null, cursor: null } },
      { page: { limit: 2, state: "running", cursor: { createdAt: TIME, id: "thread-a" } } },
    ];
    const reads = vi.spyOn(f.blobs, "read");
    for (const selector of selectors) {
      reads.mockClear();
      const expected = legacyOracle.daemonCommandListSelect.selectCommandRecords(
        f.legacy.records(),
        selector,
      );
      expect(
        f.queries.select(selector).map((record) => record.id),
        JSON.stringify(selector),
      ).toEqual(expected.map((record) => record.id));
      expect(wire(f.queries.publicList(selector))).toEqual(
        wire(
          legacyOracle.daemonCommandListProjection.publicCommandList(f.legacy.records(), selector),
        ),
      );
      if (!("id" in selector) && !("turnId" in selector)) expect(reads).not.toHaveBeenCalled();
    }
    expect(f.queries.getByRunId("run-one")?.params).toEqual(seeds[0][1]);
    expect(() => f.queries.select({} as CommandListQuery)).toThrow(
      expect.objectContaining({ code: "invalid_command_list_query" }),
    );
    // Newer archived generations must neither expand work nor appear in pages.
    f.store.transaction(() => {
      const insert = f.store.prepare(
        "INSERT INTO command(id,pid,operation,state,created_at,summary,params_sha,kind,live) SELECT ?,9,operation,state,'2099-01-01',summary,params_sha,kind,0 FROM command WHERE id='one'",
      );
      for (let i = 0; i < 10000; i++) insert.run(`old-${i}`);
    });
    reads.mockClear();
    expect(f.queries.publicList({ page: { limit: 2, state: null, cursor: null } })).toHaveLength(3);
    expect(reads).not.toHaveBeenCalled();
    expect(f.queries.count()).toBe(10006);
    const pagePlan = f.store
      .prepare(
        "EXPLAIN QUERY PLAN SELECT summary FROM command WHERE live=1 AND kind='product' ORDER BY created_at DESC,id DESC LIMIT 3",
      )
      .all() as Array<{ detail: string }>;
    expect(pagePlan.map((row) => row.detail).join("\n")).toContain("command_list");
    expect(f.queries.active()).toHaveLength(5);
  });

  it("distinguishes retained model bytes, terminal receipts, and the next response expiry by indexed metadata", async () => {
    const f = await fixture();
    f.commands.accept(request("model", { kind: "model", request: { resourceId: "request" } }));
    f.commands.update("model", {
      result: {
        response: {
          state: "ready",
          ref: { resourceId: "response" },
          expiresAt: "2026-11-10T00:00:00.000Z",
        },
      },
    });
    expect(f.queries.retainsResourceBytes("request", TIME)).toBe(true);
    expect(f.queries.retainsResourceBytes("response", TIME)).toBe(true);
    expect(f.queries.hasTerminalResourceReceipt("response")).toBe(false);
    f.commands.update("model", { state: "succeeded", finishedAt: TIME });
    expect(f.queries.retainsResourceBytes("request", TIME)).toBe(false);
    expect(f.queries.hasTerminalResourceReceipt("request")).toBe(true);
    expect(f.queries.nextResponseExpiry()).toBe("2026-11-10T00:00:00.000Z");
    expect(f.queries.expiredResponses("2027-01-01T00:00:00.000Z")).toEqual(["model"]);
    expect(f.queries.retainsResourceBytes("response", "2027-01-01T00:00:00.000Z")).toBe(false);
    const plan = (
      f.store.prepare(`EXPLAIN QUERY PLAN ${MODEL_RETAINS_RESOURCE_SQL}`).all() as Array<{
        detail: string;
      }>
    )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("command_request_resource");
    expect(plan).toContain("command_response_resource");
    f.store.transaction(() => f.store.prepare("UPDATE command SET live=0 WHERE id='model'").run());
    expect(f.queries.hasTerminalResourceReceipt("request")).toBe(false);
    expect(f.queries.nextResponseExpiry()).toBeNull();
  });
});

describe("SQL interaction and decision authority", () => {
  it("keeps run+interaction identity and resolved state through reopen while the stream pair retires", async () => {
    const f = await fixture(),
      interactions = new SqlInteractionStore(f.store, f.events);
    const legacy = new legacyOracle.daemonInteractions.InteractionStore(f.journal);
    const ctx = {
      runId: "run-one",
      taskId: "task",
      attemptId: "a01",
      harnessId: "codex",
      requestedAt: TIME,
      timeoutAt: null,
      request: { interaction_id: "question", source_tool: "AskUserQuestion", questions: [] },
    };
    expect(interactions.request(ctx)).toEqual(legacy.request(ctx));
    interactions.request({ ...ctx, runId: "run-two" });
    expect(interactions.resolve("run-one", "question", "answered")).toBe("resolved");
    expect(interactions.resolve("run-one", "question", "answered")).toBe("already_resolved");
    expect(interactions.status("run-two", "question")).toBe("pending");
    const reopened = new SqlInteractionStore(f.store, f.events);
    expect(reopened.status("run-one", "question")).toBe("resolved");
    reopened.recoverAfterStartup();
    expect(reopened.status("run-two", "question")).toBe("resolved");
    expect(f.events.records(0, ["interaction.requested", "interaction.resolved"])).toEqual([]);
  });

  it("atomically keeps latest operator decision and original bindings, matching frozen replay", async () => {
    const f = await fixture(),
      decisions = new SqlOperatorDecisionStore(f.store, f.events);
    const legacy = new legacyOracle.daemonOperatorDecisions.OperatorDecisionStore(f.journal);
    const first = {
      runId: "run",
      action: "accept_risk" as const,
      findingIds: ["f"],
      acceptedRisks: ["r"],
      patchSha256: `sha256:${"a".repeat(64)}`,
      decidedAt: TIME,
    };
    const a = { key: "a", client: "fixture", request: { action: "accept_risk" } };
    expect(decisions.record(first, a)).toEqual(legacy.record(first, a));
    const second = { ...first, action: "override_needs_human" as const };
    const b = { key: "b", client: "fixture", request: { action: "override_needs_human" } };
    expect(decisions.record(second, b)).toEqual(legacy.record(second, b));
    expect(decisions.findByIdempotency("run", a)).toEqual(legacy.findByIdempotency("run", a));
    expect(() => decisions.findByIdempotency("run", { ...a, request: { changed: true } })).toThrow(
      /different request/,
    );
    f.store.transaction(() =>
      f.store.exec(
        "CREATE TRIGGER fail_decision_event BEFORE INSERT ON event WHEN NEW.type='operator.decision_recorded' BEGIN SELECT RAISE(ABORT,'decision event failed'); END",
      ),
    );
    expect(() =>
      decisions.record(
        { ...first, acceptedRisks: ["never"] },
        { key: "c", client: "fixture", request: { new: true } },
      ),
    ).toThrow(/decision event failed/);
    expect(decisions.get("run")).toEqual(second);
    expect(
      f.store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='decision'").get(),
    ).toEqual({ n: 2 });
  });
});
