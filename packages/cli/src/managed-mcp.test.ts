import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { createServer as netServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { canonicalDefaultSocketPath } from "@claudexor/daemon";
import { defaultClaudexorTools, serveClaudexorMcp } from "@claudexor/mcp-server";
import { CLAUDEXOR_VERSION } from "@claudexor/util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpSurfaceRunner } from "./mcp-runner.js";
import * as launcher from "./daemon-launch.js";
import { daemonCommand } from "./ops-commands.js";
import { parseArgs } from "./args.js";

function wire() {
  const read = new PassThrough();
  const write = new PassThrough();
  const server = serveClaudexorMcp({
    version: CLAUDEXOR_VERSION,
    tools: defaultClaudexorTools(mcpSurfaceRunner()),
    transport: { read, write },
  });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: write });
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    pending.get(frame.id)?.(frame);
    pending.delete(frame.id);
  });
  return {
    request(method: string, params: unknown = {}): Promise<any> {
      const next = ++id;
      return new Promise((done) => {
        pending.set(next, done);
        read.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
      });
    },
    notify() {
      read.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async close() {
      await server.close();
      lines.close();
      read.destroy();
      write.destroy();
    },
  };
}

describe("ordinary external MCP and CLI attachment", () => {
  let dir: string;
  let root: string;
  let socket: NetServer | undefined;
  let http: HttpServer | undefined;
  let mode: "normal" | "recovery_only";
  let accepted: string[];
  let bridge: ReturnType<typeof wire> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), "cx-m-"));
    root = join(dir, "root");
    mode = "normal";
    accepted = [];
    vi.stubEnv("HOME", dir);
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", root);
    vi.stubEnv("CLAUDEXOR_DAEMON_OWNER", "external");
    vi.stubEnv("CLAUDEXOR_ROOT_MODE", "explicit");
    vi.stubEnv("CLAUDEXOR_HOST_BINDING_VERSION", "1");
    vi.stubEnv("CLAUDEXOR_DAEMON_SOCK", join(dir, "stale.sock"));
    vi.stubEnv("CLAUDEXOR_DAEMON_ENTRY", join(dir, "never-start.js"));
    vi.spyOn(launcher, "launchDetachedDaemon");
  });

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((done) => http!.close(() => done()));
    }
    if (socket) await new Promise<void>((done) => socket!.close(() => done()));
    http = undefined;
    socket = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connectWire() {
    bridge = wire();
    expect(
      (
        await bridge.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        })
      ).result.serverInfo.name,
    ).toBe("claudexor");
    bridge.notify();
    return bridge;
  }

  async function startFixture() {
    mkdirSync(join(root, "daemon"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "daemon/token"), "fixture-token", { mode: 0o600 });
    socket = netServer((connection) => {
      const lines = createInterface({ input: connection });
      lines.on("line", (line) => {
        const input = JSON.parse(line);
        connection.write(
          JSON.stringify({
            id: input.id,
            result: { ok: true, state: "running", runId: "run-fixture", runDir: dir },
          }) + "\n",
        );
      });
      connection.on("close", () => lines.close());
    });
    await new Promise<void>((done, fail) => {
      socket!.once("error", fail);
      socket!.listen(canonicalDefaultSocketPath(), done);
    });
    http = httpServer((req, res) => {
      const path = req.url!;
      const reply = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (path === "/healthz") return reply({ ok: true });
      if (path === "/v2/handshake")
        return reply({
          compatible: true,
          protocolMajor: 3,
          operationsPath: "/v2/operations",
          engine: { version: CLAUDEXOR_VERSION, sha: "unknown", entry: "/fixture/daemon.js" },
          servingMode: mode,
        });
      if (path.startsWith("/v2/recovery/")) return reply({ partition: "global", state: "fixture" });
      if (mode === "recovery_only")
        return reply(
          {
            code: "daemon_recovery_only",
            message: "fixture is recovering",
            retryable: true,
            fieldErrors: {},
            requiredActions: [],
            evidenceRefs: [],
          },
          503,
        );
      if (path === "/v2/projects") return reply({ id: "project-fixture" }, 201);
      if (req.method === "POST") accepted.push(path);
      if (path === "/v2/runs")
        return reply({ jobId: "job-fixture", runId: "run-fixture", runDir: dir }, 202);
      if (path.startsWith("/v2/runs?"))
        return reply({ runs: [{ runId: "run-fixture", status: "running" }], hasMore: false });
      if (path === "/v2/threads")
        return reply({
          id: "th-fixture",
          title: "Fixture",
          repoRoot: dir,
          createdAt: "2026-10-10T00:00:00Z",
          updatedAt: "2026-10-10T00:00:00Z",
        });
      if (path === "/v2/threads/th-fixture/turns")
        return reply(
          { jobId: "job-turn", threadId: "th-fixture", turnId: "turn-fixture", state: "queued" },
          202,
        );
      return reply({ code: "not_found", message: "fixture route absent" }, 404);
    });
    await new Promise<void>((done) => http!.listen(0, "127.0.0.1", done));
    writeFileSync(
      join(root, "daemon/control-api.json"),
      JSON.stringify({ host: "127.0.0.1", port: (http.address() as { port: number }).port }),
    );
  }

  it("retains the full toolset and reaches acting, thread and recovery transports", async () => {
    await startFixture();
    const w = await connectWire();
    const tools = (await w.request("tools/list")).result.tools.map((tool: any) => tool.name);
    expect(tools).toEqual(defaultClaudexorTools(mcpSurfaceRunner()).map((tool) => tool.name));
    for (const [name, args] of [
      ["claudexor_run", { prompt: "fixture only", repoPath: dir }],
      ["claudexor_thread_create", { repoPath: dir, title: "Fixture" }],
      ["claudexor_thread_turn", { threadId: "th-fixture", prompt: "continue fixture" }],
      ["claudexor_runs", {}],
      ["claudexor_journal_recovery", { action: "inspect", partition: "global" }],
    ] as const) {
      const response = await w.request("tools/call", { name, arguments: args });
      expect(response.error, JSON.stringify(response)).toBeUndefined();
      expect(response.result.isError, JSON.stringify(response)).not.toBe(true);
    }
    expect(accepted).toEqual(["/v2/runs", "/v2/threads", "/v2/threads/th-fixture/turns"]);
    expect(launcher.launchDetachedDaemon).not.toHaveBeenCalled();
  });

  it("ordinary absent MCP and acting CLI fail typed without root, token, default store or auth effects", async () => {
    const w = await connectWire();
    const response = await w.request("tools/call", {
      name: "claudexor_run",
      arguments: { prompt: "fixture only", repoPath: dir },
    });
    expect(response.result.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("daemon_unavailable");
    expect(JSON.stringify(response)).not.toMatch(/delegation belt|daemon start/);
    const recovery = await w.request("tools/call", { name: "claudexor_runs", arguments: {} });
    expect(recovery.result.isError).toBe(true);
    expect(recovery.result.structuredContent.failure.code).toBe("daemon_unavailable");
    for (const verb of ["ask", "plan", "agent"]) {
      const result = spawnSync(
        process.execPath,
        [
          resolve("packages/cli/dist/cli.js"),
          verb,
          "fixture only",
          "--harness",
          "fake-success",
          "--json",
        ],
        { cwd: dir, env: process.env, encoding: "utf8", timeout: 10_000 },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "daemon_unavailable" });
    }
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(dir, ".claudexor"))).toBe(false);
    expect(launcher.launchDetachedDaemon).not.toHaveBeenCalled();
  });

  it("retains recovery-only refusal and recovery reads without replacing the daemon", async () => {
    await startFixture();
    mode = "recovery_only";
    const w = await connectWire();
    const refusal = await w.request("tools/call", {
      name: "claudexor_run",
      arguments: { prompt: "fixture only", repoPath: dir },
    });
    expect(refusal.result.isError).toBe(true);
    expect(JSON.stringify(refusal)).toContain("daemon_recovery_only");
    const read = await w.request("tools/call", {
      name: "claudexor_journal_recovery",
      arguments: { action: "inspect", partition: "global" },
    });
    expect(read.result.isError, JSON.stringify(read)).not.toBe(true);
    expect(accepted).toEqual([]);
    expect(launcher.launchDetachedDaemon).not.toHaveBeenCalled();
  });

  it("keeps external daemon status and logs available", async () => {
    await startFixture();
    writeFileSync(join(root, "daemon/claudexord.log"), "fixture log\n");
    const output: string[] = [];
    const capture = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      expect(await daemonCommand(parseArgs(["daemon", "status"]), true)).toBe(0);
      expect(await daemonCommand(parseArgs(["daemon", "logs"]), true)).toBe(0);
    } finally {
      capture.mockRestore();
    }
    expect(output.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true, log_tail: "fixture log\n" }),
    ]);
    expect(launcher.launchDetachedDaemon).not.toHaveBeenCalled();
  });

  it("existing-only connection policy never invents Delegate lineage", async () => {
    await expect(
      mcpSurfaceRunner({ requireExistingDaemon: true })({ mode: "agent", prompt: "fixture" }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
    await expect(
      mcpSurfaceRunner({ requireExistingDaemon: true })({ mode: "agent", prompt: "fixture" }),
    ).rejects.not.toThrow(/delegation belt/);
    await expect(
      mcpSurfaceRunner({ requireExistingDaemon: true, delegationParentRunId: "parent" })({
        mode: "agent",
        prompt: "fixture",
      }),
    ).rejects.toThrow(/parent daemon/);
  });
});
