import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { AcpServer } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tempProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "claudexor-acp-project-"));
}

function sessionNewParams(): { cwd: string } {
  return { cwd: tempProjectDir() };
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
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: sessionNewParams() }) + "\n");
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

  it("forwards advanced run controls from session/prompt to the runner", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let received: any = null;
    const server = new AcpServer({
      runner: async (p) => {
        received = p;
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    const projectDir = tempProjectDir();
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: projectDir } }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: {
          sessionId: sid,
          prompt: "go",
          mode: "agent",
          harness: "codex",
          primaryHarness: "codex",
          tests: ["pnpm test"],
          maxUsd: 5,
          access: "workspace_write",
          reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8" }],
          reviewerModels: { openai: "gpt-5.5" },
          reviewerEfforts: { openai: "xhigh" },
          protectedPathApprovals: [{ path: "docs/**", reason: "explicit ACP request" }],
        },
      }) + "\n",
    );
    await sleep(40);
    c2s.end();
    await serving;

    expect(received).toMatchObject({
      prompt: "go",
      mode: "agent",
      repoPath: projectDir,
      harness: "codex",
      primaryHarness: "codex",
      tests: ["pnpm test"],
      maxUsd: 5,
      access: "workspace_write",
      reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8" }],
      reviewerModels: { openai: "gpt-5.5" },
      reviewerEfforts: { openai: "xhigh" },
      protectedPathApprovals: [{ path: "docs/**", reason: "explicit ACP request" }],
    });
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("rejects relative session cwd before anchoring run paths", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let calls = 0;
    const server = new AcpServer({
      runner: async () => {
        calls += 1;
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "relative/project" } }) + "\n");
    await sleep(30);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 1)?.error?.code).toBe(-32600);
    expect(messages.find((m) => m.id === 1)?.error?.message).toContain("absolute path");
    expect(calls).toBe(0);
  });

  it("rejects missing, non-string, blank, and missing-directory session cwd before creating a session", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let calls = 0;
    const server = new AcpServer({
      runner: async () => {
        calls += 1;
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });
    const missingDir = join(tmpdir(), `claudexor-acp-missing-${Date.now()}-${Math.random()}`);

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: 42 } }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "   " } }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: missingDir } }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/new", params: {} }) + "\n");
    await sleep(30);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 1)?.error?.message).toContain("non-empty absolute path string");
    expect(messages.find((m) => m.id === 2)?.error?.message).toContain("non-empty absolute path");
    expect(messages.find((m) => m.id === 3)?.error?.message).toContain("existing directory");
    expect(messages.find((m) => m.id === 4)?.error?.message).toContain("cwd is required");
    expect(calls).toBe(0);
  });

  it("rejects session prompts without a known cwd-anchored session", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let calls = 0;
    const server = new AcpServer({
      runner: async () => {
        calls += 1;
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: "go" } }) + "\n");
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "missing", prompt: "go" } }) + "\n");
    await sleep(30);
    c2s.end();
    await serving;

    expect(messages.find((m) => m.id === 1)?.error?.message).toContain("known session");
    expect(messages.find((m) => m.id === 2)?.error?.message).toContain("known session");
    expect(calls).toBe(0);
  });

  it("rejects malformed advanced run controls before invoking the runner", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let calls = 0;
    const server = new AcpServer({
      runner: async () => {
        calls += 1;
        return { ok: true };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 100)?.result?.sessionId;
    const withSession = (params: Record<string, unknown>) => ({ sessionId: sid, ...params });
    const secretLike = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";

    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: withSession({ prompt: "go", tests: "pnpm test", reviewerPanel: [{ harness: "claude" }] }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: withSession({ prompt: "go", reviewerPanel: [{ harness: "claude", authPreference: "api_key" }] }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: withSession({ prompt: "go", effort: "turbo" }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "session/prompt",
        params: withSession({ prompt: "go", reviewerModels: { opneai: "gpt-5.5" } }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "session/prompt",
        params: withSession({ prompt: "go", reviewerEfforts: { openai: "turbo" } }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "session/prompt",
        params: withSession({ prompt: "go", race: "true" }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/prompt",
        params: withSession({ prompt: "" }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "session/prompt",
        params: withSession({ prompt: "   " }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "session/prompt",
        params: withSession({}),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "session/prompt",
        params: withSession({ prompt: "go", harness: "" }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "session/prompt",
        params: withSession({ prompt: "go", primaryHarness: " " }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "session/prompt",
        params: withSession({ prompt: "go", model: "" }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 13,
        method: "session/prompt",
        params: withSession({ prompt: "go", reviewerPannel: [{ harness: "claude" }] }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 14,
        method: "session/prompt",
        params: withSession({ prompt: "go", race: true, n: 1 }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 15,
        method: "session/prompt",
        params: withSession({ prompt: "go", reviewerPanel: [{ harness: "claude", model: secretLike }] }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 16,
        method: "session/prompt",
        params: withSession({ prompt: "go", tests: [`echo ${secretLike}`] }),
      }) + "\n",
    );
    c2s.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 17,
        method: "session/prompt",
        params: withSession({ prompt: "go", protectedPathApprovals: [{ path: secretLike }] }),
      }) + "\n",
    );
    await sleep(40);
    c2s.end();
    await serving;

    expect(calls).toBe(0);
    expect(messages.find((m) => m.id === 1)?.error?.code).toBe(-32600);
    expect(messages.find((m) => m.id === 2)?.error?.message).toContain("unknown reviewerPanel field");
    expect(messages.find((m) => m.id === 3)?.error?.message).toContain("effort must be a valid effort value");
    expect(messages.find((m) => m.id === 4)?.error?.message).toContain("unknown provider family key");
    expect(messages.find((m) => m.id === 5)?.error?.message).toContain("valid effort values");
    expect(messages.find((m) => m.id === 6)?.error?.message).toContain("race must be a boolean");
    expect(messages.find((m) => m.id === 7)?.error?.message).toContain("prompt must be a non-empty string");
    expect(messages.find((m) => m.id === 8)?.error?.message).toContain("prompt must be a non-empty string");
    expect(messages.find((m) => m.id === 9)?.error?.message).toContain("prompt must be a non-empty string");
    expect(messages.find((m) => m.id === 10)?.error?.message).toContain("harness must be a non-empty string");
    expect(messages.find((m) => m.id === 11)?.error?.message).toContain("primaryHarness must be a non-empty string");
    expect(messages.find((m) => m.id === 12)?.error?.message).toContain("model must be a non-empty string");
    expect(messages.find((m) => m.id === 13)?.error?.message).toContain("unknown session/prompt field: reviewerPannel");
    expect(messages.find((m) => m.id === 14)?.error?.message).toContain("race n must be an integer >= 2");
    expect(messages.find((m) => m.id === 15)?.error?.message).toContain("secret-like value is not accepted");
    expect(messages.find((m) => m.id === 16)?.error?.message).toContain("secret-like value is not accepted");
    expect(messages.find((m) => m.id === 17)?.error?.message).toContain("secret-like value is not accepted");
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

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "ask me" } }) + "\n");
    await sleep(60);
    c2s.end();
    await serving;

    expect(received?.answers?.[0]?.selected_labels).toEqual(["Blue"]);
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("session/cancel (id-less NOTIFICATION) aborts the run, the prompt resolves cancelled, and nothing is replied to the notification", async () => {
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

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "long" } }) + "\n");
    await sleep(20);
    // session/cancel is a JSON-RPC notification: NO id, and the server must NOT reply.
    c2s.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: sid } }) + "\n");
    await sleep(40);
    c2s.end();
    await serving;

    // The prompt is cancelled.
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("cancelled");
    // No response was emitted for the notification (no message lacking a request id / no id-less response).
    const responses = messages.filter((m) => Object.prototype.hasOwnProperty.call(m, "result") || Object.prototype.hasOwnProperty.call(m, "error"));
    expect(responses.every((m) => m.id === 1 || m.id === 2)).toBe(true);
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

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "first" } }) + "\n");
    await sleep(10);
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: sid, prompt: "second" } }) + "\n");
    await sleep(120);
    c2s.end();
    await serving;

    // A second concurrent prompt is a protocol misuse -> JSON-RPC error, not an
    // invented StopReason (the ACP StopReason enum has no "error" member).
    const dup = messages.find((m) => m.id === 3);
    expect(dup?.result).toBeUndefined();
    expect(dup?.error?.code).toBe(-32600);
    expect(dup?.error?.message).toContain("active prompt");
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("returns a JSON-RPC -32601 error for an unknown method (proper {code,message}, no result)", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({ runner: async () => ({ ok: true }), transport: { read: c2s, write: s2c } });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "does/not-exist", params: {} }) + "\n");
    await sleep(20);
    c2s.end();
    await serving;

    const resp = messages.find((m) => m.id === 7);
    expect(resp?.result).toBeUndefined();
    expect(resp?.error?.code).toBe(-32601);
    expect(resp?.error?.message).toContain("method not found");
  });

  it("emits the run SUMMARY (not raw JSON) as the turn result content", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({
      runner: async () => ({ runId: "r1", status: "succeeded", summary: "Did the thing.", winner: "A" }),
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "go" } }) + "\n");
    await sleep(40);
    c2s.end();
    await serving;

    const chunk = messages.find((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk");
    expect(chunk?.params?.update?.content?.text).toBe("Did the thing.");
    // Never the raw internal object.
    expect(chunk?.params?.update?.content?.text).not.toContain("runId");
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("free-text question (no options): benign decline, honest note, NO fake answer affordance", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    let received: any = "unset";
    const server = new AcpServer({
      runner: async (_p, hooks) => {
        received = await hooks?.onInteraction?.({
          request: {
            interaction_id: "int-ft",
            questions: [{ id: "q1", question: "What name do you want?", options: [] }],
          },
        });
        return { summary: "done" };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "ask" } }) + "\n");
    await sleep(60);
    c2s.end();
    await serving;

    // No session/request_permission was sent (no fake "Answer in chat" affordance).
    expect(messages.some((m) => m.method === "session/request_permission")).toBe(false);
    // The interaction was declined benignly (null answer set).
    expect(received).toBe(null);
    // An honest note was surfaced to the client.
    const note = messages.find(
      (m) =>
        m.method === "session/update" &&
        typeof m.params?.update?.content?.text === "string" &&
        m.params.update.content.text.includes("could not be answered over ACP"),
    );
    expect(note).toBeTruthy();
    // The run still completed normally.
    expect(messages.find((m) => m.id === 2)?.result?.stopReason).toBe("end_turn");
  });

  it("emits a terminal tool_call_update (completion) for every started tool_call", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({
      runner: async (_p, hooks) => {
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_call", tool: { use_id: "u1", name: "read" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_result", tool: { use_id: "u1", name: "read", status: "ok" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_call", tool: { use_id: "u2", name: "bash" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_result", tool: { use_id: "u2", name: "bash", status: "error" } } });
        return { summary: "ok" };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "go" } }) + "\n");
    await sleep(40);
    c2s.end();
    await serving;

    const updates = messages.filter((m) => m.method === "session/update").map((m) => m.params.update);
    const u1Done = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "u1");
    const u2Done = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "u2");
    expect(u1Done?.status).toBe("completed");
    expect(u2Done?.status).toBe("failed");
    // Every started tool_call reached a terminal status (no client hang).
    const started = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId);
    const completed = updates.filter((u) => u.sessionUpdate === "tool_call_update").map((u) => u.toolCallId);
    for (const id of started) expect(completed).toContain(id);
  });

  it("completes BOTH of two concurrent same-name use_id-less tool calls (FIFO fallback, no clobber)", async () => {
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const server = new AcpServer({
      runner: async (_p, hooks) => {
        // Two in-flight calls to the SAME tool, neither carrying a use_id. The
        // fallback must queue both synthetic ids so each result completes its own
        // call (the old single-slot map dropped the first started call).
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_call", tool: { name: "bash" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_call", tool: { name: "bash" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_result", tool: { name: "bash", status: "ok" } } });
        hooks?.onEvent?.({ type: "harness.event", payload: { type: "tool_result", tool: { name: "bash", status: "error" } } });
        return { summary: "ok" };
      },
      transport: { read: c2s, write: s2c },
    });
    const serving = server.serve();
    const messages: any[] = [];
    const rl = createInterface({ input: s2c });
    rl.on("line", (l) => {
      if (l.trim()) messages.push(JSON.parse(l));
    });

    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: sessionNewParams() }) + "\n");
    await sleep(20);
    const sid = messages.find((m) => m.id === 1)?.result?.sessionId;
    c2s.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: sid, prompt: "go" } }) + "\n");
    await sleep(40);
    c2s.end();
    await serving;

    const updates = messages.filter((m) => m.method === "session/update").map((m) => m.params.update);
    const startedIds = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => u.toolCallId);
    const completions = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    // Two distinct synthetic ids were started...
    expect(startedIds.length).toBe(2);
    expect(new Set(startedIds).size).toBe(2);
    // ...and BOTH reached a terminal status — no started call was orphaned.
    expect(completions.length).toBe(2);
    for (const id of startedIds) expect(completions.some((u) => u.toolCallId === id)).toBe(true);
    // FIFO: the first result (ok) completes the first started call; the second
    // (error) completes the second.
    expect(completions.find((u) => u.toolCallId === startedIds[0])?.status).toBe("completed");
    expect(completions.find((u) => u.toolCallId === startedIds[1])?.status).toBe("failed");
  });
});
