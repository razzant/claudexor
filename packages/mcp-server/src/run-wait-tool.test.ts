import { describe, expect, it, vi } from "vitest";
import { defaultClaudexorTools } from "./index.js";

describe("claudexor_run_wait", () => {
  it("registers a read-only tool and forwards normalized arguments and the host signal", async () => {
    const result = { summary: "waiting" };
    const runner = vi.fn(async () => result);
    const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_wait");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const signal = new AbortController().signal;
    expect(await tool!.handler({ runId: "r" }, { signal })).toMatchObject({ structured: result });
    expect(runner).toHaveBeenCalledWith(
      { mode: "__run_wait", runId: "r", afterSeq: 0, waitMs: 25000, maxEvents: 50, wake: "batch" },
      { signal },
    );
    expect(tool?.outputSchema).toBeDefined();
  });

  it("rejects malformed arguments even for direct handlers", async () => {
    const runner = vi.fn();
    const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_wait");
    expect(tool).toBeDefined();
    expect(await tool!.handler({ runId: "r", waitMs: 50001 }, {})).toMatchObject({ isError: true });
    expect(await tool!.handler({ runId: "r", wake: "first" }, {})).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("forwards the explicit event-first mode unchanged", async () => {
    const runner = vi.fn(async () => ({}));
    const tool = defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_wait")!;
    await tool.handler({ runId: "r", waitMs: 0, wake: "event" }, {});
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ waitMs: 0, wake: "event" }),
      expect.anything(),
    );
  });
});
