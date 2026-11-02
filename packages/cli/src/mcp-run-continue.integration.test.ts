import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, DaemonServer } from "@claudexor/daemon";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { ControlRunStartInfo } from "@claudexor/schema";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { defaultClaudexorTools } from "../../mcp-server/src/index.js";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real SQL command admission + socket/HTTP transports; only the worker is synthetic. */
async function fixture(mode: "agent" | "ask" | "plan") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-mcp-continue-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
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
