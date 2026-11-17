import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { defaultClaudexorTools, serveClaudexorMcp, type McpTool } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";

/** One tools/call over the real stdio wire of the served factory. */
async function call(tools: McpTool[], name: string, args: Record<string, unknown>) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const handle = serveClaudexorMcp({
    version: "0.0.0-test",
    tools,
    transport: { read: c2s, write: s2c },
  });
  const responses: any[] = [];
  createInterface({ input: s2c }).on("line", (line) => {
    if (line.trim()) responses.push(JSON.parse(line));
  });
  const send = (message: unknown) => c2s.write(JSON.stringify(message) + "\n");
  const answered = async (id: unknown) => {
    for (let waited = 0; waited < 5_000; waited += 10) {
      const response = responses.find((candidate) => candidate.id === id);
      if (response) return response;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no response to ${String(id)}`);
  };
  send({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-host", version: "1.0" },
    },
  });
  await answered("init");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const response = await answered(1);
  await handle.close();
  return response.result;
}

const RUN_TOOLS = [
  "claudexor_ask",
  "claudexor_run",
  "claudexor_best_of",
  "claudexor_plan",
  "claudexor_create",
];

describe("explicit no-project Ask on the public MCP surface", () => {
  it("is declared by claudexor_ask only, never by another run tool or the Delegate belt", () => {
    const tools = defaultClaudexorTools(async () => ({}));
    for (const name of RUN_TOOLS) {
      const properties = tools.find((tool) => tool.name === name)!.inputSchema.properties as Record<
        string,
        { type?: string }
      >;
      if (name === "claudexor_ask") expect(properties["noProject"]?.type).toBe("boolean");
      else expect(properties).not.toHaveProperty("noProject");
    }
    const belt = beltClaudexorTools(async () => ({}), {
      parentRunId: "parent",
      repoRoot: "/fixture",
      depth: 0,
      maxSubRuns: 8,
      parentBudget: { kind: "finite", maxUsd: 1 },
    });
    for (const tool of belt) expect(tool.inputSchema.properties).not.toHaveProperty("noProject");
  });

  it("forwards noProject with a replay key and no repoPath to the runner", async () => {
    const calls: Record<string, unknown>[] = [];
    const tools = defaultClaudexorTools(async (params) => {
      calls.push(params);
      return { runId: "run-none", jobId: "job-none", status: "running" };
    });
    const result = await call(tools, "claudexor_ask", {
      prompt: "Explain this inline snippet.",
      noProject: true,
      idempotencyKey: "projectless-key",
    });
    expect(result?.isError).not.toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({
        mode: "ask",
        noProject: true,
        idempotencyKey: "projectless-key",
        deferred: true,
      }),
    ]);
    expect(calls[0]).not.toHaveProperty("repoPath");
  });

  it.each([
    ["claudexor_run", { noProject: true }],
    ["claudexor_plan", { noProject: true }],
    ["claudexor_ask", { noProject: "true" }],
  ])("refuses %s with %j before invoking the runner", async (name, extra) => {
    let calls = 0;
    const tools = defaultClaudexorTools(async () => {
      calls += 1;
      return {};
    });
    const result = await call(tools, name, { prompt: "go", ...extra });
    expect(result?.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("refuses noProject on the Delegate belt before ledger admission", async () => {
    let calls = 0;
    const ledger = { started: 0, committedUsd: 0 };
    const belt = beltClaudexorTools(
      async () => {
        calls += 1;
      },
      {
        parentRunId: "parent",
        repoRoot: "/fixture",
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "finite", maxUsd: 1 },
      },
      ledger,
    );
    const result = await call(belt, "claudexor_ask", { prompt: "go", noProject: true });
    expect(result?.isError).toBe(true);
    expect(calls).toBe(0);
    expect(ledger).toEqual({ started: 0, committedUsd: 0 });
  });
});
