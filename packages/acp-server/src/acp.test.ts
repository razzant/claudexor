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

  it("answers session/request_permission WHILE the prompt is still running (read loop never blocks)", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let received: any = null;
    const server = new AcpServer({
      runner: async (_p, hooks) => {
        received = await hooks?.onInteraction?.({
          request: {
            interaction_id: "int-1",
            questions: [{ id: "q1", question: "Red or Blue?", options: [{ label: "Red" }, { label: "Blue" }] }],
          },
        });
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      const msg = JSON.parse(l);
      messages.push(msg);
      // Client behavior: answer the server->client permission request with Blue.
      if (msg.method === "session/request_permission") {
        c2s.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "opt-2" } } }) + "\n");
      }
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "ask me" } }) + "\n");
    await sleep(60);
    c2s.end();
    await serving;

    expect(received?.answers?.[0]?.selected_labels).toEqual(["Blue"]);
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("session/cancel aborts the active run and the prompt resolves cancelled", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({
      runner: (_p, hooks) =>
        new Promise((_resolve, reject) => {
          // Long run that only ends via abort (cooperative cancellation).
          hooks?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "long" } }) + "\n");
    await sleep(20);
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/cancel", params: { sessionId: sid } }) + "\n");
    await sleep(40);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 3)?.result?.cancelled).toBe(true);
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("cancelled");
  });

  it("rejects a second prompt while one is active for the same session", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({
      runner: (_p, hooks) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ ok: true }), 80);
          hooks?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
        }),
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "first" } }) + "\n");
    await sleep(10);
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: "second" } }) + "\n");
    await sleep(120);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 3)?.result?.stopReason).toBe("error");
    expect(messages.find((m) => m.id === 3)?.result?.error).toContain("active prompt");
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });
});
