import { describe, expect, it, vi } from "vitest";
import { defaultClaudexorTools } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";

const part = {
  runId: "run-1",
  seq: 1,
  type: "run.created",
  totalBytes: 9,
  sha256: "a".repeat(64),
  offset: 0,
  nextOffset: 5,
  text: '{"a":',
};

function tool(runner = vi.fn(async () => part)) {
  return defaultClaudexorTools(runner).find((t) => t.name === "claudexor_run_event_read")!;
}

describe("claudexor_run_event_read", () => {
  it("is a read-only tool absent from the Delegate belt", () => {
    const runner = vi.fn();
    expect(tool(runner).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool(runner).outputSchema).toBeDefined();
    expect(
      beltClaudexorTools(runner, {
        parentRunId: "parent",
        repoRoot: "/fixture",
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "unlimited" },
      }).some((t) => t.name === "claudexor_run_event_read"),
    ).toBe(false);
  });

  it("mirrors every range fact and the exact part bytes in text", async () => {
    const runner = vi.fn(async () => part);
    const signal = new AbortController().signal;
    const result = await tool(runner).handler({ runId: "run-1", seq: 1, maxBytes: 5 }, { signal });
    expect(runner).toHaveBeenCalledWith(
      { mode: "__run_event_read", runId: "run-1", seq: 1, offset: 0, maxBytes: 5 },
      { signal },
    );
    expect(result).toMatchObject({ structured: part });
    const text = (result as { text: string }).text;
    const [header, ...rest] = text.split("\n");
    expect(rest.join("\n")).toBe(part.text);
    expect(header).toContain("bytes 0-5 of 9");
    expect(header).toContain(`sha256 ${part.sha256}`);
    expect(header).toContain("read again with offset 5");
  });

  it("tells a text-only client when the event is complete and where to resume", async () => {
    const last = { ...part, offset: 5, nextOffset: 9, text: '"b"}' };
    const result = await tool(vi.fn(async () => last)).handler(
      { runId: "run-1", seq: 1, offset: 5 },
      {},
    );
    expect((result as { text: string }).text.split("\n")[0]).toContain("afterSeq 1");
  });

  it.each([
    { runId: "r" },
    { runId: "r", seq: 1, maxBytes: 65537 },
    { runId: "r", seq: 1, extra: 1 },
  ])("refuses malformed input %j without calling the runner", async (args) => {
    const runner = vi.fn();
    expect(await tool(runner).handler(args, {})).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });
});
