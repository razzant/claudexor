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
    const events = SAMPLE.flatMap((l) => parseCodexEvent(JSON.parse(l), "s1") ?? []);
    for (const e of events) expect(() => HarnessEvent.parse(e)).not.toThrow();

    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("file_change");
    expect(types).toContain("message");
    expect(types).toContain("usage");

    const fileChange = events.find((e) => e.type === "file_change" && e.payload?.["path"] === "src/a.ts");
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
  });

  it("maps failed command executions to error tool_results (status + exit code)", () => {
    const out = parseCodexEvent(
      {
        type: "item.completed",
        item: { id: "i9", type: "command_execution", command: "pnpm test", exit_code: 1, status: "failed", aggregated_output: "2 tests failed" },
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
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "x", status: "failed", error: "search backend unavailable" } },
      "s1",
    );
    expect(out?.[0]?.type).toBe("tool_result");
    expect(out?.[0]?.tool?.kind).toBe("web");
    expect(out?.[0]?.tool?.status).toBe("error");
    expect(out?.[0]?.tool?.error_summary).toContain("search backend unavailable");
  });

  it("maps turn/item progress events instead of dropping live progress", () => {
    expect(parseCodexEvent({ type: "turn.started", turn_id: "t1" }, "s1")?.[0]?.type).toBe("thinking");
    const cmd = parseCodexEvent(
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" } },
      "s1",
    );
    expect(cmd?.[0]?.type).toBe("tool_call");
    expect(cmd?.[0]?.text).toBe("ls");
    expect(cmd?.[0]?.payload?.["status"]).toBe("in_progress");
    // updated progress ticks are recognized-but-skipped, not dropped
    expect(
      parseCodexEvent({ type: "item.updated", item: { id: "i1", type: "command_execution", command: "ls" } }, "s1"),
    ).toEqual([]);
    // unknown item types are null so the run loop counts them
    expect(parseCodexEvent({ type: "item.started", item: { type: "agent_message" } }, "s1")).toBeNull();
    expect(parseCodexEvent({ type: "something.new" }, "s1")).toBeNull();
  });

  it("maps error and turn.failed to error events", () => {
    expect(parseCodexEvent({ type: "error", message: "boom" }, "s1")?.[0]?.type).toBe("error");
    expect(parseCodexEvent({ type: "turn.failed", error: { message: "x" } }, "s1")?.[0]?.error).toBe("x");
  });
});
