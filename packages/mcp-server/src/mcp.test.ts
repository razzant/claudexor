import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { McpServer, defaultClaudexorTools } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("McpServer", () => {
  it("handles initialize, tools/list, and tools/call", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    // Runner echoes the mode into the summary so we can assert the tool ran in
    // agent mode without relying on a raw JSON dump of the internal run object.
    const tools = defaultClaudexorTools(async (p) => ({ ok: true, mode: p.mode, summary: `ran in ${p.mode} mode` }));
    const server = new McpServer({ tools, transport: { read: c2s, write: s2c } });
    const serving = server.serve();

    const responses: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) responses.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    c2s.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claudexor_run", arguments: { prompt: "hi" } } }) + "\n",
    );
    await sleep(60);
    c2s.end();
    await serving;

    expect(responses.find((r) => r.id === 1)?.result?.protocolVersion).toBeTruthy();
    expect(responses.find((r) => r.id === 2)?.result?.tools?.length).toBeGreaterThan(0);
    const call = responses.find((r) => r.id === 3);
    expect(call?.result?.content?.[0]?.text).toContain("agent");
  });

  it("returns the run SUMMARY (not raw JSON) as the tool_call result", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    // Mirror of the ACP "emits the run SUMMARY (not raw JSON)" test: the MCP tool
    // result must be the run's primary output, not the raw internal run object.
    const tools = defaultClaudexorTools(async () => ({ runId: "r1", status: "succeeded", summary: "Did the thing.", winner: "A" }));
    const server = new McpServer({ tools, transport: { read: c2s, write: s2c } });
    const serving = server.serve();

    const responses: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) responses.push(JSON.parse(l));
    });

    c2s.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claudexor_run", arguments: { prompt: "go" } } }) + "\n",
    );
    await sleep(40);
    c2s.end();
    await serving;

    const text = responses.find((r) => r.id === 1)?.result?.content?.[0]?.text;
    expect(text).toBe("Did the thing.");
    // Never the raw internal object.
    expect(text).not.toContain("runId");
    expect(text).not.toContain("winner");
  });

  it("rejects invalid tool arguments before invoking the runner", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let calls = 0;
    const tools = defaultClaudexorTools(async () => {
      calls += 1;
      return "should not run";
    });
    const raceSchema = tools.find((t) => t.name === "claudexor_race")?.inputSchema as any;
    const runSchema = tools.find((t) => t.name === "claudexor_run")?.inputSchema as any;
    const statusSchema = tools.find((t) => t.name === "claudexor_status")?.inputSchema as any;
    expect(runSchema?.additionalProperties).toBe(false);
    expect(runSchema?.properties?.prompt?.pattern).toBe("\\S");
    expect(raceSchema?.properties?.n?.type).toBe("integer");
    expect(raceSchema?.properties?.n?.minimum).toBe(2);
    expect(statusSchema?.additionalProperties).toBe(false);
    const server = new McpServer({ tools, transport: { read: c2s, write: s2c } });
    const serving = server.serve();

    const responses: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) responses.push(JSON.parse(l));
    });

    const invalidCalls = [
      { id: 1, name: "claudexor_run", arguments: {} },
      { id: 2, name: "claudexor_run", arguments: { prompt: "" } },
      { id: 3, name: "claudexor_run", arguments: { prompt: "   " } },
      { id: 4, name: "claudexor_run", arguments: { prompt: "go", repoPath: "relative" } },
      { id: 5, name: "claudexor_run", arguments: { prompt: "go", n: 1.5 } },
      { id: 6, name: "claudexor_run", arguments: { prompt: "go", extra: true } },
      { id: 7, name: "claudexor_race", arguments: { prompt: "go", n: 1 } },
    ];
    for (const call of invalidCalls) {
      c2s.write(JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call", params: { name: call.name, arguments: call.arguments } }) + "\n");
    }
    await sleep(60);
    c2s.end();
    await serving;

    expect(calls).toBe(0);
    expect(responses).toHaveLength(invalidCalls.length);
    expect(responses.every((r) => r.error?.code === -32602)).toBe(true);
  });
});
