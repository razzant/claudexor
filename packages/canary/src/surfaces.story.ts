/**
 * Surface canaries — user-level contracts over the MCP/plugin surfaces of the
 * BUILT CLI (the real-harness battery's old integration blind spot, now pinned
 * offline with fake harnesses in the hermetic sandbox).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLI, type Sandbox, cli, makeSandbox } from "./support.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.dispose();
});

/** Drive the real `claudexor mcp serve` over stdio with newline JSON-RPC. */
function mcpClient(cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, "mcp", "serve"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses: any[] = [];
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += String(c);
  });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (l) => {
    if (l.trim()) responses.push(JSON.parse(l));
  });
  const send = (obj: unknown): void => {
    child.stdin.write(JSON.stringify(obj) + "\n");
  };
  const waitFor = async (id: unknown, timeoutMs: number): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = responses.find((r) => r.id === id);
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(
          `no response for id ${String(id)} within ${timeoutMs}ms; stderr: ${stderr.slice(-400)}`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const close = async (): Promise<void> => {
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 150));
    child.kill();
  };
  return { send, waitFor, responses, close, stderrText: () => stderr };
}

describe("surface canaries (MCP + plugins over the built CLI)", () => {
  it("[INV-002:mcp-daemon-tracked-runs] an MCP mutating verb is daemon-tracked: runId trailer in the result, inspect resolves it, ping answers mid-call", async () => {
    const mcp = mcpClient(sb.repo, sb.env);
    try {
      mcp.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "canary", version: "1.0" },
        },
      });
      const init = await mcp.waitFor(0, 15_000);
      expect(init.result?.protocolVersion).toBe("2025-06-18");
      expect(init.result?.serverInfo?.name).toBe("claudexor");
      mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      mcp.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const tools = await mcp.waitFor(1, 10_000);
      const toolNames = tools.result?.tools?.map((t: { name: string }) => t.name) ?? [];
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "claudexor_run",
          "claudexor_run_status",
          "claudexor_run_cancel",
          "claudexor_run_result",
          "claudexor_journal_recovery",
        ]),
      );

      // The mutating verb: enqueue through the sandbox daemon (auto-started).
      mcp.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "claudexor_run",
          arguments: { prompt: "fix add()", repoPath: sb.repo, harness: "fake-success" },
        },
      });
      // Concurrency contract: ping answers WHILE the run is in flight.
      mcp.send({ jsonrpc: "2.0", id: 3, method: "ping" });
      const ping = await mcp.waitFor(3, 10_000);
      expect(ping.result).toBeDefined();

      const call = await mcp.waitFor(2, 120_000);
      const text = String(call.result?.content?.[0]?.text ?? "");
      const runId = /runId: (\S+)/.exec(text)?.[1];
      expect(runId, `result must carry the runId trailer; got: ${text.slice(0, 200)}`).toBeTruthy();
      expect(text).toMatch(/status: /);

      // The daemon tracks the run: the CLI resolves it OUTSIDE the MCP process.
      const inspect = cli(sb, ["inspect", runId as string, "--json"]);
      expect((inspect.json() as { runId: string }).runId).toBe(runId);
    } finally {
      await mcp.close();
    }
  }, 180_000);

  it("[INV-002:plugin-lifecycle-owned-files] install -> doctor -> drift -> repair -> uninstall stays inside owned files in a scratch HOME", () => {
    // The sandbox HOME is the scratch host root: nothing outside it is touched.
    const install = cli(sb, ["plugin", "install", "cursor", "--json"]);
    expect(install.code).toBe(0);
    const installOut = install.json() as { ok: boolean; results: Array<{ state: string }> };
    expect(installOut.ok).toBe(true);
    expect(installOut.results[0]?.state).toBe("installed");
    const skillPath = join(
      sb.home,
      ".cursor",
      "plugins",
      "local",
      "claudexor",
      "skills",
      "claudexor",
      "SKILL.md",
    );
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("claudexor:managed");

    // Idempotent rerun: no changes.
    const rerun = cli(sb, ["plugin", "install", "cursor", "--json"]);
    expect((rerun.json() as { results: Array<{ changed: boolean }> }).results[0]?.changed).toBe(
      false,
    );

    // Doctor self-tests the MCP server boot against the CURRENT runtime.
    const doctor = cli(sb, ["plugin", "doctor", "cursor", "--json"]);
    expect((doctor.json() as { ok: boolean }).ok).toBe(true);

    // Marker-preserving mutation = OWNED drift -> repair rewrites it.
    writeFileSync(skillPath, readFileSync(skillPath, "utf8") + "\n<!-- local tweak -->\n");
    const drifted = cli(sb, ["plugin", "status", "cursor", "--json"]);
    expect((drifted.json() as { results: Array<{ state: string }> }).results[0]?.state).toBe(
      "drifted",
    );
    const repair = cli(sb, ["plugin", "repair", "cursor", "--json"]);
    expect((repair.json() as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(skillPath, "utf8")).not.toContain("local tweak");

    // Uninstall removes owned artifacts; the manifest is gone.
    const uninstall = cli(sb, ["plugin", "uninstall", "cursor", "--json"]);
    expect((uninstall.json() as { ok: boolean }).ok).toBe(true);
    expect(
      existsSync(
        join(sb.home, ".cursor", "plugins", "local", "claudexor", ".cursor-plugin", "plugin.json"),
      ),
    ).toBe(false);
    expect(existsSync(skillPath)).toBe(false);

    // Collision honesty: a pre-existing UNOWNED file (no marker) blocks a
    // fresh install even with --force — user files are never clobbered.
    const unownedRoot = join(
      sb.home,
      ".cursor",
      "plugins",
      "local",
      "claudexor",
      "skills",
      "claudexor",
    );
    mkdirSync(unownedRoot, { recursive: true });
    writeFileSync(join(unownedRoot, "SKILL.md"), "user-owned content without marker\n");
    const blocked = cli(sb, ["plugin", "install", "cursor", "--force", "--json"]);
    expect((blocked.json() as { ok: boolean }).ok).toBe(false);
    expect(blocked.stdout + blocked.stderr).toMatch(/not Claudexor-owned/);
    expect(readFileSync(join(unownedRoot, "SKILL.md"), "utf8")).toBe(
      "user-owned content without marker\n",
    );
  }, 120_000);

  it("[INV-002:acp-conformance-smoke] `acp serve` initialize carries authMethods and a session prompt round-trips a summary", async () => {
    const child = spawn(process.execPath, [CLI, "acp", "serve"], {
      cwd: sb.repo,
      env: sb.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages: any[] = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });
    const send = (obj: unknown): void => {
      child.stdin.write(JSON.stringify(obj) + "\n");
    };
    const waitFor = async (pred: (m: any) => boolean, timeoutMs: number): Promise<any> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline)
          throw new Error(`ACP message not observed within ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
      const init = await waitFor((m) => m.id === 1, 15_000);
      expect(init.result?.protocolVersion).toBe(1);
      expect(init.result?.authMethods).toEqual([]);
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: sb.repo, mcpServers: [] },
      });
      const sess = await waitFor((m) => m.id === 2, 10_000);
      const sessionId = sess.result?.sessionId;
      expect(sessionId).toBeTruthy();
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId,
          prompt: [{ type: "text", text: "what is 2+2?" }],
          _meta: {
            claudexor: { mode: "ask", harness: "fake-success" },
            "vendor/x": 1,
          },
        },
      });
      const done = await waitFor((m) => m.id === 3, 120_000);
      expect(done.result?.stopReason, JSON.stringify(done)).toBe("end_turn");
      const chunk = messages.find(
        (m) =>
          m.method === "session/update" &&
          m.params?.update?.sessionUpdate === "agent_message_chunk",
      );
      expect(chunk).toBeTruthy();
    } finally {
      child.stdin.end();
      await new Promise((r) => setTimeout(r, 150));
      child.kill();
    }
  }, 180_000);
});
