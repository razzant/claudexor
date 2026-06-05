import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudex/schema";
import { parseOpenCodeEvent } from "./parse.js";

describe("parseOpenCodeEvent", () => {
  it("maps message/tool/error shapes", () => {
    const msg = parseOpenCodeEvent({ type: "message", text: "hi there" }, "s1");
    expect(msg[0]?.type).toBe("message");
    expect(msg[0]?.text).toBe("hi there");

    const edit = parseOpenCodeEvent({ type: "tool", tool: "edit", path: "a.ts" }, "s1");
    expect(edit[0]?.type).toBe("file_change");
    expect(edit[0]?.payload?.["path"]).toBe("a.ts");

    const tool = parseOpenCodeEvent({ type: "tool", tool: "bash" }, "s1");
    expect(tool[0]?.type).toBe("tool_call");

    const err = parseOpenCodeEvent({ type: "error", error: "boom" }, "s1");
    expect(err[0]?.type).toBe("error");

    for (const e of [...msg, ...edit, ...tool, ...err]) expect(() => HarnessEvent.parse(e)).not.toThrow();
  });
});
