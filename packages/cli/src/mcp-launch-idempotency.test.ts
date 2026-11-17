import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRunStartRequest } from "@claudexor/control-api";
import { ControlRunStartRequest, runStartStrategyViolations } from "@claudexor/schema";
import * as daemonRun from "./daemon-run.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

afterEach(() => vi.restoreAllMocks());

describe("one-shot MCP launch idempotency transport", () => {
  it.each([
    { mode: "ask" },
    { mode: "agent" },
    { mode: "plan" },
    { mode: "agent", race: true },
    { mode: "agent", create: true },
  ])("passes the caller key separately from the strict run body: %j", async (strategy) => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-key",
      jobId: "job-key",
      runDir: "",
      status: "running",
    });
    const result = await mcpSurfaceRunner()({
      ...strategy,
      prompt: "inspect",
      repoPath: "/fixture",
      deferred: true,
      idempotencyKey: "caller-key",
      parentRunId: "forged",
      delegatedFromRunId: "forged",
      internalDaemonEnqueue: true,
    });
    const [, , body, options] = enqueue.mock.calls[0]!;
    expect(options).toMatchObject({
      waitForTerminal: false,
      acceptUnbound: true,
      idempotencyKey: "caller-key",
    });
    expect(result).toMatchObject({ jobId: "job-key", runId: "run-key" });
    expect(body).toMatchObject({ scope: { kind: "project", root: "/fixture" } });
    expect(options).not.toHaveProperty("internalDaemonEnqueue");
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(ControlRunStartRequest.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("parentRunId");
    expect(body).not.toHaveProperty("delegatedFromRunId");
  });

  it("refuses a keyed launch without an explicit project before any daemon contact", async () => {
    const ensure = vi.spyOn(daemonRun, "ensureDaemon");
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait");
    for (const repoPath of [undefined, "", "  "]) {
      await expect(
        mcpSurfaceRunner()({
          mode: "agent",
          prompt: "inspect",
          deferred: true,
          idempotencyKey: "caller-key",
          ...(repoPath === undefined ? {} : { repoPath }),
        }),
      ).rejects.toMatchObject({ code: "idempotency_repo_path_required", retryable: false });
    }
    expect(ensure).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns a still-queued accepted job as a handle with its job id", async () => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "",
      jobId: "job-queued",
      runDir: "",
      status: "queued",
    });
    const result = await mcpSurfaceRunner()({
      mode: "ask",
      prompt: "inspect",
      repoPath: "/fixture",
      deferred: true,
      idempotencyKey: "caller-key",
    });
    expect(result).toMatchObject({ jobId: "job-queued", runId: "", status: "queued" });
    expect((result as { summary: string }).summary).toContain("runId job-queued");
  });

  it("passes a bound belt's caller key to the explicit internal-path refusal", async () => {
    const client = { enqueue: vi.fn() };
    vi.spyOn(daemonRun, "connectDaemonIfRunning").mockResolvedValue({
      client: client as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    await expect(
      mcpSurfaceRunner({
        requireExistingDaemon: true,
        delegationParentRunId: "parent",
        delegationRepoRoot: "/bound",
      })({ mode: "ask", prompt: "inspect", idempotencyKey: "caller-key" }),
    ).rejects.toMatchObject({ code: "delegation_idempotency_unsupported", retryable: false });
    expect(client.enqueue).not.toHaveBeenCalled();
  });

  it("maps an explicit no-project Ask to scope none with its replay key, never to the server cwd", async () => {
    const ensure = vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run-none",
      jobId: "job-none",
      runDir: "",
      status: "running",
    });
    const launch = {
      mode: "ask",
      prompt: "Explain this inline snippet.",
      noProject: true,
      deferred: true,
      idempotencyKey: "projectless-key",
      execution: { isolation: "envelope", delegated: false },
    };
    const result = await mcpSurfaceRunner()(launch);
    expect(ensure).toHaveBeenCalledOnce();
    const [, , body, options] = enqueue.mock.calls[0]!;
    expect(body).toMatchObject({ mode: "ask", scope: { kind: "none" } });
    expect(JSON.stringify(body)).not.toContain(process.cwd());
    expect(body).not.toHaveProperty("noProject");
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(ControlRunStartRequest.safeParse(body).success).toBe(true);
    expect(options).toMatchObject({ idempotencyKey: "projectless-key", acceptUnbound: true });
    expect(result).toMatchObject({ jobId: "job-none", runId: "run-none" });
    // A restarted MCP server in another directory sends the identical request.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/elsewhere");
    await mcpSurfaceRunner()(launch);
    cwd.mockRestore();
    expect(enqueue.mock.calls[1]![2]).toEqual(body);
    expect(enqueue.mock.calls[1]![3]).toEqual(options);
  });

  it("keeps the generated-key path for an unkeyed no-project Ask and forwards deepScan unchanged", async () => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run",
      jobId: "job",
      runDir: "",
      status: "running",
    });
    const runner = mcpSurfaceRunner();
    await runner({ mode: "ask", prompt: "Explain.", noProject: true, deferred: true });
    await runner({
      mode: "ask",
      prompt: "Survey.",
      noProject: true,
      deepScan: true,
      deferred: true,
    });
    const [plain, scan] = enqueue.mock.calls;
    expect(plain![2]).toMatchObject({ mode: "ask", scope: { kind: "none" } });
    expect(plain![2]).not.toHaveProperty("deepScan");
    expect(scan![2]).toMatchObject({ mode: "ask", scope: { kind: "none" }, deepScan: true });
    for (const [, , body, options] of [plain!, scan!]) {
      // No caller key: enqueueAndAwait keeps generating its own per invocation.
      expect(options).not.toHaveProperty("idempotencyKey");
      expect(options).toMatchObject({ waitForTerminal: false, acceptUnbound: true });
      // The engine's strategy owner admits both shapes; no new refusal applies.
      expect(runStartStrategyViolations(ControlRunStartRequest.parse(body))).toEqual([]);
    }
  });

  it("keeps the project scope for omitted or false noProject", async () => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run",
      jobId: "job",
      runDir: "",
      status: "running",
    });
    const runner = mcpSurfaceRunner();
    await runner({ mode: "ask", prompt: "inspect", deferred: true });
    await runner({ mode: "ask", prompt: "inspect", noProject: false, repoPath: "/fixture" });
    await runner({
      mode: "ask",
      prompt: "inspect",
      noProject: false,
      repoPath: "/fixture",
      idempotencyKey: "project-key",
    });
    expect(enqueue.mock.calls.map((call) => call[2]["scope"])).toEqual([
      { kind: "project", root: process.cwd() },
      { kind: "project", root: "/fixture" },
      { kind: "project", root: "/fixture" },
    ]);
    await expect(
      runner({ mode: "ask", prompt: "inspect", noProject: false, idempotencyKey: "rootless" }),
    ).rejects.toMatchObject({ code: "idempotency_repo_path_required" });
  });

  it.each([
    [{ mode: "ask", noProject: true, repoPath: "/fixture" }, "no_project_scope_conflict"],
    [{ mode: "ask", noProject: true, repoPath: "" }, "no_project_scope_conflict"],
    [{ mode: "ask", noProject: "true" }, "no_project_invalid"],
    [{ mode: "agent", noProject: true }, "no_project_invalid"],
    [{ mode: "plan", noProject: false }, "no_project_invalid"],
  ])("refuses %j before any daemon contact", async (args, code) => {
    const ensure = vi.spyOn(daemonRun, "ensureDaemon");
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait");
    await expect(
      mcpSurfaceRunner()({ prompt: "inspect", deferred: true, idempotencyKey: "k", ...args }),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(ensure).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("leaves execution admission to the shared run-start normalizer", async () => {
    vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue({
      client: {} as never,
      addr: { baseUrl: "http://unused", token: "fixture" },
      engine: { engineVersion: null, engineBuildSha: null, servingMode: "normal" },
    });
    const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait").mockResolvedValue({
      runId: "run",
      jobId: "job",
      runDir: "",
      status: "running",
    });
    const runner = mcpSurfaceRunner();
    // delegated: true without a root is an accepted marker, as over HTTP.
    await runner({
      mode: "ask",
      prompt: "Explain.",
      noProject: true,
      deferred: true,
      idempotencyKey: "k",
      execution: { delegated: true },
    });
    const delegated = enqueue.mock.calls[0]![2];
    expect(delegated).toMatchObject({
      scope: { kind: "none" },
      execution: { isolation: "envelope", delegated: true },
    });
    expect(ControlRunStartRequest.safeParse(delegated).success).toBe(true);
    // A root without a project reaches the engine, whose normalizer refuses it.
    await runner({
      mode: "ask",
      prompt: "Explain.",
      noProject: true,
      deferred: true,
      execution: { workspaceRoot: "/fixture" },
    });
    const rooted = enqueue.mock.calls[1]![2];
    expect(rooted).toMatchObject({
      scope: { kind: "none" },
      execution: { workspaceRoot: "/fixture" },
    });
    expect(() => normalizeRunStartRequest(rooted)).toThrow(
      expect.objectContaining({ code: "execution_workspace_invalid" }),
    );
  });

  it.each([true, false])(
    "refuses noProject=%s on a bound Delegate runner instead of leaving the parent's project",
    async (noProject) => {
      const connect = vi.spyOn(daemonRun, "connectDaemonIfRunning");
      const enqueue = vi.spyOn(daemonRun, "enqueueAndAwait");
      await expect(
        mcpSurfaceRunner({
          requireExistingDaemon: true,
          delegationParentRunId: "parent",
          delegationRepoRoot: "/bound",
        })({ mode: "ask", prompt: "inspect", noProject, repoPath: "/bound" }),
      ).rejects.toMatchObject({ code: "delegation_scope_fixed", retryable: false });
      expect(connect).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
