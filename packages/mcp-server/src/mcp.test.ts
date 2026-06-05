import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { McpServer, defaultClaudexTools } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("McpServer", () => {
  it("handles initialize, tools/list, and tools/call", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const tools = defaultClaudexTools(async (p) => ({ ok: true, mode: p.mode, prompt: p.prompt }));
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
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claudex_run", arguments: { prompt: "hi" } } }) + "\n",
    );
    await sleep(60);
    c2s.end();
    await serving;

    expect(responses.find((r) => r.id === 1)?.result?.protocolVersion).toBeTruthy();
    expect(responses.find((r) => r.id === 2)?.result?.tools?.length).toBeGreaterThan(0);
    const call = responses.find((r) => r.id === 3);
    expect(call?.result?.content?.[0]?.text).toContain("daily");
  });
});
