import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createPartition,
  createSqlDaemonServices,
  DaemonClient,
  DaemonServer,
  EngineStore,
  setGlobalGenerationInTx,
  type RunnerFn,
} from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { defaultClaudexorTools, serveClaudexorMcp } from "@claudexor/mcp-server";
import type { RunTimeLimitRequest, RunTimeLimitSnapshot, TimeLimitMode } from "@claudexor/schema";
import { createRunTimeLimit } from "./run-time-limit.js";
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

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-rtl-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => {
    const global = createPartition(store, "global");
    setGlobalGenerationInTx(store, global.pid);
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  cleanups.push(() => graph.close());

  let starts = 0;
  const abortReasons: unknown[] = [];
  const runner: RunnerFn = async (params, ctx) => {
    starts += 1;
    const runDir = join(root, `run-${ctx.jobId}`);
    mkdirSync(runDir);
    const info = { runId: `run-${ctx.jobId}`, taskId: `task-${ctx.jobId}`, runDir };
    const limit = createRunTimeLimit(
      params as { maxSeconds?: number; timeLimitMode?: TimeLimitMode },
      ctx,
    );
    try {
      ctx.onRunStart(info);
      limit.started(info);
      await new Promise<void>((done) => {
        if (limit.signal.aborted) done();
        else limit.signal.addEventListener("abort", () => done(), { once: true });
      });
      abortReasons.push(limit.signal.reason);
      return { lifecycle: "cancelled", summary: "fixture worker stopped" };
    } finally {
      limit.dispose();
    }
  };
  const socketPath = join(root, "d.sock");
  const daemon = new DaemonServer({
    socketPath,
    token: "fixture",
    commands: graph.commands,
    runner,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient(socketPath, "fixture");
  const control = new DaemonControlApiServer({ token: "fixture", daemon: client });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const base = `http://${host}:${port}/v2/runs`;
  const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
  const request = async (method: "GET" | "PATCH", runId: string, body?: unknown) => {
    const response = await fetch(`${base}/${encodeURIComponent(runId)}/time-limit`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { root, client, request, starts: () => starts, abortReasons };
}

async function runningJob(f: Awaited<ReturnType<typeof fixture>>, params: unknown) {
  const accepted = await f.client.enqueue(params);
  const record = await vi.waitFor(
    async () => {
      const current = await f.client.status(accepted.id);
      expect(current).toMatchObject({ state: "running", runId: `run-${accepted.id}` });
      return current;
    },
    { timeout: 3_000, interval: 20 },
  );
  return { id: accepted.id, runId: record.runId!, runDir: record.runDir! };
}

async function terminalJob(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return vi.waitFor(
    async () => {
      const record = await f.client.status(id);
      expect(record.state).toBe("cancelled");
      return record;
    },
    { timeout: 3_000, interval: 20 },
  );
}

function timerMcpWire(f: Awaited<ReturnType<typeof fixture>>) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const tools = defaultClaudexorTools(async (params) => {
    if (params.mode !== "__run_time_limit") throw new Error("unexpected MCP tool");
    const { runId, request } = params as { runId: string; request: RunTimeLimitRequest };
    const response = await f.request(
      request.action === "read" ? "GET" : "PATCH",
      runId,
      request.action === "read" ? undefined : request,
    );
    if (response.status !== 200) {
      const problem = response.body as { code?: string; message?: string };
      throw Object.assign(new Error(problem.message ?? "time limit request failed"), {
        code: problem.code,
        status: response.status,
      });
    }
    return response.body;
  });
  const handle = serveClaudexorMcp({
    version: "0.0.0-test",
    tools,
    transport: { read: c2s, write: s2c },
  });
  const lines = createInterface({ input: s2c });
  const pending = new Map<number, (reply: any) => void>();
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    if (typeof reply.id === "number") pending.get(reply.id)?.(reply);
  });
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const deadline = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} did not respond`));
      }, 5_000);
      pending.set(id, (reply) => {
        clearTimeout(deadline);
        pending.delete(id);
        resolve(reply);
      });
      c2s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notifyInitialized = () =>
    c2s.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  cleanups.push(async () => {
    await handle.close();
    lines.close();
    c2s.destroy();
    s2c.destroy();
  });
  return { call, notifyInitialized };
}

describe("run time limit across SQLite, daemon socket, CLI helper, and HTTP", () => {
  it("reaches a soft deadline without restarting work, then extends, disables, and rejects stale or terminal edits", async () => {
    const f = await fixture();
    const run = await runningJob(f, { prompt: "soft timer fixture" });
    expect(f.starts()).toBe(1);
    const mcp = timerMcpWire(f);
    const initialized = await mcp.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "timer-fixture", version: "1.0" },
    });
    expect(initialized.result).toMatchObject({ protocolVersion: "2025-06-18" });
    mcp.notifyInitialized();
    const listed = await mcp.call("tools/list", {});
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "claudexor_run_time_limit",
    );
    const initial = await mcp.call("tools/call", {
      name: "claudexor_run_time_limit",
      arguments: { runId: run.runId, action: "read" },
    });
    expect(initial.result).toMatchObject({
      structuredContent: { state: "disabled", revision: 0 },
    });
    const set = await mcp.call("tools/call", {
      name: "claudexor_run_time_limit",
      arguments: { runId: run.runId, action: "set", seconds: 1, expectedRevision: 0 },
    });
    expect(set.result).toMatchObject({
      structuredContent: { state: "armed", mode: "soft", revision: 1 },
    });
    const reached = await vi.waitFor(
      async () => {
        const response = await f.request("GET", run.runId);
        expect(response).toMatchObject({ status: 200, body: { state: "reached" } });
        return response.body as RunTimeLimitSnapshot;
      },
      { timeout: 3_000, interval: 20 },
    );
    expect((await f.client.status(run.id)).state).toBe("running");
    expect(f.starts()).toBe(1);

    const extended = await f.request("PATCH", run.runId, {
      action: "extend",
      seconds: 2,
      expectedRevision: reached.revision,
    });
    expect(extended).toMatchObject({ status: 200, body: { state: "armed" } });
    const armed = extended.body as RunTimeLimitSnapshot;
    const stale = await f.request("PATCH", run.runId, {
      action: "disable",
      expectedRevision: reached.revision,
    });
    expect(stale).toMatchObject({ status: 409 });
    const disabled = await f.request("PATCH", run.runId, {
      action: "disable",
      expectedRevision: armed.revision,
    });
    expect(disabled).toMatchObject({ status: 200, body: { state: "disabled" } });
    expect(f.starts()).toBe(1);

    await f.client.cancel(run.id);
    await terminalJob(f, run.id);
    expect(
      await f.request("PATCH", run.runId, {
        action: "set",
        seconds: 1,
        expectedRevision: (disabled.body as RunTimeLimitSnapshot).revision,
      }),
    ).toMatchObject({ status: 409, body: { code: "run_terminal" } });
    const events = readFileSync(join(run.runDir, "events.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { type: string; payload: { control?: { action?: string } } },
      );
    expect(
      events
        .filter((event) => event.type === "control.applied")
        .map((event) => event.payload.control?.action),
    ).toEqual(expect.arrayContaining(["set", "reached", "extend", "disable"]));
  }, 10_000);

  it("keeps a hard limit hard when a controller resets it without naming a mode", async () => {
    const f = await fixture();
    const run = await runningJob(f, { prompt: "hard reset fixture", maxSeconds: 600 });
    const initial = await f.request("GET", run.runId);
    expect(initial).toMatchObject({ status: 200, body: { state: "armed", mode: "hard" } });
    const reset = await f.request("PATCH", run.runId, {
      action: "set",
      seconds: 1,
      expectedRevision: (initial.body as RunTimeLimitSnapshot).revision,
    });
    expect(reset).toMatchObject({ status: 200, body: { state: "armed", mode: "hard" } });
    await terminalJob(f, run.id);
    expect(f.starts()).toBe(1);
    expect(f.abortReasons).toEqual(["wall_clock_exceeded"]);
  }, 10_000);

  it("keeps a legacy one-second hard limit on the same worker until it cancels", async () => {
    const f = await fixture();
    const run = await runningJob(f, { prompt: "legacy hard fixture", maxSeconds: 1 });
    expect(f.starts()).toBe(1);
    const initial = await f.request("GET", run.runId);
    expect(initial).toMatchObject({ status: 200, body: { state: "armed", mode: "hard" } });
    await terminalJob(f, run.id);
    expect(f.starts()).toBe(1);
    expect(f.abortReasons).toEqual(["wall_clock_exceeded"]);
  }, 10_000);
});
