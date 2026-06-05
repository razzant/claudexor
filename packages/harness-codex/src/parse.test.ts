import { describe, expect, it } from "vitest";
import { HarnessEvent } from "@claudex/schema";
import { parseCodexEvent } from "./parse.js";

const SAMPLE = [
  '{"type":"thread.started","thread_id":"th-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i2","type":"file_change","path":"src/a.ts"}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Done."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":0}}',
];

describe("parseCodexEvent", () => {
  it("maps a realistic codex exec --json stream to normalized events", () => {
    const events = SAMPLE.map((l) => parseCodexEvent(JSON.parse(l), "s1")).filter(
      (e): e is HarnessEvent => e !== null,
    );
    // every produced event validates against the schema
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("tool_call");
    expect(types).toContain("file_change");
    expect(types).toContain("message");
    expect(types).toContain("usage");

    const fileChange = events.find((e) => e.type === "file_change");
    expect(fileChange?.payload?.["path"]).toBe("src/a.ts");

    const usage = events.find((e) => e.type === "usage");
    expect(usage?.usage?.input_tokens).toBe(100);

    const msg = events.find((e) => e.type === "message");
    expect(msg?.text).toBe("Done.");
  });

  it("ignores item.started / turn.started", () => {
    expect(parseCodexEvent({ type: "turn.started" }, "s1")).toBeNull();
    expect(parseCodexEvent({ type: "item.started", item: { type: "agent_message" } }, "s1")).toBeNull();
  });

  it("maps error and turn.failed to error events", () => {
    expect(parseCodexEvent({ type: "error", message: "boom" }, "s1")?.type).toBe("error");
    expect(parseCodexEvent({ type: "turn.failed", error: { message: "x" } }, "s1")?.error).toBe("x");
  });
});
