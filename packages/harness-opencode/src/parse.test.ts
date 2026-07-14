import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudexor/schema";
import { parseOpenCodeEvent } from "./parse.js";

describe("parseOpenCodeEvent", () => {
  it("maps message/tool/error shapes", () => {
    const msg = parseOpenCodeEvent({ type: "message", text: "hi there" }, "s1") ?? [];
    expect(msg[0]?.type).toBe("message");
    expect(msg[0]?.text).toBe("hi there");

    const edit = parseOpenCodeEvent({ type: "tool", tool: "edit", path: "a.ts" }, "s1") ?? [];
    expect(edit[0]?.type).toBe("file_change");
    expect(edit[0]?.payload?.["path"]).toBe("a.ts");

    const tool = parseOpenCodeEvent({ type: "tool", tool: "bash" }, "s1") ?? [];
    expect(tool[0]?.type).toBe("tool_call");

    const err = parseOpenCodeEvent({ type: "error", error: "boom" }, "s1") ?? [];
    expect(err[0]?.type).toBe("error");

    for (const e of [...msg, ...edit, ...tool, ...err])
      expect(() => HarnessEvent.parse(e)).not.toThrow();
  });

  it("reads token counts from BOTH the flat tokens shape and the nested usage shape", () => {
    // Flat shape: { tokens: { input, output, cache } }.
    const flat = parseOpenCodeEvent(
      { type: "usage", cost: 0.03, tokens: { input: 500, output: 80, cache: 100 } },
      "s1",
    );
    expect(flat?.[0]?.usage).toMatchObject({
      cost_usd: 0.03,
      input_tokens: 500,
      output_tokens: 80,
      cached_input_tokens: 100,
    });

    // Nested shape on a `finish` event: { usage: { input_tokens, output_tokens } }.
    // Previously the cost-only branch dropped these token counts silently.
    const nested = parseOpenCodeEvent(
      { type: "finish", usage: { input_tokens: 300, output_tokens: 60 }, cost: 0.004 },
      "s1",
    );
    expect(nested?.[0]?.type).toBe("usage");
    expect(nested?.[0]?.usage).toMatchObject({
      cost_usd: 0.004,
      input_tokens: 300,
      output_tokens: 60,
    });
    expect(() => HarnessEvent.parse(nested?.[0])).not.toThrow();
  });
});
