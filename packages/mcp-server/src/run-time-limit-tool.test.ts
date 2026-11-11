import { describe, expect, it } from "vitest";
import { runTimeLimitTool } from "./run-time-limit-tool.js";
import { defaultClaudexorTools } from "./index.js";

describe("MCP run time limit tool", () => {
  it("advertises initial limits on one-shot and thread turns", () => {
    const tools = defaultClaudexorTools(async () => ({}));
    for (const name of [
      "claudexor_run",
      "claudexor_ask",
      "claudexor_plan",
      "claudexor_thread_turn",
    ]) {
      const properties = (tools.find((tool) => tool.name === name)?.inputSchema as any).properties;
      expect(properties.maxSeconds.maximum).toBe(604800);
      expect(properties.timeLimitMode.enum).toEqual(["soft", "hard"]);
    }
    expect(
      tools.find((tool) => tool.name === "claudexor_run_time_limit")?.annotations?.readOnlyHint,
    ).toBe(false);
  });
  it("forwards a valid revision-guarded extension with a structured result", async () => {
    let request: unknown;
    const tool = runTimeLimitTool(async (input) => {
      request = input;
      return {
        runId: "r1",
        revision: 3,
        mode: "soft",
        state: "armed",
        deadlineAt: null,
        reachedAt: null,
        summary: "ok",
      };
    });
    const result = await tool.handler(
      { runId: "r1", action: "extend", seconds: 30, expectedRevision: 2 },
      {},
    );
    expect(request).toEqual({
      mode: "__run_time_limit",
      runId: "r1",
      request: { action: "extend", seconds: 30, expectedRevision: 2 },
    });
    expect(result).toMatchObject({ structured: { runId: "r1", revision: 3 } });
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it("rejects invalid mutation before calling the runner", async () => {
    let called = false;
    const tool = runTimeLimitTool(async () => {
      called = true;
      return {};
    });
    const result = await tool.handler(
      { runId: "r1", action: "extend", seconds: -1, expectedRevision: 0 },
      {},
    );
    expect(result).toMatchObject({ isError: true });
    expect(called).toBe(false);
  });
});
