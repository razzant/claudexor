import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { makeOutcomeFacts, SCHEMA_VERSION, validateRunFactsInvariants } from "@claudexor/schema";
import { defaultClaudexorTools, serveClaudexorMcp, type McpTool, type RunnerFn } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function validPlanRunFacts(runId: string) {
  return validateRunFactsInvariants({
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: `task-${runId}`,
    mode: "plan",
    outcome: makeOutcomeFacts("succeeded"),
    deliverable: {
      present: true,
      kind: "plan",
      path: "final/plan.md",
      producer_attempt_id: "p01",
    },
    participants: {
      planners: 1,
      attempts: [
        {
          attempt_id: "p01",
          harness_id: "codex",
          role: "planner",
          deliverable_present: true,
          status: "success",
        },
      ],
    },
    gates: {
      configured: false,
      required: 0,
      total: 0,
      executed: false,
      state: "not_configured",
      receipt_attempt_id: null,
    },
    review: { state: "not_run", blocker_ids: [], blockers: 0 },
    apply: { eligibility: null, operator_decision_present: false },
    required_actions: [],
    generated_at: "2026-08-14T00:00:00.000Z",
  });
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

async function wireToolCall(tools: McpTool[], name: string, args: Record<string, unknown>) {
  const w = wire(tools);
  await w.initialize();
  w.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  await sleep(120);
  await w.close();
  return w.responses.find((response) => response.id === 1)?.result;
}

describe("Claudexor MCP server (SDK v2)", () => {
  it("negotiates the client's 2025-06-18 era, lists 20 tools, and answers PING during a slow call", async () => {
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
    expect(w.responses.find((r) => r.id === 2)?.result?.tools).toHaveLength(20);
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

  it("marks belt policy refusals and non-success child terminals as MCP errors", async () => {
    const policy = {
      parentRunId: "run-parent",
      repoRoot: "/tmp/project",
      depth: 0,
      maxSubRuns: 8,
      parentBudget: { kind: "unlimited" as const },
    };
    const denied = await wireToolCall(
      beltClaudexorTools(async () => ({ status: "succeeded" }), { ...policy, depth: 1 }),
      "claudexor_run",
      { prompt: "x" },
    );
    expect(denied?.isError).toBe(true);
    expect(denied?.content?.[0]?.text).toMatch(/delegation refused.*depth 1/i);

    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      const result = await wireToolCall(
        beltClaudexorTools(async () => ({ runId: `child-${status}`, status, spendUsd: 0 }), policy),
        "claudexor_run",
        { prompt: "x" },
      );
      expect(result?.isError).toBe(true);
      expect(result?.content?.[0]?.text).toMatch(new RegExp(`child-${status}.*${status}`, "i"));
    }

    const succeeded = await wireToolCall(
      beltClaudexorTools(
        async () => ({ runId: "child-ok", status: "succeeded", spendUsd: 0 }),
        policy,
      ),
      "claudexor_run",
      { prompt: "x" },
    );
    expect(succeeded?.isError).not.toBe(true);
    expect(succeeded?.content?.[0]?.text).toContain("status: succeeded");

    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: null,
      logRefs: [],
      eventRefs: [],
      runDir: "/tmp/child-failed",
      nextActions: ["Log in again"],
    };
    const failedRead = await wireToolCall(
      beltClaudexorTools(
        async () => ({ runId: "child-failed", status: "failed", failure }),
        policy,
      ),
      "claudexor_run_result",
      { runId: "child-failed" },
    );
    expect(failedRead?.isError).not.toBe(true);
    expect(failedRead?.content?.[0]?.text).toContain("status: failed");
    expect(failedRead?.structuredContent?.failure).toEqual(failure);
  });

  it("no-argument tools (status/capabilities) are callable with {} — prompt is required only where the schema requires it", async () => {
    // The capabilities tool declares the FULL catalog outputSchema, so the
    // fake must return a schema-valid current catalog.
    const fakeCatalog = {
      ok: true,
      version: "0.0.0-test",
      generatedAt: new Date().toISOString(),
      git: { status: "available", version: "git version 2.51.0", detail: null, remediation: null },
      harnesses: [],
      availableHarnesses: [],
      modes: ["ask", "plan", "agent"],
      runControlKeys: ["prompt"],
      outputSchemaDialects: [
        {
          dialect: "draft-07",
          uri: "http://json-schema.org/draft-07/schema#",
          defaultWhenOmitted: true,
        },
        {
          dialect: "draft-2020-12",
          uri: "https://json-schema.org/draft/2020-12/schema",
          defaultWhenOmitted: false,
        },
      ],
      mutability: {
        readOnlyModes: ["ask", "plan"],
        writeModes: ["agent"],
        isolationKinds: ["envelope", "live"],
        workspaceModes: ["in_place", "isolated"],
        accessProfiles: ["readonly", "workspace_write", "full", "inherit_native"],
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
    const askSchema = tools.find((t) => t.name === "claudexor_ask")?.inputSchema as any;
    const planSchema = tools.find((t) => t.name === "claudexor_plan")?.inputSchema as any;
    const statusSchema = tools.find((t) => t.name === "claudexor_status")?.inputSchema as any;
    expect(runSchema?.additionalProperties).toBe(false);
    expect(runSchema?.properties?.prompt?.pattern).toBe("\\S");
    expect(raceSchema?.properties?.n?.type).toBe("integer");
    expect(raceSchema?.properties?.n?.minimum).toBe(2);
    expect(statusSchema?.additionalProperties).toBe(false);
    expect(askSchema?.properties?.deepScan?.type).toBe("boolean");
    expect(askSchema?.properties).not.toHaveProperty("tests");
    expect(askSchema?.properties).not.toHaveProperty("council");
    expect(planSchema?.properties?.council?.type).toBe("boolean");
    expect(planSchema?.properties).not.toHaveProperty("tests");
    expect(planSchema?.properties).not.toHaveProperty("deepScan");
    expect(runSchema?.properties?.tests?.type).toBe("array");
    expect(runSchema?.properties?.credentialProfileId).toMatchObject({
      type: "string",
      pattern: "\\S",
    });
    expect(runSchema?.properties).not.toHaveProperty("deepScan");
    expect(runSchema?.properties).not.toHaveProperty("council");

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
      {
        id: 11,
        name: "claudexor_run",
        arguments: { prompt: "go", paidBudget: { kind: "finite", maxUsd: -1 } },
      },
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
      { id: 15, name: "claudexor_run", arguments: { prompt: "go", effort: "TURBO BOOST" } },
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
      { id: 25, name: "claudexor_run", arguments: { prompt: "go", deepScan: true } },
      { id: 26, name: "claudexor_ask", arguments: { prompt: "go", council: true } },
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

  it("exposes persistent thread tools with strict route controls and durable handles", async () => {
    const calls: Record<string, unknown>[] = [];
    const tools = defaultClaudexorTools(async (params) => {
      calls.push(params);
      return params.mode === "__thread_create"
        ? { summary: "created", threadId: "th-1", title: "Audit" }
        : {
            summary: "queued",
            threadId: "th-1",
            turnId: "turn-1",
            runId: "run-1",
            state: "queued",
          };
    });
    const create = tools.find((tool) => tool.name === "claudexor_thread_create")!;
    const turn = tools.find((tool) => tool.name === "claudexor_thread_turn")!;

    expect(create.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["repoPath"],
      properties: { credentialProfileId: { type: "string", pattern: "\\S" } },
    });
    expect(turn.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["threadId", "prompt"],
      properties: {
        model: { type: "string", pattern: "\\S" },
        credentialProfileId: { type: "string", pattern: "\\S" },
      },
    });

    const created = await wireToolCall(tools, create.name, {
      repoPath: "/tmp/project",
      credentialProfileId: "work-secondary",
    });
    const queued = await wireToolCall(tools, turn.name, {
      threadId: "th-1",
      prompt: "continue",
      model: "gpt-6-sol",
      credentialProfileId: "work-secondary",
    });
    const refused = await wireToolCall(tools, create.name, { repoPath: "relative" });

    expect(created?.structuredContent).toMatchObject({ threadId: "th-1" });
    expect(queued?.structuredContent).toMatchObject({
      threadId: "th-1",
      turnId: "turn-1",
      runId: "run-1",
    });
    expect(refused?.isError).toBe(true);
    expect(calls).toEqual([
      {
        mode: "__thread_create",
        repoPath: "/tmp/project",
        credentialProfileId: "work-secondary",
      },
      {
        mode: "__thread_turn",
        threadId: "th-1",
        prompt: "continue",
        model: "gpt-6-sol",
        credentialProfileId: "work-secondary",
      },
    ]);
  });

  it("preserves typed thread failures on the MCP wire", async () => {
    const error = Object.assign(new Error("thread is busy"), {
      code: "thread_busy",
      retryable: true,
      requiredActions: ["wait for the active turn"],
      context: { threadId: "th-1" },
    });
    const result = await wireToolCall(
      defaultClaudexorTools(async () => {
        throw error;
      }),
      "claudexor_thread_turn",
      { threadId: "th-1", prompt: "continue" },
    );

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual({
      status: "failed",
      failure: {
        message: "thread is busy",
        code: "thread_busy",
        retryable: true,
        requiredActions: ["wait for the active turn"],
        context: { threadId: "th-1" },
      },
    });
  });

  it("redacts and bounds thread failures before they cross the MCP wire", async () => {
    const secret = `sk-${"x".repeat(40)}`;
    const error = Object.assign(new Error(`failed with ${secret}`), {
      code: "thread_failed",
      fieldErrors: { prompt: [`contains ${secret}`] },
      requiredActions: [`remove ${secret}`],
      details: { nested: { token: secret } },
      context: { stderr: `${secret}${"x".repeat(3_000)}` },
    });
    const result = await wireToolCall(
      defaultClaudexorTools(async () => {
        throw error;
      }),
      "claudexor_thread_turn",
      { threadId: "th-1", prompt: "continue" },
    );
    const failure = result?.structuredContent?.failure as Record<string, unknown>;

    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).toContain("[redacted]");
    expect(JSON.stringify(failure).length).toBeLessThan(12_000);
  });

  it("run tools return structuredContent mirroring the text (summary, handles, applyEligibility)", async () => {
    const runFacts = validPlanRunFacts("r-s1");
    const tools = defaultClaudexorTools(async () => ({
      runId: "r-s1",
      runDir: "/tmp/r-s1",
      status: "succeeded",
      summary: "Did the thing.",
      runFacts,
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
    expect(sc?.runFacts).toEqual(runFacts);
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
    for (const name of [
      "claudexor_ask",
      "claudexor_plan",
      "claudexor_run",
      "claudexor_best_of",
      "claudexor_create",
    ]) {
      expect(byName[name]?.description).toContain("durable run handle");
      expect(byName[name]?.description).not.toContain("Returns final output");
    }
    expect(byName["claudexor_ask"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_run"]?.annotations?.readOnlyHint).toBe(false);
    expect(byName["claudexor_apply_check"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_run_status"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_run_result"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_accounts"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["claudexor_run_cancel"]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(byName["claudexor_run"]?.outputSchema).toBeTruthy();
  });

  it("an immediate failed run tool preserves typed failure detail on the MCP wire", async () => {
    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: null,
      logRefs: [],
      eventRefs: [],
      runDir: "/tmp/r-failed",
      nextActions: ["Log in again"],
    };
    const tools = defaultClaudexorTools(async () => ({
      runId: "r-failed",
      runDir: "/tmp/r-failed",
      status: "failed",
      summary: "Run failed.",
      failure,
    }));

    const result = await wireToolCall(tools, "claudexor_run", { prompt: "go" });

    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent?.status).toBe("failed");
    expect(result?.structuredContent?.failure).toEqual(failure);
  });

  it("plan run tools carry the outcome banner + plan readiness in structuredContent", async () => {
    const tools = defaultClaudexorTools(async () => ({
      runId: "r-plan",
      runDir: "/tmp/r-plan",
      status: "succeeded",
      summary: "Drafted a plan.",
      outcomeBanner: "Plan drafted — 2 open questions",
      planReadiness: { state: "needs_answers", questionCount: 2 },
    }));
    const w = wire(tools);
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_plan", arguments: { prompt: "plan it" } },
    });
    await sleep(150);
    await w.close();
    const res = w.responses.find((r) => r.id === 1)?.result;
    // The SDK validates structuredContent against the DECLARED outputSchema;
    // isError:true here would mean the new fields drifted from the schema.
    expect(res?.isError).not.toBe(true);
    const sc = res?.structuredContent as Record<string, any>;
    expect(sc?.outcomeBanner).toBe("Plan drafted — 2 open questions");
    expect(sc?.planReadiness?.state).toBe("needs_answers");
    expect(sc?.planReadiness?.questionCount).toBe(2);
  });

  it("read tools (inspect/status/result) declare a typed outputSchema and validate their result", async () => {
    // A schema-valid McpRunHandleResult passes; the SDK strictly validates
    // structuredContent against the declared outputSchema, so conformance is
    // enforced by the wire itself.
    const runFacts = validPlanRunFacts("r-h1");
    const handle = {
      summary: "run r-h1: succeeded",
      runId: "r-h1",
      runDir: "/tmp/r-h1",
      status: "succeeded",
      runFacts,
      decisionStatus: "approved",
      pendingInteractions: 0,
      outcomeFacts: null,
      outcomeBanner: "Applied",
      applyEligibility: { eligible: true, state: "verified", reason: null, requiredAction: null },
      planReadiness: null,
      detailProblem: { code: "detail_unavailable", message: "retry later", retryable: true },
    };
    const tools = defaultClaudexorTools(async () => handle);
    const list = tools.filter((t) =>
      ["claudexor_inspect", "claudexor_run_status", "claudexor_run_result"].includes(t.name),
    );
    expect(list).toHaveLength(3);
    for (const tool of list) expect(tool.outputSchema).toBeTruthy();

    for (const name of ["claudexor_inspect", "claudexor_run_status", "claudexor_run_result"]) {
      const w = wire(tools);
      await w.initialize();
      w.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { runId: "r-h1" } },
      });
      await sleep(120);
      await w.close();
      const res = w.responses.find((r) => r.id === 1)?.result;
      expect(res?.isError, `${name} result should conform to its outputSchema`).not.toBe(true);
      const sc = res?.structuredContent as Record<string, any>;
      expect(sc?.runId).toBe("r-h1");
      expect(sc?.runFacts).toEqual(runFacts);
      expect(sc?.applyEligibility?.eligible).toBe(true);
      expect(sc?.detailProblem?.code).toBe("detail_unavailable");
    }
  });

  it("inspect/status/result preserve typed failed-handle detail on the MCP wire", async () => {
    const failure = {
      phase: "execute",
      category: "harness_error",
      code: null,
      harnessId: "codex",
      attemptId: "a02",
      safeMessage: "Harness exited before producing a result",
      rawDetailRef: "attempts/a02/failure.json",
      logRefs: ["attempts/a02/stderr.log"],
      eventRefs: ["evt-failed"],
      runDir: "/tmp/r-handle-failed",
      nextActions: ["Inspect the attempt log"],
    };
    const handle = {
      summary: "run r-handle-failed: failed",
      runId: "r-handle-failed",
      runDir: "/tmp/r-handle-failed",
      status: "failed",
      decisionStatus: null,
      pendingInteractions: 0,
      outcomeFacts: null,
      failure,
      outcomeBanner: "Harness failed",
      applyEligibility: null,
      planReadiness: null,
    };
    const tools = defaultClaudexorTools(async () => handle);

    for (const name of ["claudexor_inspect", "claudexor_run_status", "claudexor_run_result"]) {
      const result = await wireToolCall(tools, name, { runId: "r-handle-failed" });
      expect(result?.isError, `${name} failure should conform to its outputSchema`).not.toBe(true);
      expect(result?.structuredContent?.status).toBe("failed");
      expect(result?.structuredContent?.failure).toEqual(failure);
    }
  });

  it("a council plan carries its membership roster in structuredContent (QA-023b)", async () => {
    // The SDK strict-validates structuredContent against the declared
    // outputSchema, so a council roster surviving here proves the McpRunToolResult
    // schema carries it AND the structured mirror projects it — an MCP host can
    // machine-verify "Council was 2/2, merged by cursor" with no local artifacts.
    const tools = defaultClaudexorTools(async () => ({
      runId: "r-council",
      runDir: "/tmp/r-council",
      status: "succeeded",
      summary: "Council drafted a plan.",
      council: {
        requested: 2,
        drafted: 2,
        degraded: false,
        mergedBy: "cursor",
        members: [
          { harnessId: "cursor", role: "primary", status: "merged" },
          { harnessId: "codex", role: "member", status: "drafted" },
        ],
      },
    }));
    const w = wire(tools);
    await w.initialize();
    w.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "claudexor_plan", arguments: { prompt: "plan it", council: true } },
    });
    await sleep(150);
    await w.close();
    const res = w.responses.find((r) => r.id === 1)?.result;
    expect(res?.isError).not.toBe(true);
    const sc = res?.structuredContent as Record<string, any>;
    expect(sc?.council?.requested).toBe(2);
    expect(sc?.council?.drafted).toBe(2);
    expect(sc?.council?.mergedBy).toBe("cursor");
    expect(sc?.council?.members).toHaveLength(2);
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
    expect(schema?.properties?.reviewerPanel?.items?.properties?.credentialProfileId).toMatchObject(
      {
        type: "string",
        minLength: 1,
      },
    );
    expect(schema?.properties?.model?.type).toBe("string");
    expect(schema?.properties?.model?.minLength).toBe(1);
    expect(schema?.properties?.harness?.minLength).toBe(1);
    expect(schema?.properties?.primaryHarness?.minLength).toBe(1);
    // The MCP effort surface is OPEN by design: pinning an enum here would
    // reject a level a model genuinely advertises. It carries the slug SHAPE,
    // and its description points at the vendor-advertised ladders instead of
    // naming any level list of its own (there is no static rank table).
    expect(schema?.properties?.effort?.enum).toBeUndefined();
    expect(schema?.properties?.effort?.type).toBe("string");
    expect(schema?.properties?.effort?.pattern).toBeTruthy();
    expect(schema?.properties?.effort?.description).toContain(
      "level the resolved harness/model advertises",
    );
    expect(schema?.properties?.web?.enum).toContain("live");
    expect(schema?.properties?.externalContextPolicy?.enum).toContain("cached");
    expect(schema?.properties?.reviewerModels?.type).toBe("object");
    expect(schema?.properties?.reviewerModels?.additionalProperties).toBe(false);
    expect(schema?.properties?.reviewerModels?.properties?.openai?.type).toBe("string");
    expect(schema?.properties?.reviewerEfforts?.type).toBe("object");
    expect(schema?.properties?.reviewerEfforts?.additionalProperties).toBe(false);
    expect(schema?.properties?.reviewerEfforts?.properties?.openai?.type).toBe("string");
    expect(schema?.properties?.reviewerEfforts?.properties?.openai?.description).toContain(
      "level the resolved harness/model advertises",
    );
    expect(schema?.properties?.tests?.type).toBe("array");
    expect(schema?.properties?.paidBudget?.anyOf).toHaveLength(2);
    expect(schema?.properties?.access?.enum).toContain("workspace_write");
    expect(schema?.properties?.access?.enum).not.toContain("external_sandbox_full");
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
        paidBudget: { kind: "finite", maxUsd: 3 },
        access: "workspace_write",
        protectedPathApprovals: [{ path: "test/**" }],
      },
      {},
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
      paidBudget: { kind: "finite", maxUsd: 3 },
      access: "workspace_write",
      protectedPathApprovals: [{ path: "test/**" }],
    });
  });

  it("exposes the read-only Accounts doorway and returns the server snapshot unchanged", async () => {
    const snapshot = {
      profiles: [
        {
          profile: {
            profile_id: "work",
            harness_id: "claude",
            display_name: "work",
            credential_kind: "config_dir_login",
            isolation_locator: "/tmp/claudexor-review-profile",
          },
          status: {
            profile_id: "work",
            harness_id: "claude",
            availability: "available",
            verification: "passed",
          },
          identity: null,
        },
      ],
      harnesses: [{ id: "claude", status: "ok" }],
      git: { status: "available", version: null, detail: null, remediation: null },
      quota: { snapshots: [], refreshed_at: null },
      quotaEventCursor: "q-1",
      accountPools: [{ harness_id: "claude", next_up: { kind: "profile", profileId: "work" } }],
    };
    const calls: unknown[] = [];
    const tools = defaultClaudexorTools(async (params) => {
      calls.push(params);
      return snapshot;
    });
    const accounts = tools.find((tool) => tool.name === "claudexor_accounts");
    expect(accounts?.annotations?.readOnlyHint).toBe(true);
    // Contract change (owner decision 11=A): the DEFAULT read is the cached
    // credential-profiles listing; fresh:true opts into the expensive atomic
    // snapshot. The declared output schema is the honest union of both forms.
    expect(accounts?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { fresh: { type: "boolean" } },
    });
    expect(accounts?.description).toContain("CACHED");
    const members = accounts?.outputSchema?.anyOf as Array<Record<string, unknown>>;
    expect(members).toHaveLength(2);
    const [listing, atomic] = members.map((member) => member.properties as Record<string, unknown>);
    expect(listing).toMatchObject({ profiles: expect.any(Object) });
    expect(listing?.quotaEventCursor).toBeUndefined();
    expect(atomic).toMatchObject({
      harnesses: expect.any(Object),
      git: expect.any(Object),
      quota: expect.any(Object),
      quotaEventCursor: expect.any(Object),
      profiles: expect.any(Object),
    });
    const result = await accounts!.handler({}, {});
    expect(result).toMatchObject({ structured: snapshot });
    await accounts!.handler({ fresh: true }, {});
    await accounts!.handler({ fresh: false }, {});
    expect(calls).toEqual([
      { mode: "__accounts" },
      { mode: "__accounts", fresh: true },
      { mode: "__accounts" },
    ]);
  });

  it("REFUSES to serve when the plugin artifact version does not match the CLI", async () => {
    const prev = process.env["CLAUDEXOR_PLUGIN_VERSION"];
    process.env["CLAUDEXOR_PLUGIN_VERSION"] = "0.1.0";
    try {
      expect(() =>
        wire(
          defaultClaudexorTools(async () => "ok"),
          { version: "0.2.0" },
        ),
      ).toThrowError(
        /plugin_artifact_skew: .*version 0\.1\.0 but the CLI is 0\.2\.0.*plugin repair all/,
      );
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
      else process.env["CLAUDEXOR_PLUGIN_VERSION"] = prev;
    }
  });

  it("REFUSES a managed launch whose frozen config root is neither the default nor a marked explicit override", async () => {
    // vitest globally overrides CLAUDEXOR_CONFIG_DIR to a temp dir — exactly a
    // "legacy frozen foreign root" from the managed bridge's point of view.
    const prev = process.env["CLAUDEXOR_PLUGIN_VERSION"];
    process.env["CLAUDEXOR_PLUGIN_VERSION"] = "0.2.0";
    try {
      expect(() =>
        wire(
          defaultClaudexorTools(async () => "ok"),
          { version: "0.2.0" },
        ),
      ).toThrowError(/plugin_artifact_skew: .*foreign config root/);
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
      else process.env["CLAUDEXOR_PLUGIN_VERSION"] = prev;
    }
  });

  it("serves a managed launch whose non-default root carries the explicit-override marker", async () => {
    const prev = process.env["CLAUDEXOR_PLUGIN_VERSION"];
    const prevMode = process.env["CLAUDEXOR_ROOT_MODE"];
    process.env["CLAUDEXOR_PLUGIN_VERSION"] = "0.2.0";
    process.env["CLAUDEXOR_ROOT_MODE"] = "explicit";
    try {
      const w = wire(
        defaultClaudexorTools(async () => "ok"),
        { version: "0.2.0" },
      );
      await w.close();
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
      else process.env["CLAUDEXOR_PLUGIN_VERSION"] = prev;
      if (prevMode === undefined) delete process.env["CLAUDEXOR_ROOT_MODE"];
      else process.env["CLAUDEXOR_ROOT_MODE"] = prevMode;
    }
  });

  it("non-plugin launches (no CLAUDEXOR_PLUGIN_VERSION) are never skew-checked", async () => {
    const prev = process.env["CLAUDEXOR_PLUGIN_VERSION"];
    delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
    try {
      const w = wire(
        defaultClaudexorTools(async () => "ok"),
        { version: "0.2.0" },
      );
      await w.close();
    } finally {
      if (prev === undefined) delete process.env["CLAUDEXOR_PLUGIN_VERSION"];
      else process.env["CLAUDEXOR_PLUGIN_VERSION"] = prev;
    }
  });
});
