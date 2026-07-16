import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { parseCodexEvent } from "./parse.js";

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
  it("maps a realistic codex exec --json stream to normalized typed events", () => {
    const state = {};
    const events = SAMPLE.flatMap((l) => parseCodexEvent(JSON.parse(l), "s1", state) ?? []);
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toContain("started");
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

    const usage = events.find((e) => e.type === "usage");
    expect(usage?.usage?.input_tokens).toBe(100);

    const msg = events.find((e) => e.type === "message");
    expect(msg?.text).toBe("Done.");

    // codex has NO native final marker: the adapter finalizes the turn's
    // LAST agent message as a typed `final` message on turn.completed
    // (vendor semantics — --output-last-message / task_complete). Ф2.5 W-C1.
    const finals = events.filter((e) => e.type === "message" && e.final === true);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe("Done.");
    expect(finals[0]?.payload?.["final_source"]).toBe("last_agent_message");
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
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: {
          type: "todo_list",
          items: [
            { text: "step one", completed: true },
            { text: "step two", completed: false },
          ],
        },
      },
      "s1",
    );
    const ev = out?.[0];
    expect(ev?.type).toBe("message");
    expect(ev?.plan_progress?.items).toEqual([
      { id: "codex-0", title: "step one", status: "completed" },
      { id: "codex-1", title: "step two", status: "pending" },
    ]);
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
