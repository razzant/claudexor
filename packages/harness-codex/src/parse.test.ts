import { describe, expect, it } from "vitest";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { runCliHarness, type CliRunLoopOptions } from "@claudexor/core";
import { createCodexAdapter } from "./index.js";
import { parseCodexEvent, parseCodexStderrFailure, type CodexParseState } from "./parse.js";

const SAMPLE = [
  '{"type":"thread.started","thread_id":"th-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"i4","type":"web_search","query":"claudexor release"}}',
  '{"type":"item.completed","item":{"id":"i4","type":"web_search","query":"claudexor release","status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"file_change","path":"src/a.ts"}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":0}}',
];

describe("parseCodexEvent", () => {
  it("marks configured required MCP servers ready only once Codex reaches thread.started", () => {
    const state: CodexParseState = { requiredMcpServers: ["claudexor"] };
    const out = parseCodexEvent(
      { type: "thread.started", thread_id: "th-required" },
      "s-required",
      state,
    );
    expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([
      { name: "claudexor", status: "connected" },
    ]);
  });

  it.each(["turn.failed", "error"])(
    "marks required MCP startup failure on %s with the exact Codex prefix",
    (type) => {
      const state: CodexParseState = { requiredMcpServers: ["claudexor"] };
      const message = "required MCP servers failed to initialize: claudexor";
      const raw = type === "turn.failed" ? { type, error: { message } } : { type, message };
      const out = parseCodexEvent(raw, "s-required", state);
      expect(out?.[0]?.type).toBe("error");
      expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status: "failed" }]);
    },
  );

  it("captures the real stderr-only required MCP fatal as typed startup evidence", async () => {
    const state: CodexParseState = { requiredMcpServers: ["claudexor"] };
    const message = "required MCP servers failed to initialize: claudexor";
    const spec = HarnessRunSpec.parse({
      session_id: "s-stderr-required",
      intent: "implement",
      prompt: "delegate",
      cwd: process.cwd(),
    });
    const events: HarnessEvent[] = [];
    for await (const event of runCliHarness({
      bin: process.execPath,
      args: ["-e", `process.stderr.write(${JSON.stringify(message)}); process.exit(1)`],
      spec,
      label: "codex",
      parseEvent: () => null,
      parseStderrFailure: (stderr, sessionId) => parseCodexStderrFailure(stderr, sessionId, state),
    })) {
      events.push(event);
    }
    const failure = events.find((event) => event.type === "error");
    expect(failure?.payload?.["mcp_servers"]).toEqual([{ name: "claudexor", status: "failed" }]);
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("wires stderr-only required MCP evidence through the Codex adapter route receipt", async () => {
    let options: CliRunLoopOptions | undefined;
    const adapter = createCodexAdapter({
      detectVersion: async () => "codex-cli 0.144.1",
      probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
      hasApiKey: () => false,
      probeEfforts: async () => null,
      runCliHarness: async function* (input): AsyncGenerator<HarnessEvent> {
        options = input;
        yield {
          type: "completed",
          session_id: input.spec.session_id,
          ts: "2026-01-01T00:00:00.000Z",
        };
      },
    });
    const runSpec = HarnessRunSpec.parse({
      session_id: "s-adapter-required",
      intent: "implement",
      prompt: "delegate",
      cwd: process.cwd(),
      extra_mcp_servers: [
        {
          name: "claudexor",
          command: process.execPath,
          args: ["belt.js"],
          env: {},
          required: true,
        },
      ],
    });
    for await (const _event of adapter.run(runSpec)) {
      // drain
    }
    const failure = options?.parseStderrFailure?.(
      "warning before fatal\nrequired MCP servers failed to initialize: claudexor",
      runSpec.session_id,
    );
    expect(failure).toMatchObject({
      type: "error",
      credential_route: "vendor_native",
      credential_source: "native_session",
      payload: { mcp_servers: [{ name: "claudexor", status: "failed" }] },
    });
  });

  it("classifies a stderr-shaped vendor rate limit into the typed rate_limit signal (A1 parity)", () => {
    // Before A1 parseCodexStderrFailure typed ONLY the MCP-startup fatal: a
    // vendor limit that reached stderr (instead of a JSON error frame) stayed
    // a generic exit disclosure with no rate_limit signal, so reactive
    // credential rotation could never fire on it.
    const out = parseCodexStderrFailure(
      "stream error: 429 Too Many Requests; Please try again later",
      "s-stderr-limit",
      undefined,
    );
    expect(out).toMatchObject({
      type: "error",
      rate_limit: { resets_at: null, retry_delay_ms: null, applies_to_request_kinds: ["text"] },
    });
  });

  it("still returns null for unclassified stderr so the generic exit disclosure stays authoritative", () => {
    expect(
      parseCodexStderrFailure("segmentation fault (core dumped)", "s-x", undefined),
    ).toBeNull();
  });

  it("does not relabel unrelated Codex errors as required MCP failures", () => {
    const state: CodexParseState = { requiredMcpServers: ["claudexor"] };
    const out = parseCodexEvent(
      { type: "error", message: "optional MCP server timed out" },
      "s-required",
      state,
    );
    expect(out?.[0]?.payload?.["mcp_servers"]).toBeUndefined();
  });

  it("does not mark the Delegate belt failed when Codex names a different required MCP server", () => {
    const state: CodexParseState = {
      requiredMcpServers: ["claudexor", "user_docs"],
    };
    const out = parseCodexEvent(
      {
        type: "error",
        message: "required MCP servers failed to initialize: user_docs: connection refused",
      },
      "s-required",
      state,
    );
    expect(out?.[0]?.payload?.["mcp_servers"]).toEqual([{ name: "user_docs", status: "failed" }]);

    const prefixCollision = parseCodexEvent(
      {
        type: "error",
        message: "required MCP servers failed to initialize: claudexor-other",
      },
      "s-required",
      state,
    );
    expect(prefixCollision?.[0]?.payload?.["mcp_servers"]).toBeUndefined();
  });

  it("maps a realistic codex exec --json stream to normalized typed events", () => {
    const state = {};
    const events = SAMPLE.flatMap((l) => parseCodexEvent(JSON.parse(l), "s1", state) ?? []);
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types.filter((type) => type === "started")).toHaveLength(1);
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("file_change");
    expect(types).toContain("message");
    expect(types).toContain("usage");

    const fileChange = events.find(
      (e) => e.type === "file_change" && e.payload?.["path"] === "src/a.ts",
    );
    expect(fileChange?.tool?.kind).toBe("file");

    const cmdResult = events.find((e) => e.type === "tool_result" && e.tool?.kind === "command");
    expect(cmdResult?.tool?.status).toBe("ok");
    expect(cmdResult?.tool?.exit_code).toBe(0);

    const webCall = events.find((e) => e.type === "tool_call" && e.tool?.kind === "web");
    expect(webCall?.tool?.name).toBe("web_search");
    expect(webCall?.tool?.target).toContain("claudexor release");
    const webResult = events.find((e) => e.type === "tool_result" && e.tool?.kind === "web");
    expect(webResult?.tool?.status).toBe("ok");
    // QA-042: a completed codex web_search has no typed fetch outcome, so it is
    // DISPATCH strength only (a hidden 502 is indistinguishable) — never proof
    // of retrieved content.
    expect(webResult?.tool?.web_retrieval).toBe("dispatched");

    const usage = events.find((e) => e.type === "usage");
    expect(usage?.usage?.input_tokens).toBe(100);
    expect(usage?.usage?.input_token_usage).toEqual({
      total_tokens: 100,
      cache_read_tokens: 80,
      cache_write_tokens: null,
    });

    const msg = events.find((e) => e.type === "message");
    expect(msg?.text).toBe("Done.");

    // codex has NO native final marker: the adapter finalizes the turn's
    // LAST agent message as a typed `final` message on turn.completed
    // (vendor semantics — --output-last-message / task_complete). F2.5 W-C1.
    const finals = events.filter((e) => e.type === "message" && e.final === true);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe("Done.");
    expect(finals[0]?.payload?.["final_source"]).toBe("last_agent_message");
  });

  it("types exec file edits per changes[] path with the native lifecycle and outcome (#410)", () => {
    const edits = [
      {
        type: "item.started",
        item: {
          id: "p1",
          type: "file_change",
          changes: [{ path: "a.ts" }, { path: "b.ts" }],
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "p1",
          type: "file_change",
          changes: [{ path: "a.ts" }, { path: "b.ts" }],
          status: "failed",
        },
      },
    ].flatMap((frame) => parseCodexEvent(frame, "s1", {}) ?? []);
    for (const e of edits) expect(() => HarnessEvent.parse(e)).not.toThrow();
    expect(
      edits.map((e) => [e.payload?.["path"], e.tool?.target, e.tool?.phase, e.tool?.status]),
    ).toEqual([
      ["a.ts", "a.ts", "started", undefined],
      ["b.ts", "b.ts", "started", undefined],
      ["a.ts", "a.ts", "completed", "error"],
      ["b.ts", "b.ts", "completed", "error"],
    ]);
    expect(edits.every((e) => e.tool?.use_id === "p1")).toBe(true);
    // A single named path (the synthetic fixture's shape) is one event, never re-enumerated.
    expect(
      parseCodexEvent(
        { type: "item.completed", item: { id: "i2", type: "file_change", path: "src/a.ts" } },
        "s1",
        {},
      ),
    ).toMatchObject([{ type: "file_change", tool: { target: "src/a.ts", phase: "completed" } }]);
  });

  it("does not fabricate a final message when a turn produced no agent message", () => {
    const state = {};
    const events = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].flatMap((l) => parseCodexEvent(JSON.parse(l), "s1", state) ?? []);
    expect(events.some((e) => e.final === true)).toBe(false);
  });

  it("stateless parse (no state) never emits a final message", () => {
    const events = SAMPLE.flatMap((l) => parseCodexEvent(JSON.parse(l), "s1") ?? []);
    expect(events.some((e) => e.final === true)).toBe(false);
  });

  it("never leaks a prior turn's agent message into a later turn's final (sol #2)", () => {
    const state = {};
    const events = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"turn one draft"}}',
      '{"type":"turn.failed","error":{"message":"boom"}}',
      // A fresh turn that produces NO agent message must NOT finalize the stale one.
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].flatMap((l) => parseCodexEvent(JSON.parse(l), "s1", state) ?? []);
    expect(events.some((e) => e.final === true)).toBe(false);
  });

  it("maps failed command executions to error tool_results (status + exit code)", () => {
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "i9",
          type: "command_execution",
          command: "pnpm test",
          exit_code: 1,
          status: "failed",
          aggregated_output: "2 tests failed",
        },
      },
      "s1",
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.type).toBe("tool_result");
    expect(out?.[0]?.tool?.status).toBe("error");
    expect(out?.[0]?.tool?.kind).toBe("command");
    expect(out?.[0]?.tool?.exit_code).toBe(1);
    expect(out?.[0]?.tool?.error_summary).toContain("2 tests failed");
    expect(() => HarnessEvent.parse(out?.[0])).not.toThrow();
  });

  it("maps declined app-server commands to error tool_results", () => {
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "i-declined",
          type: "command_execution",
          command: "printf fixture-ok",
          exit_code: null,
          status: "declined",
        },
      },
      "s1",
    );
    expect(out).toMatchObject([
      {
        type: "tool_result",
        tool: { status: "error", error_summary: "command execution failed" },
      },
    ]);
  });

  it("preserves a failed MCP belt call as exact error evidence", () => {
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "mcp-belt-1",
          type: "mcp_tool_call",
          server: "claudexor",
          tool: "claudexor_run",
          status: "failed",
          error: "delegated sub-run child-failed ended failed",
        },
      },
      "s1",
    );
    expect(out?.[0]?.tool).toMatchObject({
      name: "claudexor_run",
      kind: "mcp",
      target: "claudexor:claudexor_run",
      status: "error",
    });
    expect(out?.[0]?.tool?.error_summary).toContain("child-failed");
  });

  describe("MCP tool results keep the server's evidence (claudexor#215)", () => {
    const completed = (item: Record<string, unknown>) =>
      parseCodexEvent(
        {
          type: "item.completed",
          item: { id: "mcp-1", type: "mcp_tool_call", server: "browser", ...item },
        },
        "s1",
      )?.[0];
    const page =
      "### Ran Playwright code\n```js\nawait page.goto('http://127.0.0.1:4/p.html');\n```\n" +
      "### Page\n- Page URL: http://127.0.0.1:4/p.html\n- Page Title: probe 0a1b2c";

    it("keeps a completed result's text, never its image bytes, under the unchanged identity", () => {
      const out = completed({
        tool: "browser_navigate",
        status: "completed",
        result: {
          content: [
            { type: "text", text: page },
            { type: "image", data: "iVBORw0KGgoAAAANSUhEUg", mimeType: "image/png" },
          ],
          structuredContent: null,
        },
      });
      expect(out?.text).toBe("tool_result");
      expect(out?.tool).toMatchObject({
        name: "browser_navigate",
        kind: "mcp",
        use_id: "mcp-1",
        target: "browser:browser_navigate",
        status: "ok",
      });
      expect(out?.tool?.error_summary).toBeUndefined();
      expect(out?.tool?.content_summary).toBe(page);
      expect(out?.tool?.content_summary).not.toContain("iVBORw0KGgo");
    });

    it("keeps the result's line breaks, collapsing whitespace within each line", () => {
      const out = completed({
        tool: "browser_snapshot",
        status: "completed",
        result: {
          content: [
            { type: "text", text: "### Page\r\n-   Page URL:  http://x/  \n\n  - nested\t item" },
            { type: "text", text: "### Snapshot" },
          ],
        },
      });
      expect(out?.tool?.content_summary).toBe(
        "### Page\n- Page URL: http://x/\n - nested item\n### Snapshot",
      );
    });

    it("uses structured content only when the server returned no text", () => {
      const out = completed({
        tool: "lookup",
        status: "completed",
        result: { content: [], structured_content: { title: "probe" } },
      });
      expect(out?.tool?.content_summary).toBe('{"title":"probe"}');
    });

    it("keeps the native error message of a call that returned no result", () => {
      const out = completed({
        tool: "browser_snapshot",
        status: "failed",
        result: null,
        error: { message: "MCP tool call timed out" },
      });
      expect(out?.text).toBe("tool_result: error");
      expect(out?.tool).toMatchObject({
        status: "error",
        error_summary: "MCP tool call timed out",
      });
      expect(out?.tool?.content_summary).toBeUndefined();
    });

    it("reports an isError result as an error carrying the server's own text", () => {
      const out = completed({
        tool: "browser_navigate",
        status: "failed",
        result: {
          content: [{ type: "text", text: "### Error\nError: net::ERR_CONNECTION_REFUSED" }],
        },
        error: null,
      });
      expect(out?.tool?.status).toBe("error");
      expect(out?.tool?.error_summary).toBe("### Error Error: net::ERR_CONNECTION_REFUSED");
      expect(out?.tool?.content_summary).toBe("### Error\nError: net::ERR_CONNECTION_REFUSED");
    });

    it("leaves an unknown completion status statusless instead of calling it a success", () => {
      for (const status of ["inProgress", undefined]) {
        const out = completed({ tool: "browser_navigate", status, result: { content: [] } });
        expect(out?.type).toBe("tool_result");
        expect(out?.text).toBe("tool_result");
        expect(out?.tool?.status).toBeUndefined();
        expect(out?.tool?.target).toBe("browser:browser_navigate");
      }
    });

    it("keeps result text exact and bounds it like other tool summaries (INV-146)", () => {
      const secret = "sk-" + "a".repeat(30);
      const out = completed({
        tool: "browser_snapshot",
        status: "completed",
        result: { content: [{ type: "text", text: `token ${secret} ${"x".repeat(2000)}` }] },
      });
      expect(out?.tool?.content_summary).toBe(`token ${secret} ${"x".repeat(2000)}`.slice(0, 1000));
      expect(out?.tool?.content_summary?.length).toBe(1000);
    });
  });

  it("maps failed web searches to error tool_results", () => {
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "w1",
          type: "web_search",
          query: "x",
          status: "failed",
          error: "search backend unavailable",
        },
      },
      "s1",
    );
    expect(out?.[0]?.type).toBe("tool_result");
    expect(out?.[0]?.tool?.kind).toBe("web");
    expect(out?.[0]?.tool?.status).toBe("error");
    expect(out?.[0]?.tool?.error_summary).toContain("search backend unavailable");
    // QA-042: an explicit failed status is a typed retrieval failure.
    expect(out?.[0]?.tool?.web_retrieval).toBe("failed");
  });

  it("maps turn/item progress events instead of dropping live progress", () => {
    // A lifecycle marker, not reasoning: it must never plant a junk
    // "turn started" block in the chat's thinking disclosure.
    expect(parseCodexEvent({ type: "turn.started", turn_id: "t1" }, "s1")?.[0]?.type).toBe(
      "started",
    );
    const cmd = parseCodexEvent(
      {
        type: "item.started",
        item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" },
      },
      "s1",
    );
    expect(cmd?.[0]?.type).toBe("tool_call");
    expect(cmd?.[0]?.text).toBe("ls");
    expect(cmd?.[0]?.payload?.["status"]).toBe("in_progress");
    // updated progress ticks are recognized-but-skipped, not dropped
    expect(
      parseCodexEvent(
        { type: "item.updated", item: { id: "i1", type: "command_execution", command: "ls" } },
        "s1",
      ),
    ).toEqual([]);
    // unknown item types are null so the run loop counts them
    expect(
      parseCodexEvent({ type: "item.started", item: { type: "agent_message" } }, "s1"),
    ).toBeNull();
    expect(parseCodexEvent({ type: "something.new" }, "s1")).toBeNull();
  });

  it("uses turn.started only as a fallback when thread.started is absent", () => {
    const state: CodexParseState = {};
    expect(parseCodexEvent({ type: "turn.started", turn_id: "t1" }, "s1", state)).toEqual([
      expect.objectContaining({ type: "started", session_id: "s1" }),
    ]);
    expect(parseCodexEvent({ type: "turn.started", turn_id: "t2" }, "s1", state)).toEqual([]);
  });

  it("resolves a started web_search query from action when the top-level query is empty", () => {
    // Live shape (codex 0.137): item.started carries query:"" with the real
    // query under action; the call must NOT surface as a query-less "web search".
    const started = parseCodexEvent(
      {
        type: "item.started",
        item: {
          id: "ws1",
          type: "web_search",
          query: "",
          action: { type: "search", query: "node lts version", queries: ["node lts version"] },
        },
      },
      "s1",
    )?.[0];
    expect(started?.type).toBe("tool_call");
    expect(started?.text).toBe("node lts version");
    expect(started?.tool?.target).toContain("node lts version");
    // Falls back to action.queries[0] when action.query is absent.
    const fromQueries = parseCodexEvent(
      {
        type: "item.started",
        item: {
          id: "ws2",
          type: "web_search",
          query: "",
          action: { type: "search", queries: ["fallback query"] },
        },
      },
      "s1",
    )?.[0];
    expect(fromQueries?.text).toBe("fallback query");
    // No query anywhere -> the honest generic label, no crash.
    const none = parseCodexEvent(
      {
        type: "item.started",
        item: { id: "ws3", type: "web_search", query: "", action: { type: "other" } },
      },
      "s1",
    )?.[0];
    expect(none?.text).toBe("web search");
  });

  it("maps error and turn.failed to error events", () => {
    expect(parseCodexEvent({ type: "error", message: "boom" }, "s1")?.[0]?.type).toBe("error");
    expect(
      parseCodexEvent({ type: "turn.failed", error: { message: "x" } }, "s1")?.[0]?.error,
    ).toBe("x");
  });

  it("sets the typed rate_limit signal from native error phrasing (conservatively)", () => {
    const rl = (message: string) =>
      parseCodexEvent({ type: "error", message }, "s1")?.[0]?.rate_limit;
    // Real rate-limit/quota phrasing -> typed signal.
    expect(rl("HTTP 429 Too Many Requests")).toBeTruthy();
    expect(rl("UsageLimitExceeded")).toBeTruthy();
    expect(rl("rate limited, retry later")).toBeTruthy();
    // Unrelated mentions of 429/quota -> NO false signal.
    expect(rl("received 429 items")).toBeUndefined();
    expect(rl("the quota field is missing")).toBeUndefined();
    // A resets_at hint is carried through onto the typed signal.
    const withReset = parseCodexEvent(
      { type: "error", message: "rate limit", resets_at: "2026-06-12T09:00:00Z" },
      "s1",
    )?.[0];
    expect(withReset?.rate_limit?.resets_at).toBe("2026-06-12T09:00:00Z");
  });

  it("sets the typed rate_limit signal on a turn.failed (not only top-level error)", () => {
    // codex surfaces a rate limit via EITHER event; both must produce the typed signal.
    const failed = parseCodexEvent(
      {
        type: "turn.failed",
        error: { message: "HTTP 429 Too Many Requests", resets_at: "2026-06-12T10:00:00Z" },
      },
      "s1",
    )?.[0];
    expect(failed?.type).toBe("error");
    expect(failed?.rate_limit).toBeTruthy();
    expect(failed?.rate_limit?.resets_at).toBe("2026-06-12T10:00:00Z");
    // A non-rate-limit turn.failed carries NO false signal.
    const benign = parseCodexEvent(
      { type: "turn.failed", error: { message: "compile error" } },
      "s1",
    )?.[0];
    expect(benign?.type).toBe("error");
    expect(benign?.rate_limit).toBeUndefined();
  });

  it("sets the typed transient signal on native network/stream disconnect errors", () => {
    const stream = parseCodexEvent(
      {
        type: "error",
        message:
          "stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known",
      },
      "s1",
    )?.[0];
    expect(stream?.type).toBe("error");
    expect(stream?.transient?.kind).toBe("stream_disconnect");
    expect(() => HarnessEvent.parse(stream)).not.toThrow();

    const failed = parseCodexEvent(
      { type: "turn.failed", error: { message: "request failed: ENOTFOUND chatgpt.com" } },
      "s1",
    )?.[0];
    expect(failed?.transient?.kind).toBe("network");

    const compile = parseCodexEvent(
      { type: "error", message: "TypeScript compile error" },
      "s1",
    )?.[0];
    expect(compile?.transient).toBeUndefined();
  });

  it("maps exact Codex reconnect notices to nonterminal retry status", () => {
    const messages = [
      "Reconnecting... 5/5 (request timed out)",
      "Reconnecting... 1/5 (request timed out)",
      "Reconnecting... 2/5 (request timed out)",
    ];
    const events = messages.flatMap(
      (message) => parseCodexEvent({ type: "error", message }, "s-reconnect") ?? [],
    );
    expect(events.map((value) => value.type)).toEqual(["status", "status", "status"]);
    expect(events.map((value) => value.status)).toEqual([
      expect.objectContaining({
        kind: "api_retry",
        attempt: 5,
        max_retries: 5,
        error_category: "timeout",
      }),
      expect.objectContaining({
        kind: "api_retry",
        attempt: 1,
        max_retries: 5,
        error_category: "timeout",
      }),
      expect.objectContaining({
        kind: "api_retry",
        attempt: 2,
        max_retries: 5,
        error_category: "timeout",
      }),
    ]);
    for (const value of events) {
      expect(value.transient?.kind).toBe("timeout");
      expect(value.error).toBeUndefined();
      expect(() => HarnessEvent.parse(value)).not.toThrow();
    }
  });

  it("keeps recorded SSE idle-timeout retries nonterminal until the stream fails", () => {
    const reason = "stream disconnected before completion: idle timeout waiting for SSE";
    const state = {};
    const retries = [1, 2, 3, 4, 5].flatMap(
      (attempt) =>
        parseCodexEvent(
          { type: "error", message: `Reconnecting... ${attempt}/5 (${reason})` },
          "s-sse-timeout",
          state,
        ) ?? [],
    );
    expect(retries.map((event) => event.type)).toEqual(Array(5).fill("status"));
    expect(retries.map((event) => event.status?.attempt)).toEqual([1, 2, 3, 4, 5]);
    for (const event of retries) {
      expect(event.status).toMatchObject({ kind: "api_retry", error_category: "timeout" });
      expect(event.transient?.kind).toBe("timeout");
      expect(event.error).toBeUndefined();
      expect(() => HarnessEvent.parse(event)).not.toThrow();
    }
    const failed = parseCodexEvent(
      { type: "turn.failed", error: { message: reason } },
      "s-sse-timeout",
      state,
    )?.[0];
    expect(failed?.type).toBe("error");
    expect(failed?.transient?.kind).toBe("stream_disconnect");
  });

  it("keeps a real post-reconnect exhaustion as an error", () => {
    const exhausted = parseCodexEvent(
      { type: "error", message: "request timed out" },
      "s-reconnect",
    )?.[0];
    expect(exhausted?.type).toBe("error");
    expect(exhausted?.transient?.kind).toBe("timeout");
  });

  it("maps a codex todo_list to a plan message (the relay plan signal)", () => {
    // Verified live (codex 0.142): item.completed carries item.type=todo_list with items[].{text,completed}.
    const line =
      '{"type":"item.completed","item":{"id":"item_0","type":"todo_list","items":[{"text":"Step one","completed":true},{"text":"Step two","completed":false}]}}';
    const events = parseCodexEvent(JSON.parse(line), "s1") ?? [];
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();
    const msg = events.find((e) => e.type === "message");
    expect(msg?.text).toContain("Plan:");
    expect(msg?.text).toContain("[x] Step one");
    expect(msg?.text).toContain("[ ] Step two");
  });
});

describe("plan progress", () => {
  it("maps todo_list items to the TYPED plan_progress field (message kept for plan extraction)", () => {
    const state: CodexParseState = {};
    const raw = {
      type: "item.completed",
      item: {
        type: "todo_list",
        items: [
          { text: "step one", completed: true },
          { text: "step two", completed: false },
        ],
      },
    };
    const out = parseCodexEvent(raw, "s1", state);
    const ev = out?.[0];
    expect(ev?.type).toBe("message");
    expect(ev?.plan_progress?.items).toEqual([
      { id: "codex-0", title: "step one", status: "completed" },
      { id: "codex-1", title: "step two", status: "pending" },
    ]);
    expect(parseCodexEvent(raw, "s1", state)).toEqual([]);
  });

  it("projects each distinct native todo-list lifecycle snapshot", () => {
    const state: CodexParseState = {};
    const snapshots = [
      { type: "item.started", item: { type: "todo_list", items: [] } },
      {
        type: "item.updated",
        item: { type: "todo_list", items: [{ text: "step one", completed: false }] },
      },
      {
        type: "item.completed",
        item: { type: "todo_list", items: [{ text: "step one", completed: true }] },
      },
    ];

    const events = snapshots.flatMap((snapshot) => parseCodexEvent(snapshot, "s1", state) ?? []);
    expect(events.map((event) => event.plan_progress?.items)).toEqual([
      [],
      [{ id: "codex-0", title: "step one", status: "pending" }],
      [{ id: "codex-0", title: "step one", status: "completed" }],
    ]);
  });
});

describe("intermediate WorkReport envelope leak (D-16 / codex #19816)", () => {
  const ENVELOPE = (output: unknown) =>
    JSON.stringify({ work_report: { state: "completed", required_inputs: [] }, output });

  it("unwraps an intermediate envelope to its output for the VISIBLE stream (never raw JSON)", () => {
    const state: CodexParseState = { envelopeActive: true };
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: ENVELOPE("Использую навык OpenAI Docs, чтобы сопоставить режимы."),
        },
      },
      "s1",
      state,
    );
    expect(out).toHaveLength(1);
    expect(out?.[0]?.type).toBe("message");
    // The visible text is the UNWRAPPED output — no `{work_report` prefix leaks.
    expect(out?.[0]?.text).toBe("Использую навык OpenAI Docs, чтобы сопоставить режимы.");
    expect(out?.[0]?.text).not.toContain("work_report");
    // The RAW envelope is retained as the finality candidate so the orchestrator
    // still un-nests the FINAL envelope downstream.
    expect(state.lastAgentMessage).toContain("work_report");
  });

  it("suppresses an intermediate envelope whose output is non-string (never leaks the object)", () => {
    const state: CodexParseState = { envelopeActive: true };
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: { type: "agent_message", text: ENVELOPE({ table: [1, 2] }) },
      },
      "s1",
      state,
    );
    // Recognized-but-suppressed: no visible message carrying the raw envelope.
    expect(out).toEqual([]);
    // Raw text still captured for downstream finalization.
    expect(state.lastAgentMessage).toContain("work_report");
  });

  it("QA-009: the FINAL string-output envelope displays UNWRAPPED, carrying the raw envelope on a typed field", () => {
    const state: CodexParseState = { envelopeActive: true };
    const finalOutput = "Ask — read-only; Plan — planning; Agent — edits.";
    const finalEnvelope = ENVELOPE(finalOutput);
    const events = [
      {
        type: "item.completed",
        item: { type: "agent_message", text: ENVELOPE("mid-run narration") },
      },
      { type: "item.completed", item: { type: "agent_message", text: finalEnvelope } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ].flatMap((o) => parseCodexEvent(o, "s1", state) ?? []);
    const final = events.find((e) => e.type === "message" && e.final === true);
    // DISPLAY truth: the final's text is the UNWRAPPED output — identical to the
    // intermediate visible copy, so the reducer's exact-identity twin-removal
    // matches and Activity never duplicates the answer bubble (QA-009).
    expect(final?.text).toBe(finalOutput);
    expect(final?.text).not.toContain("work_report");
    // MACHINE truth: the RAW envelope rides a typed payload field for the
    // orchestrator's downstream unwrap (no raw JSON in the visible stream).
    expect(final?.payload?.["work_report_envelope"]).toBe(finalEnvelope);
    expect(final?.payload?.["final_source"]).toBe("last_agent_message");
    // No VISIBLE intermediate message leaked the raw envelope.
    const visible = events.filter((e) => e.type === "message" && e.final !== true);
    for (const v of visible) expect(v.text).not.toContain("work_report");
    expect(visible.map((v) => v.text)).toContain("mid-run narration");
  });

  it("keeps the FINAL RAW when the envelope output is non-string (no visible twin; orchestrator unwraps answer text)", () => {
    const state: CodexParseState = { envelopeActive: true };
    const finalEnvelope = ENVELOPE({ table: [1, 2] });
    const events = [
      { type: "item.completed", item: { type: "agent_message", text: finalEnvelope } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ].flatMap((o) => parseCodexEvent(o, "s1", state) ?? []);
    const final = events.find((e) => e.type === "message" && e.final === true);
    // A structured output has no plain-string display and its intermediate copy
    // was SUPPRESSED (no visible twin), so the final keeps the raw envelope as its
    // text and the orchestrator un-nests `answer.text()` exactly as before — no
    // typed envelope field is attached (the answer text IS the envelope).
    expect(final?.text).toBe(finalEnvelope);
    expect(final?.payload?.["work_report_envelope"]).toBeUndefined();
    expect(final?.payload?.["final_source"]).toBe("last_agent_message");
  });

  it("passes a plain (non-envelope) message through untouched even when envelope is active", () => {
    const state: CodexParseState = { envelopeActive: true };
    const out = parseCodexEvent(
      { type: "item.completed", item: { type: "agent_message", text: "just a normal answer" } },
      "s1",
      state,
    );
    expect(out?.[0]?.text).toBe("just a normal answer");
  });

  it("does NOT unwrap when the run armed no envelope (typed-shape match still gated)", () => {
    const raw = ENVELOPE("would-be output");
    const out = parseCodexEvent(
      { type: "item.completed", item: { type: "agent_message", text: raw } },
      "s1",
      {}, // envelopeActive falsy
    );
    // Without an armed envelope the message is surfaced verbatim (a user could
    // legitimately want that literal JSON) — the gate prevents false unwrapping.
    expect(out?.[0]?.text).toBe(raw);
  });
});

describe("structured output flag", () => {
  it("codexExecArgs adds --output-schema <file> in both fresh and resume branches", async () => {
    const { codexExecArgs } = await import("./index.js");
    const base = {
      access: "readonly" as const,
      model_hint: null,
      effort_hint: null,
      external_context_policy: "off" as const,
      prompt: "plan it",
      attachments: [],
      browser: null,
    };
    const fresh = codexExecArgs({ ...base, resume_session_id: null } as never, {
      outputSchemaPath: "/tmp/s.json",
    });
    expect(fresh.join(" ")).toContain("--output-schema /tmp/s.json");
    const resume = codexExecArgs({ ...base, resume_session_id: "ses-1" } as never, {
      outputSchemaPath: "/tmp/s.json",
    });
    expect(resume.join(" ")).toContain("--output-schema /tmp/s.json");
    const none = codexExecArgs({ ...base, resume_session_id: null } as never, {});
    expect(none.join(" ")).not.toContain("--output-schema");
  });
});

describe("codex normalized input measurement", () => {
  function normalized(usage: Record<string, unknown>) {
    return parseCodexEvent({ type: "turn.completed", usage }, "counters")?.find(
      (event) => event.type === "usage",
    )?.usage?.input_token_usage;
  }
  it("keeps reads and writes separate, including measured zero", () => {
    expect(
      normalized({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 10 }),
    ).toEqual({
      total_tokens: 100,
      cache_read_tokens: 80,
      cache_write_tokens: 10,
    });
    expect(
      normalized({ input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 }),
    ).toEqual({
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });
  it.each([0, 1, 2])("preserves each independently missing component %s", (missing) => {
    const fields = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens"];
    const native: Record<string, unknown> = Object.fromEntries(
      fields.map((field, index) => [field, [100, 80, 10][index]]),
    );
    delete native[fields[missing]!];
    expect(normalized(native)).toEqual({
      total_tokens: missing === 0 ? null : 100,
      cache_read_tokens: missing === 1 ? null : 80,
      cache_write_tokens: missing === 2 ? null : 10,
    });
  });
  it.each([undefined, null, -1, 0.5, "10", Infinity, NaN])(
    "preserves unknown write rather than treating %j as zero",
    (value) => {
      expect(
        normalized({ input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: value }),
      ).toEqual({
        total_tokens: 100,
        cache_read_tokens: 80,
        cache_write_tokens: null,
      });
    },
  );
});

describe("tool targets are the agent's own actions, kept exact (INV-146)", () => {
  it("keeps a credential-shaped command and file path in the tool target", () => {
    const token = ["ghp", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("_");
    const command = parseCodexEvent(
      {
        type: "item.started",
        item: {
          id: "i1",
          type: "command_execution",
          command: `export KEY=${token}`,
          status: "in_progress",
        },
      },
      "s1",
    );
    expect(command?.[0]?.tool?.target).toBe(`export KEY=${token}`);
    const change = parseCodexEvent(
      {
        type: "item.started",
        item: {
          id: "i2",
          type: "file_change",
          changes: [{ path: `keys/${token}.txt`, kind: "add" }],
          status: "in_progress",
        },
      },
      "s1",
    );
    expect(change?.[0]?.tool?.target).toBe(`keys/${token}.txt`);
  });
});
