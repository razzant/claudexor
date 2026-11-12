import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonControlApiServer } from "@claudexor/control-api";
import {
  createSqlDaemonServices,
  EngineStore,
  RunEventBus,
  encodeJournalCursor,
} from "@claudexor/daemon";
import { ControlDaemonStatus } from "@claudexor/schema";
import { describe, expect, it, vi } from "vitest";
import { daemonStoreLine } from "./daemon-status-report.js";
import { createSqlDaemonRuntime } from "./sql-daemon-runtime.js";
import { SqlSetupLifecycleSlot } from "./sql-setup-lifecycle.js";
import { SetupLifecycleBinding } from "./setup-lifecycle-binding.js";
import { sqlControlReadSources } from "./sql-daemon-queries.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
async function fixture(options: { observe?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sql-http-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => {
    store
      .prepare(
        "INSERT INTO partition(id,name,epoch,status,next_seq,created_at) VALUES(1,'global','fixture','ready',1,?)",
      )
      .run(new Date().toISOString());
    store.prepare("INSERT INTO meta(key,value) VALUES('global_pid','1')").run();
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  cleanups.push(() => graph.close());
  const bus = new RunEventBus();
  const executed = vi.fn();
  const runtime = createSqlDaemonRuntime(graph, {
    server: { socketPath: join(root, "unused.sock"), token: "fixture" },
    authReadiness: () => ({ invalidate: () => {} }),
    bus,
    agent: (deps) => async (params, ctx) => {
      expect(deps.terminalPersistence).toBeTypeOf("function");
      executed(params);
      const runDir = join(root, `run-${ctx.jobId}`);
      mkdirSync(join(runDir, "final"), { recursive: true });
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: `task-${ctx.jobId}`, runDir });
      return { lifecycle: "succeeded", summary: "fixture complete" };
    },
  });
  cleanups.push(() => runtime.stop());
  const client = runtime.client;
  const pending = vi.fn(runtime.terminalFilesPending);
  // The daemon's composition: body-free observations and their post-commit notices.
  const reads = sqlControlReadSources(
    () => graph,
    () => store.storeId,
  );
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: client,
    bus,
    pollMs: 5,
    terminalFilesPending: pending,
    ...(options.observe
      ? {
          runObservations: reads.runObservations,
          runObservationChanges: reads.runObservationChanges,
        }
      : {}),
    services: {
      journalEvents: async (partition, request) => graph.journalEvents(partition, request),
    },
  });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
  return {
    root,
    store,
    graph,
    bus,
    client,
    pending,
    executed,
    url: `http://${host}:${port}`,
    headers,
  };
}

async function stream(
  f: Awaited<ReturnType<typeof fixture>>,
  path: string,
  extra: Record<string, string> = {},
) {
  const abort = new AbortController();
  const response = await fetch(f.url + path, {
    headers: { ...f.headers, ...extra },
    signal: abort.signal,
  });
  const state = { text: "", done: false };
  const reading = (async () => {
    try {
      for await (const bytes of response.body!) state.text += Buffer.from(bytes).toString("utf8");
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      state.done = true;
    }
  })();
  cleanups.push(async () => {
    abort.abort();
    await reading;
  });
  return { response, state };
}

describe("SQL state through real control HTTP and SSE", () => {
  it("rebinds quota and the one setup supervisor to a replaced global generation", async () => {
    const f = await fixture();
    const oldQuota = f.graph.quota;
    const slot = new SqlSetupLifecycleSlot(f.root, f.graph);
    const oldSetup = slot.current();
    const stopped = vi.fn();
    const started = vi.fn();
    const binding = new SetupLifecycleBinding(slot, (store) => ({
      async start() {
        store.validateProjection();
        started();
      },
      list: () => [],
      beginDrain: () => {},
      shutdown: async () => {
        stopped();
      },
    }));
    await binding.start();
    await binding.replaceAfter(() =>
      f.store.transaction(() => {
        f.store.prepare("UPDATE partition SET status='quarantined' WHERE id=1").run();
        f.store
          .prepare(
            "INSERT INTO partition(id,name,epoch,status,next_seq,created_at) VALUES(2,'global','new','ready',1,?)",
          )
          .run(new Date().toISOString());
        f.store.prepare("UPDATE meta SET value='2' WHERE key='global_pid'").run();
      }),
    );
    expect(f.graph.globalEvents.generation.pid).toBe(2);
    expect(f.graph.quota).not.toBe(oldQuota);
    expect(slot.current()).not.toBe(oldSetup);
    expect(() => oldSetup.list()).toThrow(
      expect.objectContaining({ code: "journal_recovery_required" }),
    );
    expect(started).toHaveBeenCalledTimes(2);
    expect(stopped).toHaveBeenCalledTimes(1);
    await binding.start();
    expect(started).toHaveBeenCalledTimes(2);
    await binding.shutdown();
  });
  it("exposes store facts without turning unmeasured integrity into success", async () => {
    const f = await fixture();
    const read = async () => {
      const response = await fetch(f.url + "/v2/daemon/status", { headers: f.headers });
      expect(response.status).toBe(200);
      return ControlDaemonStatus.parse(await response.json());
    };
    const status = await read();
    expect(status.store).toMatchObject({
      integrity: "pending",
      migration: null,
      obligations_open: 0,
    });
    expect(status.store?.flusher?.state).toBe("up");
    // The fixture's own setup committed through this store before the request.
    const before = status.store!.commit!;
    expect(before.attempts).toBeGreaterThanOrEqual(1);
    expect(before.failures).toBe(0);
    expect(before.max_ms).toBeGreaterThanOrEqual(before.last_ms!);
    for (const key of ["status-1", "status-2", "status-3"])
      f.store.transaction(
        () => void f.store.prepare("INSERT INTO meta(key,value) VALUES(?, 'x')").run(key),
      );
    const later = await read();
    const after = later.store!.commit!;
    expect(after.attempts).toBeGreaterThanOrEqual(before.attempts + 3);
    expect(after.failures).toBe(0);
    expect(after.max_ms).toBeGreaterThanOrEqual(before.max_ms!);
    expect(daemonStoreLine(later)).toContain(
      `; COMMIT since store open: ${after.attempts} call(s), 0 failed, last `,
    );
  });
  it("creates one accepted run through HTTP and replays the same SQL operation", async () => {
    const f = await fixture();
    const input = {
      mode: "ask",
      prompt: "fixture request",
      scope: { kind: "none" },
      access: "full",
    };
    const post = () =>
      fetch(f.url + "/v2/runs", {
        method: "POST",
        headers: {
          ...f.headers,
          "Content-Type": "application/json",
          "Idempotency-Key": "same-call",
        },
        body: JSON.stringify(input),
      });
    const first = await post();
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as { runId: string; jobId: string };
    expect(receipt.runId).toMatch(/^run-/);
    const again = await post();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ runId: receipt.runId, jobId: receipt.jobId });
    expect(f.executed).toHaveBeenCalledTimes(1);
    expect(f.store.prepare("SELECT count(*) AS n FROM command").get()).toEqual({ n: 1 });
  });

  it("returns stale cursor refusal before SSE headers and streams only retained revisions", async () => {
    const f = await fixture();
    const stale = await fetch(f.url + "/v2/global/events", {
      headers: { ...f.headers, "Last-Event-ID": encodeJournalCursor("global", "old", 0) },
    });
    expect(stale.status).toBe(409);
    expect(stale.headers.get("content-type")).toContain("application/problem+json");
    expect(await stale.json()).toMatchObject({ code: "journal_cursor_invalid" });
    for (const revision of [1, 2])
      f.graph.globalEvents.append("thread.head.updated", {
        thread_id: "thread",
        project_id: null,
        revision,
      });
    const s = await stream(f, "/v2/global/events");
    expect(s.response.status).toBe(200);
    await vi.waitFor(() => expect(s.state.text).toContain('"revision":2'));
    expect(s.state.text).not.toContain('"revision":1');
    const cursor = f.graph.globalEvents.cursorFor({
      partition: "global",
      epoch: "fixture",
      seq: 2,
    });
    const resumed = await stream(f, "/v2/global/events", { "Last-Event-ID": cursor });
    f.graph.globalEvents.append("thread.head.updated", {
      thread_id: "thread",
      project_id: null,
      revision: 3,
    });
    await vi.waitFor(() => expect(resumed.state.text).toContain('"revision":3'));
    expect(resumed.state.text).not.toContain('"revision":2');
  });

  it("binds a queued job's stream through its committed run start instead of polling status", async () => {
    const f = await fixture({ observe: true });
    const commands = f.graph.commands.current();
    commands.accept({
      id: "job",
      params: { mode: "agent" },
      clientId: "fixture",
      idempotencyKey: "job",
    });
    const status = vi.spyOn(f.client, "status");
    const s = await stream(f, "/v2/runs/job/events");
    expect(s.response.status).toBe(200);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).toHaveBeenCalledTimes(1);
    // The run starts: its dir and log exist before the job row names them.
    const runDir = join(f.root, "run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const created = {
      seq: 1,
      ts: new Date().toISOString(),
      run_id: "run",
      task_id: "task",
      type: "run.created" as const,
      payload: {},
    };
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(created) + "\n");
    commands.update("job", { state: "running", runId: "run", runDir, taskId: "task" });
    await vi.waitFor(() => expect(s.state.text).toContain("event: run.created"));
    expect(status).toHaveBeenCalledTimes(2);
    commands.update("job", { state: "cancelled", finishedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(s.state.done).toBe(true));
    expect(s.state.text).toContain("event: end");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("re-reads a quiet stream's lifecycle from committed SQL notices, never the hydrated command", async () => {
    const f = await fixture({ observe: true });
    const runDir = join(f.root, "run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const created = {
      seq: 1,
      ts: new Date().toISOString(),
      run_id: "run",
      task_id: "task",
      type: "run.created" as const,
      payload: {},
    };
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(created) + "\n");
    const commands = f.graph.commands.current();
    commands.accept({
      id: "job",
      params: { mode: "agent" },
      clientId: "fixture",
      idempotencyKey: "job",
    });
    commands.update("job", { state: "running", runId: "run", runDir, taskId: "task" });
    const status = vi.spyOn(f.client, "status");
    const s = await stream(f, "/v2/runs/job/events");
    expect(s.response.status).toBe(200);
    await vi.waitFor(() => expect(s.state.text).toContain("event: run.created"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.state.done).toBe(false);
    // Cancelled with no new output: the committed row's notice ends the stream.
    commands.update("job", { state: "cancelled", finishedAt: new Date().toISOString() });
    await vi.waitFor(() => expect(s.state.text).toContain("event: end"));
    await vi.waitFor(() => expect(s.state.done).toBe(true));
    expect(status).not.toHaveBeenCalled();
  });

  it("does not end a terminal file stream until the SQL obligation is materialized", async () => {
    const f = await fixture();
    const runDir = join(f.root, "run");
    mkdirSync(join(runDir, "final"), { recursive: true });
    const event = {
      seq: 1,
      ts: new Date().toISOString(),
      run_id: "run",
      task_id: "task",
      type: "run.completed" as const,
      payload: { lifecycle: "succeeded" },
    };
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n");
    const commands = f.graph.commands.current();
    commands.accept({
      id: "job",
      params: { mode: "agent" },
      clientId: "fixture",
      idempotencyKey: "job",
    });
    commands.update("job", {
      state: "succeeded",
      runId: "run",
      runDir,
      taskId: "task",
      finishedAt: event.ts,
    });
    f.store.transaction(() => f.graph.obligations.create("terminal_files", "run", 1, {}));
    const s = await stream(f, "/v2/runs/run/events");
    expect(s.response.status).toBe(200);
    await vi.waitFor(() => {
      expect(s.state.text).toContain("run.completed");
      expect(f.pending.mock.calls.length).toBeGreaterThan(1);
    });
    expect(s.state.text).not.toContain("event: end");
    expect(s.state.done).toBe(false);
    f.graph.obligations.materialize("terminal_files", "run");
    f.bus.publish(event);
    await vi.waitFor(() => expect(s.state.text).toContain("event: end"));
    await vi.waitFor(() => expect(s.state.done).toBe(true));
  });
});
