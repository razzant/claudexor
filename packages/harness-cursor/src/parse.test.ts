import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { createCursorParser, parseCursorEvent } from "./parse.js";

describe("parseCursorEvent", () => {
  it("maps the documented variant-keyed tool_call shape (started/completed) to typed events", () => {
    const parse = createCursorParser();
    const events = [
      parse({ type: "system", subtype: "init", model: "gpt-5" }, "s1"),
      parse({ type: "assistant", message: { content: [{ text: "All done" }] } }, "s1"),
      // Documented headless shape: tool_call.writeToolCall.args.path + subtype lifecycle.
      parse(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "c1",
          tool_call: { writeToolCall: { args: { path: "a.ts", fileText: "x" } } },
        },
        "s1",
      ),
      parse(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "c1",
          tool_call: { writeToolCall: { args: { path: "a.ts" }, result: { linesCreated: 1 } } },
        },
        "s1",
      ),
      parse({ type: "result", total_cost_usd: 0.02, subtype: "success", result: "All done" }, "s1"),
    ].flatMap((e) => e ?? []);

    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();
    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("message");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("file_change");
    expect(types).toContain("usage");
    // The terminal result is cursor's TYPED final answer (F2.5 W-C1).
    const finalMsg = events.find((e) => e.type === "message" && e.final === true);
    expect(finalMsg?.text).toBe("All done");

    // --stream-partial-output taxonomy (W-C4): delta = timestamp_ms without
    // model_call_id; buffered snapshot = both (evidence only); final flush =
    // neither (a plain message).
    const delta = parse(
      { type: "assistant", timestamp_ms: 123, message: { content: [{ text: "chu" }] } },
      "s1",
    );
    expect(delta?.[0]?.payload?.["delta"]).toBe(true);
    expect(delta?.[0]?.text).toBe("chu");
    const buffered = parse(
      {
        type: "assistant",
        timestamp_ms: 124,
        model_call_id: "mc1",
        message: { content: [{ text: "chu" }] },
      },
      "s1",
    );
    expect(buffered?.[0]).toMatchObject({
      type: "message",
      text: "chu",
      payload: { buffered: true, model_call_id: "mc1" },
    });
    const flush = parse({ type: "assistant", message: { content: [{ text: "chunk" }] } }, "s1");
    expect(flush?.[0]?.payload?.["delta"]).toBeUndefined();

    expect(events.find((e) => e.type === "started")?.observed_model).toBe("gpt-5");
    const call = events.find((e) => e.type === "tool_call");
    expect(call?.tool?.name).toBe("write");
    expect(call?.tool?.kind).toBe("file");
    expect(call?.tool?.target).toContain("a.ts");
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.tool?.status).toBe("ok");
    expect(result?.tool?.use_id).toBe("c1");
    expect(events.find((e) => e.type === "file_change")?.payload?.["path"]).toBe("a.ts");
    // the final `result` text must surface as a message
    expect(events.filter((e) => e.type === "message").map((e) => e.text)).toContain("All done");
  });

  it("maps failed tool calls to error tool_results", () => {
    const parse = createCursorParser();
    parse(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c2",
        tool_call: { shellToolCall: { args: { command: "pnpm test" } } },
      },
      "s1",
    );
    const out = parse(
      {
        type: "tool_call",
        subtype: "failed",
        call_id: "c2",
        tool_call: {
          shellToolCall: { args: { command: "pnpm test" }, result: { error: "exit 1" } },
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.tool?.status).toBe("error");
    expect(out[0]?.tool?.kind).toBe("command");
    expect(out[0]?.tool?.error_summary).toContain("exit 1");
  });

  it("maps native completed-tool failure payloads to error, never ok", () => {
    const parse = createCursorParser();
    parse(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "native-failure",
        tool_call: { editToolCall: { args: { path: "game.js" } } },
      },
      "s1",
    );
    const out = parse(
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "native-failure",
        tool_call: {
          editToolCall: {
            args: { path: "game.js" },
            result: { failure: { exitCode: 1, error: "Invalid arguments: path required" } },
          },
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.tool?.status).toBe("error");
    expect(out[0]?.tool?.error_summary).toContain("failure");
  });

  it("maps rejected tool calls to denied diagnostics, not ok", () => {
    const parse = createCursorParser();
    parse(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c3",
        tool_call: { webFetchToolCall: { args: { url: "https://example.com" } } },
      },
      "s1",
    );
    const out = parse(
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c3",
        tool_call: {
          webFetchToolCall: {
            args: { url: "https://example.com" },
            result: { rejected: { reason: "User Rejected" } },
          },
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(out[0]?.type).toBe("tool_result");
    expect(out[0]?.tool?.status).toBe("denied");
    expect(out[0]?.tool?.kind).toBe("web");
    expect(out[0]?.tool?.error_summary).toBeUndefined();
    expect(out[0]?.tool?.content_summary).toContain("User Rejected");
  });

  it("maps current permissionDenied tool results to denied diagnostics, never ok or error", () => {
    const variants = [
      {
        command: "printf DENIED_FIXTURE_COMMAND",
        workingDirectory: "/repo",
        error: "Shell access is unavailable in Ask mode",
        isReadonly: true,
      },
      true,
    ];

    for (const permissionDenied of variants) {
      const parse = createCursorParser();
      parse(
        {
          type: "tool_call",
          subtype: "started",
          call_id: "permission-denied",
          tool_call: {
            shellToolCall: {
              args: { command: "printf DENIED_FIXTURE_COMMAND", workingDirectory: "/repo" },
            },
          },
        },
        "s1",
      );
      const out = parse(
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "permission-denied",
          tool_call: {
            shellToolCall: {
              result: { permissionDenied },
            },
          },
        },
        "s1",
      ) as HarnessEvent[];

      expect(out).toHaveLength(1);
      expect(out[0]?.type).toBe("tool_result");
      expect(out[0]?.tool?.status).toBe("denied");
      expect(out[0]?.tool?.kind).toBe("command");
      expect(out[0]?.tool?.error_summary).toBeUndefined();
      expect(out[0]?.tool?.content_summary).toContain("permissionDenied");
      if (typeof permissionDenied === "object") {
        expect(out[0]?.tool?.content_summary).toContain("Ask mode");
      }
      expect(out[0]?.tool?.content_summary?.length).toBeLessThanOrEqual(300);
      expect(out.some((event) => event.type === "file_change")).toBe(false);
    }
  });

  it("maps error events and counts unknown shapes as null", () => {
    const out = parseCursorEvent({ type: "error", message: "boom" }, "s1") as HarnessEvent[];
    expect(out[0]?.type).toBe("error");
  });

  it("skips only strict user prompt echoes", () => {
    expect(
      parseCursorEvent(
        {
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "Build the fixture" }] },
          extra: { vendor: true },
        },
        "s1",
      ),
    ).toEqual([]);
    expect(
      parseCursorEvent(
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Build " },
              { type: "text", text: "the fixture" },
            ],
          },
        },
        "s1",
      ),
    ).toEqual([]);

    const malformed = [
      { type: "user", message: { role: "user", content: [] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "" }] } },
      { type: "user", message: { role: "assistant", content: [{ type: "text", text: "x" }] } },
      { type: "user", message: { role: "user", content: "x" } },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { type: "image", url: "fixture.png" },
          ],
        },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
      },
      { type: "user", message: { role: "user", content: [{ type: "future", text: "x" }] } },
    ];
    for (const event of malformed) expect(parseCursorEvent(event, "s1")).toBeNull();
  });

  it("maps current token-only result usage without inventing cost", () => {
    const out = parseCursorEvent(
      {
        type: "result",
        subtype: "success",
        result: "Done",
        usage: {
          inputTokens: 23_654,
          outputTokens: 223,
          cacheReadTokens: 3_712,
          cacheWriteTokens: 0,
        },
      },
      "s1",
    ) as HarnessEvent[];

    const usage = out.find((event) => event.type === "usage");
    expect(usage?.usage).toEqual({
      input_tokens: 23_654,
      output_tokens: 223,
      cached_input_tokens: 3_712,
      input_token_usage: { total_tokens: 27_366, cache_read_tokens: 3_712, cache_write_tokens: 0 },
    });
    expect(usage?.usage?.cost_usd).toBeUndefined();
    expect(() => HarnessEvent.parse(usage)).not.toThrow();

    const mixed = parseCursorEvent(
      {
        type: "result",
        subtype: "success",
        result: "Done",
        total_cost_usd: 0,
        usage: {
          inputTokens: 0,
          outputTokens: "not-a-number",
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
        },
      },
      "s1",
    ) as HarnessEvent[];
    expect(mixed.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(mixed.find((event) => event.type === "usage")?.usage).toEqual({
      input_tokens: 0,
      cached_input_tokens: 5,
      cost_usd: 0,
      input_token_usage: { total_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 3 },
    });

    const absent = parseCursorEvent(
      {
        type: "result",
        subtype: "success",
        result: "Done",
        total_cost_usd: "not-a-number",
        usage: { inputTokens: null, outputTokens: "not-a-number" },
      },
      "s1",
    ) as HarnessEvent[];
    expect(absent.some((event) => event.type === "usage")).toBe(false);
  });

  it("an is_error result is never a typed final — its prose rides a status event, not a message (sol #1 + A3)", () => {
    const failed = parseCursorEvent(
      { type: "result", subtype: "error", is_error: true, result: "partial" },
      "s1",
    ) as HarnessEvent[];
    // A3 deliverable hygiene: no message at all — the answer assembly must
    // never adopt a failed result's prose as answer material.
    expect(failed.some((e) => e.type === "message")).toBe(false);
    const status = failed.find((e) => e.payload?.["non_success_result"] === true);
    expect(status?.type).toBe("status");
    expect(status?.text).toBe("partial");
    expect(failed.some((e) => e.type === "error")).toBe(true);
    expect(parseCursorEvent({ type: "brand_new_event" }, "s1")).toBeNull();
  });

  it("uses the last complete assistant message as final, not Cursor's concatenated result", () => {
    const parse = createCursorParser();
    parse({ type: "assistant", message: { content: [{ text: "progress" }] } }, "s1");
    parse({ type: "assistant", message: { content: [{ text: "Final answer only" }] } }, "s1");
    const result = parse(
      {
        type: "result",
        subtype: "success",
        result: "progressFinal answer only",
      },
      "s1",
    ) as HarnessEvent[];
    const final = result.find((event) => event.type === "message");
    expect(final?.text).toBe("Final answer only");
    expect(final?.final).toBe(true);
    expect(final?.payload?.["final_source"]).toBe("assistant_message");
  });
});

describe("cursor normalized input measurement", () => {
  function normalized(usage: Record<string, unknown>) {
    return parseCursorEvent({ type: "result", usage }, "counters")?.find(
      (event) => event.type === "usage",
    )?.usage?.input_token_usage;
  }
  it("keeps reads and writes separate, including measured zero", () => {
    expect(normalized({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 10 })).toEqual({
      total_tokens: 190,
      cache_read_tokens: 80,
      cache_write_tokens: 10,
    });
    expect(normalized({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });
  it.each([0, 1, 2])("preserves each independently missing component %s", (missing) => {
    const fields = ["inputTokens", "cacheReadTokens", "cacheWriteTokens"];
    const native: Record<string, unknown> = Object.fromEntries(
      fields.map((field, index) => [field, [100, 80, 10][index]]),
    );
    delete native[fields[missing]!];
    expect(normalized(native)).toEqual({
      total_tokens: null,
      cache_read_tokens: missing === 1 ? null : 80,
      cache_write_tokens: missing === 2 ? null : 10,
    });
  });
  it.each([undefined, null, -1, 0.5, "10", Infinity, NaN])(
    "preserves unknown write rather than treating %j as zero",
    (value) => {
      expect(
        normalized({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: value }),
      ).toEqual({
        total_tokens: null,
        cache_read_tokens: 80,
        cache_write_tokens: null,
      });
    },
  );
});

describe("tool targets are the agent's own actions, kept exact (INV-146)", () => {
  it("keeps a credential-shaped command in the tool target", () => {
    const token = ["ghp", "q7Lm2Xv9Rk4Tz8Nw3Bp6Hs1Jd5Gf0Yc2Ae9U"].join("_");
    const out = createCursorParser()(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c9",
        tool_call: { shellToolCall: { args: { command: `export KEY=${token}` } } },
      },
      "s1",
    );
    expect(out?.[0]?.tool?.target).toBe(`export KEY=${token}`);
  });
});
