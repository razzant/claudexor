/**
 * The interaction answer path shared by the native-approval and Claude question
 * integration tests: the real SQL engine store and services graph, a
 * DaemonServer whose runner opens each run's directory, its run-owned clock and
 * the orchestrator's interaction channel bound to the daemon's durable
 * registry, the real Control API over HTTP, and the real MCP tool surface
 * pointed at it. The calling test supplies only the harness run.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { expect, vi } from "vitest";
import type { InteractionChannel } from "@claudexor/core";
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
import type { HarnessEvent } from "@claudexor/schema";
// The built module: the orchestrator channel types its log against @claudexor/event-log.
import { EventLog } from "../../../event-log/dist/index.js";
import { interactionChannelFor } from "../../../orchestrator/src/interaction.js";
import * as daemonRun from "../daemon-run.js";
import { mcpSurfaceRunner } from "../mcp-runner.js";
import { createRunTimeLimit } from "../run-time-limit.js";

type Cleanups = Array<() => void | Promise<void>>;

/** One fixture run: its directory, the run's abort signal and the
 * orchestrator's interaction channel for the fixture's harness. */
interface FixtureRun {
  params: Record<string, unknown>;
  runId: string;
  runDir: string;
  signal: AbortSignal;
  channel: InteractionChannel;
}

export async function startInteractionDaemon(options: {
  cleanups: Cleanups;
  harnessId: string;
  /** Prompt every started run carries. */
  prompt: string;
  /** Runs the harness for one run and returns the events that decide its lifecycle. */
  execute: (run: FixtureRun, workspace: string) => Promise<HarnessEvent[]>;
  /** Bound of every wait helper. */
  waitMs?: number;
}) {
  const { cleanups } = options;
  const waitMs = options.waitMs ?? 5_000;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-interaction-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => store.close());
  store.transaction(() => {
    const global = createPartition(store, "global");
    setGlobalGenerationInTx(store, global.pid);
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  cleanups.push(() => graph.close());
  const abortReasons: unknown[] = [];
  const runner: RunnerFn = async (params, ctx) => {
    const p = params as Record<string, unknown> & { interactionTimeoutMs?: number | null };
    const runId = `run-${ctx.jobId}`;
    const taskId = `task-${ctx.jobId}`;
    const runDir = join(root, runId);
    mkdirSync(runDir);
    // The production run-owned clock: one stable signal for the whole run.
    const limit = createRunTimeLimit(params as { maxSeconds?: number }, ctx);
    ctx.onRunStart({ runId, taskId, runDir });
    limit.started({ runId, taskId, runDir });
    // The orchestrator's own channel, bound to the daemon's durable registry.
    const channel = interactionChannelFor(
      {
        onInteraction: (pending) => graph.interactions.register(pending, params),
        interactionTimeoutMs: p.interactionTimeoutMs ?? null,
        signal: limit.signal,
      },
      new EventLog(join(runDir, "events.jsonl"), runId, taskId),
      runId,
      taskId,
      "a01",
      options.harnessId,
      true,
    )!;
    let events: HarnessEvent[] = [];
    try {
      events = await options.execute(
        { params: p, runId, runDir, signal: limit.signal, channel },
        workspace,
      );
    } finally {
      if (limit.signal.aborted) abortReasons.push(limit.signal.reason);
      limit.dispose();
    }
    // Fixture-only lifecycle reduction; the orchestrator owns real outcome facts.
    const aborted = limit.signal.aborted || events.at(-1)?.aborted === true;
    const failed = events.some((event) => event.type === "error");
    return {
      lifecycle: aborted ? "cancelled" : failed ? "failed" : "succeeded",
      summary: "interaction fixture",
    };
  };
  // The daemon's own endpoint convention: a named pipe on Windows, where Node
  // IPC has no socket file, and a Unix socket inside the fixture root elsewhere.
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\claudexor-interaction-test-${randomUUID()}`
      : join(root, "d.sock");
  const daemon = new DaemonServer({
    socketPath,
    token: "fixture",
    commands: graph.commands,
    runner,
    onRunTerminal: (runId) => graph.interactions.dropForRun(runId),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient(socketPath, "fixture");
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: client,
    services: {
      pendingInteractions: (runId) => graph.interactions.pendingForRun(runId),
      answerInteraction: (runId, interactionId, answers) =>
        graph.interactions.answer(runId, interactionId, answers),
    },
  } as ConstructorParameters<typeof DaemonControlApiServer>[0]);
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  const baseUrl = `http://${host}:${port}`;
  const headers = { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" };
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}/v2${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  // The real MCP surface runner, pointed at this daemon's control API.
  vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
    client: client as never,
    addr: { baseUrl, token: "fixture" },
    engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" } as never,
  });
  const started = async (params: Record<string, unknown> = {}) => {
    const accepted = await client.enqueue({ prompt: options.prompt, ...params });
    const record = await vi.waitFor(
      async () => {
        const current = await client.status(accepted.id);
        expect(current).toMatchObject({ state: "running", runId: `run-${accepted.id}` });
        return current;
      },
      { timeout: waitMs, interval: 10 },
    );
    return { id: accepted.id, runId: record.runId!, runDir: record.runDir! };
  };
  const terminal = (id: string) =>
    vi.waitFor(
      async () => {
        const record = await client.status(id);
        expect(["succeeded", "failed", "cancelled"]).toContain(record.state);
        return record;
      },
      { timeout: waitMs, interval: 10 },
    );
  const pending = (runId: string, count: number) =>
    vi.waitFor(
      async () => {
        const detail = await http("GET", `/runs/${encodeURIComponent(runId)}`);
        expect(detail.status).toBe(200);
        expect(detail.body.pendingInteractions).toHaveLength(count);
        return detail.body.pendingInteractions as Array<Record<string, any>>;
      },
      { timeout: waitMs, interval: 10 },
    );
  return { workspace, baseUrl, http, started, terminal, pending, abortReasons };
}

/** The real Claudexor MCP server over an in-memory JSON-RPC wire. */
export function mcpWire(cleanups: Cleanups) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const handle = serveClaudexorMcp({
    version: "0.0.0-test",
    tools: defaultClaudexorTools(mcpSurfaceRunner()),
    transport: { read: c2s, write: s2c },
  });
  const lines = createInterface({ input: s2c });
  const replies = new Map<number, (reply: any) => void>();
  lines.on("line", (line) => {
    const reply = JSON.parse(line);
    if (typeof reply.id === "number") replies.get(reply.id)?.(reply);
  });
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<any> =>
    new Promise((done) => {
      const id = ++nextId;
      replies.set(id, done);
      c2s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  cleanups.push(async () => {
    await handle.close();
    lines.close();
    c2s.destroy();
    s2c.destroy();
  });
  return {
    async start() {
      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "interaction-fixture", version: "1.0" },
      });
      c2s.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    tool: (name: string, args: Record<string, unknown>) =>
      call("tools/call", { name, arguments: args }),
  };
}
