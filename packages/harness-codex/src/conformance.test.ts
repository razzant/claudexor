import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  streamExpectationViolations,
  validateTypedStream,
  type FixtureStreamExpectations,
  type LiveMessageResult,
  type spawnProcess,
} from "@claudexor/core";
import { HarnessRunSpec, type HarnessEvent } from "@claudexor/schema";
import {
  CodexAppServerController,
  codexAppServerEvents,
  runCodexAppServer,
} from "./app-server-run.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";
import { parse as parseYaml } from "yaml";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));
/** W3.8: per-fixture STREAM SEMANTICS expectations, declared next to the
 * fixture's provenance and asserted through the one core owner. */
const manifest = parseYaml(readFileSync(join(FIXTURES, "manifest.yaml"), "utf8")) as {
  fixtures: Record<string, { expectations?: FixtureStreamExpectations }>;
};

/**
 * Real codex stdout can TEAR lines under concurrent writes (observed live on
 * codex 0.137: a web_search item interleaved with an agent_message mid-string).
 * The shared run loop counts such lines as drops instead of failing the run;
 * the parity test mirrors that and bounds the damage.
 */
function parseLines(raw: string): {
  events: unknown[];
  invalidLines: number;
  recognizedLines: number;
} {
  let invalidLines = 0;
  let recognizedLines = 0;
  const events: unknown[] = [];
  // The run loop threads per-run finality state; the parity test must too —
  // without it codex's typed final (stamped on turn.completed) never exists
  // and the test could only check SHAPE, not finality semantics (W3.8).
  const state: CodexParseState = {};
  for (const line of raw.split("\n").filter(Boolean)) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      invalidLines += 1;
      continue;
    }
    const parsed = parseCodexEvent(obj, "ses-fixture", state);
    if (parsed === null) continue; // unrecognized type: counted by the run loop
    recognizedLines += 1;
    events.push(...parsed);
  }
  return { events, invalidLines, recognizedLines };
}

describe("codex adapter conformance fixtures", () => {
  it("maps recorded app-server retry notices to schema-valid nonterminal activity", () => {
    const events = readFileSync(join(FIXTURES, "app-server/retry-status-0.156.1.jsonl"), "utf8")
      .trim()
      .split("\n")
      .flatMap((line) => codexAppServerEvents(JSON.parse(line), "ses-fixture", {}) ?? []);
    expect(events).toHaveLength(2);
    expect(
      events.every((event) => event.type === "status" && event.status?.kind === "api_retry"),
    ).toBe(true);
    const stats = validateTypedStream(events);
    expect(stats.errors).toBe(0);
    expect(stats.completed).toBe(0);
  });

  it("maps the recorded 0.156.1 app-server stream with lifecycle parity", () => {
    const name = "app-server/recorded-run-0.156.1.jsonl";
    const state: CodexParseState = { startedEmitted: true };
    const events: HarnessEvent[] = [
      {
        type: "started",
        session_id: "ses-fixture",
        ts: "2026-09-25T00:00:00.000Z",
        payload: { native_session_id: "thread-fixture", native_turn_id: "turn-fixture" },
      },
    ];
    for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean)) {
      const notification = JSON.parse(line) as Record<string, unknown>;
      const mapped = codexAppServerEvents(notification, "ses-fixture", state);
      if (mapped) events.push(...mapped);
      if (notification["method"] === "turn/completed") {
        const final = parseCodexEvent({ type: "turn.completed", usage: {} }, "ses-fixture", state);
        if (final) events.push(...final.filter((event) => event.type !== "usage"));
        events.push({
          type: "completed",
          session_id: "ses-fixture",
          ts: "2026-09-25T00:00:00.000Z",
        });
      }
    }

    const expectations = manifest.fixtures[name]?.expectations;
    expect(expectations).toBeTruthy();
    expect(streamExpectationViolations(events, expectations!)).toEqual([]);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.toolResults).toBe(1);
    expect(stats.statuslessToolResults).toBe(0);
    expect(stats.usageEvents).toBe(2);
  });

  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
    it(`parses ${name} into a conformant typed stream`, () => {
      const { events, invalidLines, recognizedLines } = parseLines(
        readFileSync(join(FIXTURES, name), "utf8"),
      );
      const stats = validateTypedStream(events);
      // Stream SEMANTICS, not just shape (W3.8): finality/delta/lifecycle/
      // rate-limit counts pinned by the manifest expectations.
      const expectations = manifest.fixtures[name]?.expectations;
      expect(expectations, `manifest expectations missing for ${name}`).toBeTruthy();
      expect(streamExpectationViolations(events, expectations!)).toEqual([]);
      expect(recognizedLines).toBeGreaterThan(3);
      expect(invalidLines).toBeLessThanOrEqual(2); // torn-line tolerance, never silence
      expect(stats.started).toBeGreaterThan(0);
      expect(stats.toolCalls).toBeGreaterThan(0);
      expect(stats.toolResults).toBeGreaterThan(0);
      expect(stats.statuslessToolResults).toBe(0);
      expect(stats.usageEvents).toBeGreaterThan(0);
      if (name.startsWith("basic-run")) {
        expect(stats.errorToolResults).toBeGreaterThan(0); // synthetic fixture exercises the failure path
      }
      if (name.startsWith("session-resume")) {
        // v0.9 contract: the native session id is surfaced for thread resume,
        // and a 429 becomes the TYPED rate_limit signal (never prose-matched).
        const started = events.find((e) => (e as { type?: string }).type === "started") as
          { payload?: Record<string, unknown> } | undefined;
        expect(started?.payload?.["native_session_id"]).toBeTruthy();
        const limited = events.find(
          (e) => (e as { rate_limit?: unknown }).rate_limit !== undefined,
        );
        expect(limited).toBeTruthy();
      }
      if (name.startsWith("recorded-plan-progress")) {
        const planSnapshots = events.filter(
          (event) => (event as { plan_progress?: unknown }).plan_progress !== undefined,
        ) as Array<{ plan_progress: { items: Array<{ status: string }> } }>;
        expect(
          planSnapshots.map((event) => event.plan_progress.items.map((item) => item.status)),
        ).toEqual([["pending"], ["completed"]]);
      }
    });
  }

  it("maps the recorded 0.156.1 SSE timeout reconnect frame to nonterminal retry status", () => {
    const raw = readFileSync(join(FIXTURES, "signals", "reconnect-timeout.jsonl"), "utf8");
    const { events, invalidLines, recognizedLines } = parseLines(raw);
    expect(invalidLines).toBe(0);
    expect(recognizedLines).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: "status",
        status: expect.objectContaining({
          kind: "api_retry",
          attempt: 4,
          max_retries: 5,
          error_category: "timeout",
        }),
        transient: expect.objectContaining({ kind: "timeout" }),
      }),
    ]);
  });
});

/**
 * Replays an app-server stdout capture 1:1 through runCodexAppServer: the
 * capture's request ids are the adapter's own, so every RESPONSE frame is
 * released only once the run has written the request with that id, while
 * notification frames stream in recorded order.
 */
function appServerReplay(lines: string[]): {
  spawn: typeof spawnProcess;
  writes: Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
} {
  const written = new Set<number>();
  const writes: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const spawn: typeof spawnProcess = async function* (_bin, _args, options = {}) {
    options.onSpawn?.({
      write(data) {
        const request = JSON.parse(data) as (typeof writes)[number];
        writes.push(request);
        if (typeof request.id === "number") written.add(request.id);
        wake?.();
        wake = undefined;
      },
      end() {
        ended = true;
        wake?.();
        wake = undefined;
      },
      closed: Promise.resolve(),
    });
    for (const line of lines) {
      const id = (JSON.parse(line) as { id?: number }).id;
      while (typeof id === "number" && !written.has(id) && !ended)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (ended) return;
      yield { type: "stdout", line };
    }
    while (!ended)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
  };
  return { spawn, writes };
}

describe("codex live-message fixture (turn/steer)", () => {
  it("replays the recorded 0.156.1 steer stream through the run: accepted, then the echo delivers", async () => {
    const name = "app-server/recorded-steer-0.156.1.jsonl";
    const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
    const { spawn, writes } = appServerReplay(lines);
    const controller = new CodexAppServerController();
    const events: HarnessEvent[] = [];
    let steer: Promise<LiveMessageResult> | undefined;
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "ses-steer",
        intent: "implement",
        prompt: "Task: run the shell command `sleep 3; echo STEP_N` for N = 1..12",
        cwd: process.cwd(),
        access: "readonly",
        model_hint: "gpt-6-astra",
        effort_hint: "low",
      }),
      env: {},
      spawn,
      controller,
      pollIntervalMs: 0,
    })) {
      events.push(event);
      if (event.type === "tool_call" && !steer)
        steer = controller.steer({
          messageId: "live-message-fixture",
          text: "URGENT CHANGE OF PLAN: stop the STEP sequence immediately. Do not run any more sleep commands. Reply with exactly the word MANGO and finish the turn.",
        });
    }

    await expect(steer).resolves.toEqual({ outcome: "accepted", nativeTurnId: "turn-fixture" });
    expect(writes.filter((request) => request.method === "turn/steer")).toEqual([
      {
        id: 4,
        method: "turn/steer",
        params: {
          threadId: "thread-fixture",
          expectedTurnId: "turn-fixture",
          clientUserMessageId: "live-message-fixture",
          input: [{ type: "text", text: expect.stringContaining("MANGO"), text_elements: [] }],
        },
      },
    ]);
    // The vendor echoed the steer as a userMessage carrying our clientId → one
    // typed receipt; the model answered MANGO and steps 4..12 never ran.
    expect(events.filter((event) => event.type === "status" && !event.quota)).toEqual([
      expect.objectContaining({
        payload: {
          code: "live_input_delivered",
          message_id: "live-message-fixture",
          native_turn_id: "turn-fixture",
        },
      }),
    ]);
    const quotaEvents = events.filter((event) => event.quota);
    expect(quotaEvents).toHaveLength(4);
    expect(quotaEvents.every((event) => event.quota?.source === "codex_app_server_event")).toBe(
      true,
    );
    expect(
      quotaEvents.every((event) => event.type === "status" && !event.usage && !event.rate_limit),
    ).toBe(true);
    const expectations = manifest.fixtures[name]?.expectations;
    expect(expectations).toBeTruthy();
    expect(streamExpectationViolations(events, expectations!)).toEqual([]);
    expect(events.find((event) => event.final)?.text).toBe("MANGO");
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(3);
    expect(stats.toolResults).toBe(3);
    expect(stats.statuslessToolResults).toBe(0);
    expect(stats.usageEvents).toBe(4);
    // Clean terminal: steer and quota tainted nothing. The 22 dropped frames are the
    // recording's unmapped notifications (12 agentMessage deltas, 3 command
    // output deltas, account/updated, remoteControl,
    // thread/started, the clientId:null prompt pair, two empty agentMessage
    // item/started frames); the two echo frames are NOT among them.
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: { native_session_id: "thread-fixture", dropped_unrecognized_events: 22 },
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });
});

describe("codex multi-agent fixture (root-thread ownership of finality)", () => {
  it("replays the synthetic 0.156.1 sub-agent stream: the root envelope is the final, the child is evidence", async () => {
    const name = "app-server/synthetic-multi-agent-0.156.1.jsonl";
    const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
    const { spawn, writes } = appServerReplay(lines);
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "ses-multi-agent",
        intent: "review",
        prompt: "Review the staged diff.",
        cwd: process.cwd(),
        access: "readonly",
        model_hint: "gpt-6-astra",
        // The live incident armed a caller schema: the root's final is the raw
        // `{work_report, output}` envelope the orchestrator un-nests.
        output_schema: {
          type: "object",
          properties: { findings: { type: "array" } },
          required: ["findings"],
          additionalProperties: false,
        },
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    const envelope = JSON.stringify({
      work_report: { state: "completed", required_inputs: [] },
      output: { findings: [] },
    });
    expect(events[0]).toMatchObject({
      type: "started",
      payload: { native_session_id: "thread-root", native_turn_id: "turn-root" },
    });
    // Finality belongs to the root thread: ONE final, the root's envelope —
    // never the sub-agent's `[]\nNO_FINDINGS` that settled first.
    expect(events.filter((event) => event.final)).toEqual([
      expect.objectContaining({
        type: "message",
        text: envelope,
        final: true,
        payload: expect.objectContaining({ final_source: "last_agent_message" }),
      }),
    ]);
    expect(
      events.filter((event) => event.type === "message").map((event) => event.text),
    ).not.toContain("[]\nNO_FINDINGS");
    // The sub-agent's text is timeline evidence (a status row), not an answer.
    expect(events.filter((event) => event.payload?.["code"] === "subagent_message")).toEqual([
      expect.objectContaining({
        type: "status",
        text: "[]\nNO_FINDINGS",
        payload: {
          code: "subagent_message",
          native_thread_id: "thread-child",
          native_turn_id: "turn-child",
          subagent: true,
        },
      }),
    ]);
    // The child's failed command stays visible, tagged with its thread.
    const results = events.filter((event) => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      tool: { use_id: "command-child", status: "error", exit_code: 1 },
      payload: { native_thread_id: "thread-child", native_turn_id: "turn-child", subagent: true },
    });
    expect(results[1]).toMatchObject({ tool: { use_id: "command-root", status: "ok" } });
    expect(results[1]?.payload).not.toHaveProperty("subagent");
    // The child's tokens stay in the run's usage, attributed to its thread.
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.map((event) => event.usage?.input_tokens)).toEqual([304843, 73005, 84935]);
    expect(usage[1]?.payload).toMatchObject({ native_thread_id: "thread-child", subagent: true });
    expect(usage[0]?.payload ?? {}).not.toHaveProperty("subagent");
    // The terminal is the root turn; the sub-agent thread is disclosed; the
    // child's lifecycle frames are recognized, not "dropped".
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: {
        native_session_id: "thread-root",
        native_turn_id: "turn-root",
        subagent_threads: 1,
        dropped_unrecognized_events: 7,
      },
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    // The thread was read exactly once — after the ROOT turn completed, never
    // on the child's terminal.
    expect(writes.filter((request) => request.method === "thread/read")).toHaveLength(1);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(2);
    expect(stats.toolResults).toBe(2);
    expect(stats.errorToolResults).toBe(1);
    expect(stats.usageEvents).toBe(3);
    expect(stats.statuslessToolResults).toBe(0);
  });
});

describe("codex recorded Browser run (claudexor#215)", () => {
  it("replays real startup, navigation and page text, with the injected server optional", async () => {
    const name = "app-server/recorded-browser-delayed-start-0.162.1.jsonl";
    const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
    const { spawn, writes } = appServerReplay(lines);
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "ses-browser-recorded",
        intent: "implement",
        prompt: "Open the probe page with the browser tool.",
        cwd: process.cwd(),
        access: "full",
        model_hint: "gpt-6-astra",
        effort_hint: "low",
        browser: { output_dir: null, headless: true },
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    const started = writes.find((write) => write.method === "thread/start");
    const browser = (started?.params?.["config"] as Record<string, any>)["mcp_servers"]["browser"];
    expect(browser["startup_timeout_sec"]).toBe(90);
    expect(browser["required"]).toBeUndefined();
    expect(writes.map((write) => write.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/read",
      "thread/goal/get",
      "thread/backgroundTerminals/list",
    ]);
    const receipts = events.filter((event) => event.payload?.["code"] === "codex_browser_startup");
    expect(receipts.map((event) => event.payload?.["status"])).toEqual(["ready"]);
    const results = events.filter((event) => event.type === "tool_result");
    expect(results.map((event) => [event.tool?.target, event.tool?.status])).toEqual([
      ["browser:browser_navigate", "ok"],
    ]);
    const page = results[0]?.tool?.content_summary ?? "";
    expect(page).toMatch(/- Page URL: http:\/\/127\.0\.0\.1:\d+\/claudexor-browser-probe-/);
    const title = /- Page Title: (Claudexor Browser probe [0-9a-f]+)/.exec(page)?.[1];
    expect(title).toBeTruthy();
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([
      `The page title is "${title}".`,
    ]);
    expect(validateTypedStream(events).errorToolResults).toBe(0);
  });
});

describe("codex Browser MCP fixture (claudexor#215)", () => {
  it("replays the 0.162.1-shaped Browser stream with the server's page text as tool evidence", async () => {
    const name = "app-server/synthetic-browser-mcp-0.162.1.jsonl";
    const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
    const { spawn } = appServerReplay(lines);
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "ses-browser",
        intent: "implement",
        prompt: "Open the probe page with the browser tool.",
        cwd: process.cwd(),
        access: "full",
        model_hint: "gpt-6-astra",
        effort_hint: "low",
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    const url = "http://127.0.0.1:61191/claudexor-browser-probe-cf77d14a49bca53a.html";
    const value = "a4069362e00933b8e5cbb410";
    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls.map((event) => [event.tool?.use_id, event.tool?.target])).toEqual([
      ["mcp-navigate", "browser:browser_navigate"],
      ["mcp-snapshot", "browser:browser_snapshot"],
      ["mcp-navigate-unsafe", "browser:browser_navigate"],
      ["mcp-close", "browser:browser_close"],
    ]);
    const results = events.filter((event) => event.type === "tool_result");
    expect(results.map((event) => [event.tool?.use_id, event.tool?.status])).toEqual([
      ["mcp-navigate", "ok"],
      ["mcp-snapshot", "ok"],
      ["mcp-navigate-unsafe", "error"],
      ["mcp-close", "ok"],
    ]);
    // #118: only the replies that show a loaded page are a verified retrieval of a
    // page; a failed call stays unstamped, and closing read no page, so it carries
    // no retrieval stamp at all.
    expect(results.map((event) => [event.tool?.web_retrieval, event.tool?.web_content])).toEqual([
      ["verified", "page"],
      ["verified", "page"],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    // The browser reports the page it actually loaded, title included.
    expect(results[0]?.tool?.content_summary).toContain(`Page URL: ${url}`);
    expect(results[0]?.tool?.content_summary).toContain(
      `Page Title: Claudexor Browser probe ${value}`,
    );
    expect(results[1]?.tool?.content_summary).toContain(`Probe value: ${value}`);
    // The failed navigation keeps Playwright's own error, not a generic label.
    expect(results[2]?.tool?.error_summary).toContain("net::ERR_UNSAFE_PORT");
    // Closing never carries the page's content.
    expect(results[3]?.tool?.content_summary).not.toContain(value);
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([
      `The page title is "Claudexor Browser probe ${value}".`,
    ]);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(4);
    expect(stats.toolResults).toBe(4);
    expect(stats.errorToolResults).toBe(1);
    expect(stats.statuslessToolResults).toBe(0);
    expect(events.at(-1)?.type).toBe("completed");
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });
});

describe("codex native warnings fixture (configWarning / warning)", () => {
  it("replays the synthetic 0.162.1 stream: native warnings are status evidence, not dropped frames", async () => {
    const name = "app-server/synthetic-native-warnings-0.162.1.jsonl";
    const lines = readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
    const frames = lines.map((line) => JSON.parse(line) as Record<string, any>);
    const { spawn, writes } = appServerReplay(lines);
    const events: HarnessEvent[] = [];
    for await (const event of runCodexAppServer({
      bin: "codex",
      args: [],
      spec: HarnessRunSpec.parse({
        session_id: "ses-warnings",
        intent: "explain",
        prompt: "Answer without using tools.",
        cwd: process.cwd(),
        access: "readonly",
        model_hint: "fixture-model",
      }),
      env: {},
      spawn,
      pollIntervalMs: 0,
    }))
      events.push(event);

    expect(writes.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "thread/read",
      "thread/goal/get",
      "thread/backgroundTerminals/list",
    ]);
    // The startup configWarning was queued before the thread existed and the
    // thread warning before the turn: both follow `started`, in arrival order.
    expect(events[0]?.type).toBe("started");
    const native = frames.filter(
      (frame) => frame["method"] === "configWarning" || frame["method"] === "warning",
    );
    const warnings = events.filter((event) => event.payload?.["code"] === "codex_native_warning");
    expect(
      warnings.map((event) => [event.payload?.["native_method"], event.payload?.["native_params"]]),
    ).toEqual(native.map((frame) => [frame["method"], frame["params"]]));
    expect(warnings.map((event) => [event.type, event.text])).toEqual([
      ["status", native[0]!["params"]["summary"]],
      ["status", native[1]!["params"]["message"]],
      ["status", native[2]!["params"]["message"]],
    ]);
    const finalText = frames.find((frame) => frame["method"] === "item/completed")!["params"][
      "item"
    ]["text"];
    expect(events.filter((event) => event.final).map((event) => event.text)).toEqual([finalText]);
    const stats = validateTypedStream(events);
    expect(stats.started).toBe(1);
    expect(stats.toolCalls).toBe(0);
    expect(stats.toolResults).toBe(0);
    // Remote-control status, thread/started and the empty agentMessage start
    // stay the only unrecognized frames; the three warnings are not among them.
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      payload: {
        native_session_id: "thread-warnings",
        native_turn_id: "turn-warnings",
        dropped_unrecognized_events: 3,
      },
    });
    expect(events.at(-1)?.payload).not.toHaveProperty("harness_reported_error");
  });
});
