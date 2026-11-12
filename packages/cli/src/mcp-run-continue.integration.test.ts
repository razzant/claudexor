import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonServer } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { CapturedRunStart, ControlRunStartInfo, ResolvedConfig } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { defaultClaudexorTools, serveClaudexorMcp } from "../../mcp-server/src/index.js";
import { resolveRunInputDefaults } from "../../orchestrator/src/run-input-resolution.js";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import { oneShotRunInput } from "./one-shot-run-input.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

/** Real SQL command admission + socket/HTTP transports; only the worker is synthetic. */
async function fixture(mode: "agent" | "ask" | "plan", predecessor: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-mcp-continue-")));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  const sql = await sqlFixture(root);
  cleanups.push(() => sql.close());
  const project = join(root, "project");
  mkdirSync(project);
  sql.graph.projects.register({ root: project, idempotencyKey: "project", clientId: "fixture" });
  const params = {
    mode,
    prompt: "original work order",
    scope: { kind: "project", root: project },
    execution:
      mode === "agent"
        ? { isolation: "live", delegated: true, workspaceRoot: project }
        : { isolation: "envelope" },
    harnesses: ["fixture-harness"],
    primaryHarness: "fixture-harness",
    models: { "fixture-harness": "fixture-model" },
    ...predecessor,
  };
  const commands = sql.graph.commands.forRequest(params);
  commands.accept({ id: "job-p", params, idempotencyKey: "predecessor", clientId: "fixture" });
  const runDir = join(root, "predecessor");
  mkdirSync(runDir);
  commands.update("job-p", { state: "failed", runId: "run-p", taskId: "task-p", runDir });

  const observed: unknown[] = [];
  const daemon = new DaemonServer({
    socketPath: join(root, "d.sock"),
    token: "fixture",
    commands: sql.graph.commands,
    runner: async (request, ctx) => {
      observed.push(request);
      const runDir = join(root, ctx.jobId);
      mkdirSync(runDir);
      ctx.onRunStart({ runId: `run-${ctx.jobId}`, taskId: `task-${ctx.jobId}`, runDir });
      await new Promise<void>((done) => {
        if (ctx.signal.aborted) done();
        else ctx.signal.addEventListener("abort", () => done(), { once: true });
      });
      return { lifecycle: "cancelled" };
    },
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const client = new DaemonClient(join(root, "d.sock"), "fixture");
  const control = new DaemonControlApiServer({
    token: "fixture",
    daemon: client,
    pollMs: 5,
    storeId: () => sql.store.storeId,
  });
  const { host, port } = await control.start();
  cleanups.push(() => control.stop());
  vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
    client,
    addr: { baseUrl: `http://${host}:${port}`, token: "fixture" },
    engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
  });
  const ensure = vi.spyOn(daemonRun, "ensureDaemon");
  const runner = mcpSurfaceRunner();
  const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_continue")!;
  return { tool, runner, observed, params, client, ensure, commands, storeId: sql.store.storeId };
}

describe("MCP continuation through daemon-owned admission", () => {
  it.each(["agent", "ask"] as const)(
    "inherits omitted %s execution, project and route; replays one successor",
    async (mode) => {
      const f = await fixture(mode);
      const args = { runId: "run-p", prompt: "", idempotencyKey: "successor" };
      const accepted = await f.tool.handler(args, {});
      expect(accepted, JSON.stringify(accepted)).not.toHaveProperty("isError", true);
      const handle = ControlRunStartInfo.parse(
        typeof accepted === "string" ? null : accepted.structured,
      );
      expect(handle.jobId).toBeTruthy();
      expect(handle.runId).toBeTruthy();
      // The bound successor's final result names the store that accepted it.
      expect(f.storeId).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      expect(handle.storeId).toBe(f.storeId);
      expect(handle).not.toHaveProperty("taskGroupId");
      // The worker is still running when the MCP call returns.
      expect(await f.client.status(handle.jobId!)).toMatchObject({ state: "running" });
      expect(f.observed).toHaveLength(1);
      expect(f.observed[0]).toMatchObject({
        ...f.params,
        prompt: "",
        continueFrom: "run-p",
        continueModelInherited: true,
      });
      const replay = await f.tool.handler(args, {});
      expect(replay).toMatchObject({
        structured: { jobId: handle.jobId, runId: handle.runId, storeId: f.storeId },
      });
      expect(f.observed).toHaveLength(1);
      expect(
        await f.tool.handler({ ...args, idempotencyKey: "other-successor" }, {}),
      ).toMatchObject({
        isError: true,
        structured: {
          failure: {
            code: "continuation_superseded",
            retryable: false,
            context: { runId: "run-p", head: handle.runId },
          },
        },
      });
      for (const mode of ["__run_status", "__run_result"]) {
        expect(await f.runner({ mode, runId: handle.jobId })).toMatchObject({
          runId: handle.runId,
          status: "running",
        });
      }
      expect(f.ensure).not.toHaveBeenCalled();
    },
  );

  it("keeps unsupported and unknown predecessor refusals typed", async () => {
    const f = await fixture("plan");
    expect(await f.tool.handler({ runId: "run-p" }, {})).toMatchObject({
      isError: true,
      structured: { failure: { code: "continue_from_unsupported" } },
    });
    expect(await f.tool.handler({ runId: "run-elsewhere" }, {})).toMatchObject({
      isError: true,
      structured: { failure: { code: "predecessor_unknown" } },
    });
    expect(f.observed).toHaveLength(0);
  });
});

/** A host's JSON-RPC wire into the real SDK server, over the fixture's runner. */
function mcpWire(runner: ReturnType<typeof mcpSurfaceRunner>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = serveClaudexorMcp({
    version: "0.0.0-test",
    tools: defaultClaudexorTools(runner),
    transport: { read: input, write: output },
  });
  const lines = createInterface({ input: output });
  const replies = new Map<number, any>();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    replies.set(message.id, message);
  });
  cleanups.push(async () => {
    await server.close();
    lines.close();
    input.destroy();
    output.destroy();
  });
  let id = 0;
  return async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id;
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params: { ...params, _meta: meta },
      }) + "\n",
    );
    await vi.waitFor(() => expect(replies.has(requestId)).toBe(true), { timeout: 10_000 });
    return replies.get(requestId);
  };
}

describe("successor effort through the MCP wire and daemon admission (#604)", () => {
  // Settings defaults stand for each lane's ordinary new-run effort.
  const settings = ResolvedConfig.parse({
    project: {},
    trust: {},
    global: {
      routing: { eligible_harnesses: [], primary_harness: null },
      harnesses: {
        "fixture-harness": { effort: "medium" },
        "other-harness": { effort: "medium" },
      },
    },
  });
  /** The worker's own admission step on the accepted request: its per-lane efforts. */
  const laneEfforts = (accepted: unknown) =>
    resolveRunInputDefaults(oneShotRunInput(CapturedRunStart.parse(accepted)), {
      config: settings,
      registryIds: ["fixture-harness", "other-harness"],
    }).efforts;
  // The predecessor ran with its own effort, which a successor never inherits.
  const multiHarnessAsk = {
    harnesses: ["fixture-harness", "other-harness"],
    effort: "low",
    efforts: { "other-harness": "low" },
  };

  it.each([
    ["omitted", {}, { "fixture-harness": "medium", "other-harness": "medium" }],
    ["a scalar", { effort: "max" }, { "fixture-harness": "max", "other-harness": "max" }],
    [
      "a harness-keyed map",
      { efforts: { "other-harness": "high" } },
      { "fixture-harness": "medium", "other-harness": "high" },
    ],
    [
      "a scalar and a map",
      { effort: "max", efforts: { "other-harness": "high" } },
      { "fixture-harness": "max", "other-harness": "high" },
    ],
  ] as const)(
    "accepts %s successor effort exactly as stated and resolves efforts[h] > effort > Settings",
    async (_name, stated, lanes) => {
      const f = await fixture("ask", multiHarnessAsk);
      const call = mcpWire(f.runner);
      expect((await call("server/discover", {})).error).toBeUndefined();
      const listed = await call("tools/list", {});
      const schema = (listed.result?.tools as Array<{ name: string; inputSchema: any }>).find(
        (tool) => tool.name === "claudexor_run_continue",
      )!.inputSchema;
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["effort", "efforts"]));
      const reply = await call("tools/call", {
        name: "claudexor_run_continue",
        arguments: { runId: "run-p", prompt: "", idempotencyKey: "successor", ...stated },
      });
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError, JSON.stringify(reply.result)).not.toBe(true);
      expect(f.observed).toHaveLength(1);
      const accepted = f.observed[0] as Record<string, unknown>;
      // The inherited pool arrives with the stated controls only.
      expect(accepted).toMatchObject({
        continueFrom: "run-p",
        harnesses: multiHarnessAsk.harnesses,
        primaryHarness: "fixture-harness",
        ...stated,
      });
      for (const key of ["effort", "efforts"] as const)
        if (!(key in stated)) expect(accepted, key).not.toHaveProperty(key);
      expect(laneEfforts(accepted)).toEqual(lanes);
    },
  );

  it("leaves foreign harness keys to the engine's registry refusal and refuses invalid values before admission", async () => {
    const f = await fixture("ask", multiHarnessAsk);
    const call = mcpWire(f.runner);
    expect((await call("server/discover", {})).error).toBeUndefined();
    for (const invalid of [{ effort: "MAX" }, { efforts: { "other-harness": "" } }]) {
      const reply = await call("tools/call", {
        name: "claudexor_run_continue",
        arguments: { runId: "run-p", ...invalid },
      });
      expect(Boolean(reply.error) || reply.result?.isError === true, JSON.stringify(invalid)).toBe(
        true,
      );
    }
    expect(f.observed).toHaveLength(0);
    const foreign = await call("tools/call", {
      name: "claudexor_run_continue",
      arguments: {
        runId: "run-p",
        idempotencyKey: "foreign",
        efforts: { "no-such-harness": "max" },
      },
    });
    expect(foreign.result?.isError, JSON.stringify(foreign.result)).not.toBe(true);
    expect(f.observed).toHaveLength(1);
    expect(f.observed[0]).toMatchObject({ efforts: { "no-such-harness": "max" } });
    expect(() => laneEfforts(f.observed[0])).toThrow(
      "efforts map names unknown harness 'no-such-harness'",
    );
  });
});
