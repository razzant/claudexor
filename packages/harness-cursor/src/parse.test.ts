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
    // model_call_id; buffered duplicate = both (skipped); final flush =
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
    expect(buffered).toEqual([]);
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

  it("maps error events and counts unknown shapes as null", () => {
    const out = parseCursorEvent({ type: "error", message: "boom" }, "s1") as HarnessEvent[];
    expect(out[0]?.type).toBe("error");
  });

  it("an is_error result is never a typed final (sol #1)", () => {
    const failed = parseCursorEvent(
      { type: "result", subtype: "error", is_error: true, result: "partial" },
      "s1",
    ) as HarnessEvent[];
    const msg = failed.find((e) => e.type === "message");
    expect(msg?.text).toBe("partial");
    expect(msg?.final).toBeUndefined();
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
