import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AcpServer } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("AcpServer", () => {
  it("handles initialize, session/new, session/prompt", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({ runner: async (p) => ({ ok: true, prompt: p.prompt }), transport: { read: c2s, write: s2c } });
    const serving = server.serve();

    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} }) + "\n");
    await sleep(30);
    const sid = messages.find((m) => m.id === 2)?.result?.sessionId;
    c2s.write(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: "hello" } }) + "\n",
    );
    await sleep(40);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 1)?.result?.protocolVersion).toBe(1);
    expect(sid).toBeTruthy();
    expect(messages.find((m) => m.id === 3)?.result?.stopReason).toBe("end_turn");
    expect(messages.some((m) => m.method === "session/update")).toBe(true);
  });
});
