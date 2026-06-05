import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudex/schema";
import { parseClaudeEvent } from "./parse.js";

describe("parseClaudeEvent", () => {
  it("maps system init to a started event with observed model", () => {
    const out = parseClaudeEvent(
      { type: "system", subtype: "init", model: "claude-opus", tools: ["Read"] },
      "s1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe("started");
    expect(out[0]?.observed_model).toBe("claude-opus");
    expect(() => HarnessEvent.parse(out[0])).not.toThrow();
  });

  it("splits an assistant message into text + edit file_change events", () => {
    const out = parseClaudeEvent(
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Editing file." },
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      "s1",
    );
    const types = out.map((e) => e.type);
    expect(types).toEqual(["message", "file_change", "tool_call"]);
    const fc = out.find((e) => e.type === "file_change");
    expect(fc?.payload?.["path"]).toBe("src/a.ts");
    for (const e of out) expect(() => HarnessEvent.parse(e)).not.toThrow();
  });

  it("maps result to usage (+ error on non-success subtype)", () => {
    const ok = parseClaudeEvent(
      { type: "result", subtype: "success", total_cost_usd: 0.25, usage: { input_tokens: 10 } },
      "s1",
    );
    expect(ok.map((e) => e.type)).toEqual(["usage"]);
    expect(ok[0]?.usage?.cost_usd).toBe(0.25);

    const failed = parseClaudeEvent({ type: "result", subtype: "error_max_turns" }, "s1");
    expect(failed.map((e) => e.type)).toEqual(["usage", "error"]);
  });
});
