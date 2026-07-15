import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { defaultClaudexorTools, serveClaudexorMcp, type McpTool, type RunnerFn } from "./index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Drive the REAL stdio wire (newline JSON-RPC over streams) against the served factory. */
function wire(tools: McpTool[], opts: { version?: string } = {}) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const handle = serveClaudexorMcp({
    version: opts.version ?? "0.0.0-test",
    tools,
    transport: { read: c2s, write: s2c },
  });
  const responses: any[] = [];
  const requests: any[] = [];
  const rl = createInterface({ input: s2c });
  rl.on("line", (l) => {
    if (!l.trim()) return;
    const msg = JSON.parse(l);
    if (msg.method) requests.push(msg);
    else responses.push(msg);
  });
  const send = (obj: unknown): void => {
    c2s.write(JSON.stringify(obj) + "\n");
  };
  const initialize = async (extraCapabilities: Record<string, unknown> = {}): Promise<void> => {
    send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: extraCapabilities,
        clientInfo: { name: "test-host", version: "1.0" },
      },
    });
    await sleep(80);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(20);
  };
  return { send, initialize, responses, requests, close: () => handle.close() };
}

describe("Claudexor MCP server (SDK v2)", () => {
  it("negotiates the client's 2025-06-18 era, lists 14 tools, and answers PING during a slow call", async () => {
    const tools = defaultClaudexorTools(async (p) => {
      if (p.mode === "agent") {
        await sleep(500);
        return {
          summary: "slow done",
          runId: "run-slow",
          runDir: "/tmp/run-slow",
          status: "succeeded",
        };
      }
      return { summary: `ran in ${p.mode} mode` };
    });
    const w = wire(tools);
    await w.initialize();
    w.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await sleep(60);
    // The old hand-rolled loop awaited each call inline: a multi-minute race
    // blocked ping/tools/list. The SDK dispatches concurrently —
    // the ping MUST answer while the slow tools/call is still running.
    w.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    await sleep(80);
    w.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    await sleep(120);
    expect(w.responses.some((r) => r.id === 4)).toBe(true);
    expect(w.responses.some((r) => r.id === 3)).toBe(false); // still running
    await sleep(500);
    await w.close();

    const init = w.responses.find((r) => r.id === "init");
    expect(init?.result?.protocolVersion).toBe("2025-06-18");
    expect(init?.result?.serverInfo?.name).toBe("claudexor");
    expect(w.responses.find((r) => r.id === 2)?.result?.tools).toHaveLength(14);
    const call = w.responses.find((r) => r.id === 3);
    expect(call?.result?.content?.[0]?.text).toContain("slow done");
  });

  it("returns the run SUMMARY plus the runId/artifacts trailer (hosts get a handle)", async () => {
    const tools = defaultClaudexorTools(async () => ({
      runId: "r1",
      runDir: "/tmp/r1",
      status: "succeeded",
      summary: "Did the thing.",
      winner: "A",
    }));
    const w = wire(tools);
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    await sleep(120);
    await w.close();

    const text = w.responses.find((r) => r.id === 1)?.result?.content?.[0]?.text as string;
    // Summary first, then the artifact handle — an MCP host must be able to
    // inspect/apply/follow the run it just started (the
    // old "never contains runId" pin is deliberately retired).
    expect(text.startsWith("Did the thing.")).toBe(true);
    expect(text).toContain("runId: r1");
    expect(text).toContain("artifacts: /tmp/r1");
    expect(text).toContain("status: succeeded");
    // Still never a raw JSON dump of the internal run object.
    expect(text).not.toContain("winner");
    expect(text).not.toContain("{");
  });

  it("no-argument tools (status/capabilities) are callable with {} — prompt is required only where the schema requires it", async () => {
    // The capabilities tool declares the FULL catalog outputSchema, so the
    // fake must return a schema-valid catalog (an invalid one is an isError —
    // that strictness is the point of declared structured outputs).
    const fakeCatalog = {
      ok: true,
      version: "0.0.0-test",
      generatedAt: new Date().toISOString(),
      harnesses: [],
      availableHarnesses: [],
      modes: ["ask", "plan", "audit", "agent", "orchestrate"],
      runControlKeys: ["prompt"],
      mutability: {
        readOnlyModes: ["ask", "plan", "audit"],
        writeModes: ["agent", "orchestrate"],
        isolationKinds: ["envelope", "live"],
        workspaceModes: ["in_place", "isolated"],
        accessProfiles: [
          "readonly",
          "workspace_write",
          "full",
          "external_sandbox_full",
          "inherit_native",
        ],
        applyModes: ["apply", "commit", "branch", "pr"],
      },
      cliCommands: [{ id: "ask", mutability: "read", stability: "stable", recovery: false }],
      mcpTools: ["claudexor_ask"],
      runApplyStates: ["not_applied", "applied", "applied_review_blocked", "reverted"],
    };
    const tools = defaultClaudexorTools(async (p) => {
      if (p.mode === "__status") return { harnesses: [], available: [] };
      if (p.mode === "__capabilities") return fakeCatalog;
      return { summary: "unexpected" };
    });
    const w = wire(tools);
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_capabilities", arguments: {} },
    });
    w.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "claudexor_status", arguments: {} },
    });
    await sleep(150);
    await w.close();
    const cap = w.responses.find((r) => r.id === 1);
    expect(cap?.result?.isError).not.toBe(true);
    expect(String(cap?.result?.content?.[0]?.text ?? "")).toContain("0.0.0-test");
    const status = w.responses.find((r) => r.id === 2);
    expect(status?.result?.isError).not.toBe(true);
  });

  it("rejects invalid tool arguments as isError tool results before invoking the runner", async () => {
    let calls = 0;
    const tools = defaultClaudexorTools(async () => {
      calls += 1;
      return "should not run";
    });
    const raceSchema = tools.find((t) => t.name === "claudexor_best_of")?.inputSchema as any;
    const runSchema = tools.find((t) => t.name === "claudexor_run")?.inputSchema as any;
    const statusSchema = tools.find((t) => t.name === "claudexor_status")?.inputSchema as any;
    expect(runSchema?.additionalProperties).toBe(false);
    expect(runSchema?.properties?.prompt?.pattern).toBe("\\S");
    expect(raceSchema?.properties?.n?.type).toBe("integer");
    expect(raceSchema?.properties?.n?.minimum).toBe(2);
    expect(statusSchema?.additionalProperties).toBe(false);

    const w = wire(tools);
    await w.initialize();
    const secretLike = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";
    const invalidCalls = [
      { id: 1, name: "claudexor_run", arguments: {} },
      { id: 2, name: "claudexor_run", arguments: { prompt: "" } },
      { id: 3, name: "claudexor_run", arguments: { prompt: "   " } },
      { id: 4, name: "claudexor_run", arguments: { prompt: "go", repoPath: "relative" } },
      { id: 5, name: "claudexor_run", arguments: { prompt: "go", n: 1.5 } },
      { id: 6, name: "claudexor_run", arguments: { prompt: "go", extra: true } },
      { id: 7, name: "claudexor_best_of", arguments: { prompt: "go", n: 1 } },
      { id: 8, name: "claudexor_run", arguments: { prompt: "go", tests: "pnpm test" } },
      {
        id: 9,
        name: "claudexor_run",
        arguments: { prompt: "go", reviewerPanel: [{ harness: "" }] },
      },
      {
        id: 10,
        name: "claudexor_run",
        arguments: {
          prompt: "go",
          reviewerPanel: [{ harness: "claude", authPreference: "api_key" }],
        },
      },
      { id: 11, name: "claudexor_run", arguments: { prompt: "go", maxUsd: -1 } },
      {
        id: 12,
        name: "claudexor_run",
        arguments: { prompt: "go", protectedPathApprovals: [{ reason: "missing path" }] },
      },
      {
        id: 13,
        name: "claudexor_run",
        arguments: { prompt: "go", reviewerModels: { opneai: "gpt-5.5" } },
      },
      {
        id: 14,
        name: "claudexor_run",
        arguments: { prompt: "go", reviewerEfforts: { opneai: "xhigh" } },
      },
      { id: 15, name: "claudexor_run", arguments: { prompt: "go", effort: "turbo" } },
      { id: 16, name: "claudexor_run", arguments: { prompt: "go", web: "internet" } },
      { id: 17, name: "claudexor_run", arguments: { prompt: "go", harness: "" } },
      { id: 18, name: "claudexor_run", arguments: { prompt: "go", primaryHarness: " " } },
      { id: 19, name: "claudexor_run", arguments: { prompt: "go", model: "" } },
      {
        id: 20,
        name: "claudexor_run",
        arguments: { prompt: "go", reviewerPanel: [{ harness: "claude", model: secretLike }] },
      },
      {
        id: 21,
        name: "claudexor_run",
        arguments: { prompt: "go", tests: [{ program: "echo", args: [secretLike] }] },
      },
      {
        id: 22,
        name: "claudexor_run",
        arguments: { prompt: "go", protectedPathApprovals: [{ path: secretLike }] },
      },
      // The prompt hard block: a secret-like value INSIDE the prompt is
      // refused on the MCP surface too (prompts are durable artifacts).
      { id: 23, name: "claudexor_run", arguments: { prompt: `deploy with ${secretLike}` } },
      { id: 24, name: "claudexor_ask", arguments: { prompt: `explain ${secretLike}` } },
    ];
    for (const call of invalidCalls) {
      w.send({
        jsonrpc: "2.0",
        id: call.id,
        method: "tools/call",
        params: { name: call.name, arguments: call.arguments },
      });
    }
    await sleep(250);
    await w.close();

    expect(calls).toBe(0);
    const results = invalidCalls.map((c) => w.responses.find((r) => r.id === c.id));
    expect(results.every((r) => r !== undefined)).toBe(true);
    // The official SDK's contract: argument failures are isError TOOL results
    // (its own structural validation behaves the same), not -32602 protocol
    // errors — assert the STRICT shape so a silent contract change fails.
    expect(results.every((r) => r.result?.isError === true)).toBe(true);
    const textOf = (id: number): string => {
      const r = w.responses.find((x) => x.id === id);
      return String(r?.result?.content?.[0]?.text ?? r?.error?.message ?? "");
    };
    expect(textOf(20)).toContain("secret-like value is not accepted");
    expect(textOf(21)).toContain("secret-like value is not accepted");
    expect(textOf(22)).toContain("secret-like value is not accepted");
    // Prompt block carries the tailored durable-artifact remediation AND the
    // machine-readable class prefix (text contract until structured outputs).
    expect(textOf(23)).toContain("durable run artifacts");
    expect(textOf(23)).toContain("inline_secret_rejected");
    expect(textOf(24)).toContain("durable run artifacts");
    expect(textOf(24)).toContain("inline_secret_rejected");
  });

  it("run tools return structuredContent mirroring the text (summary, handles, applyEligibility)", async () => {
    const tools = defaultClaudexorTools(async () => ({
      runId: "r-s1",
      runDir: "/tmp/r-s1",
      status: "succeeded",
      summary: "Did the thing.",
      applyEligibility: {
        eligible: false,
        state: "blocked",
        reason: "review found blockers",
        requiredAction: "decision",
      },
    }));
    const w = wire(tools);
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    await sleep(150);
    await w.close();
    const res = w.responses.find((r) => r.id === 1)?.result;
    expect(res?.isError).not.toBe(true);
    const sc = res?.structuredContent as Record<string, any>;
    expect(sc?.summary).toBe("Did the thing.");
    expect(sc?.runId).toBe("r-s1");
    expect(sc?.status).toBe("succeeded");
    expect(sc?.applyEligibility?.eligible).toBe(false);
    expect(sc?.applyEligibility?.requiredAction).toBe("decision");
    // Read-only vs mutating annotations ride tools/list.
    const w2 = wire(tools);
    await w2.initialize();
    w2.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await sleep(80);
    await w2.close();
    const list = w2.responses.find((r) => r.id === 2)?.result?.tools as Array<Record<string, any>>;
    const byName = Object.fromEntries(list.map((t) => [t.name, t]));
    expect(byName["claudexor_ask"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_orchestrate"]?.annotations?.readOnlyHint).toBe(true); // MCP orchestrate is suggest-only
    expect(byName["claudexor_run"]?.annotations?.readOnlyHint).toBe(false);
    expect(byName["claudexor_apply_check"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_run"]?.outputSchema).toBeTruthy();
  });

  it("bridges engine interactions to MCP elicitation and maps answers back", async () => {
    let receivedAnswers: any = null;
    const runner: RunnerFn = async (_p, hooks) => {
      receivedAnswers = await hooks?.onInteraction?.({
        request: {
          interaction_id: "int-1",
          questions: [
            {
              id: "q1",
              question: "Pick one",
              header: null,
              options: [
                { label: "A", description: null },
                { label: "B", description: "second" },
              ],
              multi_select: false,
            },
            { id: "q2", question: "Say more", header: "Detail", options: [], multi_select: false },
          ],
        },
        timeoutAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return { summary: "asked and answered" };
    };
    const tools = defaultClaudexorTools(runner);
    const w = wire(tools);
    // Declare the elicitation capability so the SDK allows elicitInput.
    await w.initialize({ elicitation: {} });
    w.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    // Answer each incoming elicitation/create server request over the wire.
    const answered = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      await sleep(50);
      for (const req of w.requests) {
        if (req.method === "elicitation/create" && !answered.has(String(req.id))) {
          answered.add(String(req.id));
          const isChoice = JSON.stringify(req.params).includes("Pick one");
          w.send({
            jsonrpc: "2.0",
            id: req.id,
            result: { action: "accept", content: { answer: isChoice ? "B" : "because reasons" } },
          });
        }
      }
      if (w.responses.some((r) => r.id === 9)) break;
    }
    await w.close();

    expect(w.responses.find((r) => r.id === 9)?.result?.content?.[0]?.text).toContain(
      "asked and answered",
    );
    expect(receivedAnswers).toEqual({
      interaction_id: "int-1", // typed InteractionAnswerSet parity with ACP/daemon
      answers: [
        { question_id: "q1", selected_labels: ["B"], free_text: null },
        { question_id: "q2", selected_labels: [], free_text: "because reasons" },
      ],
    });
  });

  it("resolves interactions as DECLINED (null) when the host lacks the elicitation capability", async () => {
    let sawHooks: unknown = "unset";
    const runner: RunnerFn = async (_p, hooks) => {
      sawHooks = hooks?.onInteraction ?? null;
      return { summary: "ok" };
    };
    const tools = defaultClaudexorTools(runner);
    const w = wire(tools);
    await w.initialize(); // no elicitation capability
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    await sleep(150);
    await w.close();
    // No capability -> no bridge is offered at all; the engine's own
    // timeout-decline fallback stays in charge (never a fake answer).
    expect(sawHooks).toBeNull();
  });

  it("host notifications/cancelled aborts the runner's signal (typed cancel, like Ctrl-C)", async () => {
    let sawAbort = false;
    const runner: RunnerFn = async (_p, hooks) =>
      new Promise((resolve) => {
        const signal = hooks?.signal;
        if (!signal) {
          resolve({ summary: "no signal offered" });
          return;
        }
        const timer = setTimeout(() => resolve({ summary: "never cancelled" }), 5_000);
        signal.addEventListener("abort", () => {
          sawAbort = true;
          clearTimeout(timer);
          resolve({ summary: "aborted" });
        });
      });
    const w = wire(defaultClaudexorTools(runner));
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "claudexor_run", arguments: { prompt: "go" } },
    });
    await sleep(150);
    w.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "host cancelled" },
    });
    for (let i = 0; i < 40 && !sawAbort; i += 1) await sleep(50);
    await w.close();
    expect(sawAbort).toBe(true);
  });

  it("exposes advanced run controls and forwards them to the runner", async () => {
    let received: any = null;
    const tools = defaultClaudexorTools(async (p) => {
      received = p;
      return { summary: "ok" };
    });
    const runTool = tools.find((t) => t.name === "claudexor_run");
    const schema = runTool?.inputSchema as any;
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.properties?.reviewerPanel?.type).toBe("array");
    expect(schema?.properties?.reviewerPanel?.minItems).toBe(1);
    expect(schema?.properties?.reviewerPanel?.items?.properties?.authPreference).toBeUndefined();
    expect(schema?.properties?.model?.type).toBe("string");
    expect(schema?.properties?.model?.minLength).toBe(1);
    expect(schema?.properties?.harness?.minLength).toBe(1);
    expect(schema?.properties?.primaryHarness?.minLength).toBe(1);
    expect(schema?.properties?.effort?.enum).toContain("xhigh");
    expect(schema?.properties?.web?.enum).toContain("live");
    expect(schema?.properties?.externalContextPolicy?.enum).toContain("cached");
    expect(schema?.properties?.reviewerModels?.type).toBe("object");
    expect(schema?.properties?.reviewerModels?.additionalProperties).toBe(false);
    expect(schema?.properties?.reviewerModels?.properties?.openai?.type).toBe("string");
    expect(schema?.properties?.reviewerEfforts?.type).toBe("object");
    expect(schema?.properties?.reviewerEfforts?.additionalProperties).toBe(false);
    expect(schema?.properties?.reviewerEfforts?.properties?.openai?.enum).toContain("xhigh");
    expect(schema?.properties?.tests?.type).toBe("array");
    expect(schema?.properties?.maxUsd?.type).toBe("number");
    expect(schema?.properties?.access?.enum).toContain("workspace_write");
    expect(schema?.properties?.protectedPathApprovals?.items?.required).toEqual(["path"]);

    await runTool?.handler(
      {
        prompt: "go",
        reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8" }],
        model: "gpt-5.5",
        effort: "xhigh",
        web: "live",
        reviewerModels: { openai: "gpt-5.5" },
        reviewerEfforts: { openai: "xhigh" },
        tests: [{ program: "pnpm", args: ["test"] }],
        maxUsd: 3,
        access: "workspace_write",
        protectedPathApprovals: [{ path: "test/**" }],
      },
      { elicit: null },
    );

    expect(received).toMatchObject({
      mode: "agent",
      prompt: "go",
      reviewerPanel: [{ harness: "claude", model: "claude-opus-4.8" }],
      model: "gpt-5.5",
      effort: "xhigh",
      web: "live",
      reviewerModels: { openai: "gpt-5.5" },
      reviewerEfforts: { openai: "xhigh" },
      tests: [{ program: "pnpm", args: ["test"] }],
      maxUsd: 3,
      access: "workspace_write",
      protectedPathApprovals: [{ path: "test/**" }],
    });
  });

  it("warns on stderr when the plugin artifact version does not match the CLI", async () => {
    const prev = process.env["CLAUDEXOR_PLUGIN_VERSION"];
    process.env["CLAUDEXOR_PLUGIN_VERSION"] = "0.1.0";
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      chunks.push(String(chunk));
      return origWrite(chunk, ...rest);
    };
    try {
      const w = wire(
        defaultClaudexorTools(async () => "ok"),
        { version: "0.2.0" },
      );
      await w.close();
    } finally {
      (process.stderr as any).write = origWrite;
      if (prev === undefined) delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
      else process.env["CLAUDEXOR_PLUGIN_VERSION"] = prev;
    }
    expect(chunks.join("")).toContain("plugin artifacts are version 0.1.0 but the CLI is 0.2.0");
  });
});
