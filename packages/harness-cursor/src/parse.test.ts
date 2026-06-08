import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { parseCursorEvent } from "./parse.js";

describe("parseCursorEvent", () => {
  it("maps system init, assistant text, edit tool_call, and result", () => {
    const events = [
      parseCursorEvent({ type: "system", subtype: "init", model: "gpt-5" }, "s1"),
      parseCursorEvent({ type: "assistant", message: { content: [{ text: "hello" }] } }, "s1"),
      parseCursorEvent({ type: "tool_call", tool_call: { name: "editFile", args: { path: "a.ts" } } }, "s1"),
      parseCursorEvent({ type: "result", total_cost_usd: 0.02, subtype: "success" }, "s1"),
    ].flat();

    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();
    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("message");
    expect(types).toContain("file_change");
    expect(types).toContain("usage");

    expect(events.find((e) => e.type === "started")?.observed_model).toBe("gpt-5");
    expect(events.find((e) => e.type === "file_change")?.payload?.["path"]).toBe("a.ts");
  });

  it("maps error events", () => {
    const [e] = parseCursorEvent({ type: "error", message: "boom" }, "s1");
    expect(e?.type).toBe("error");
  });
});
