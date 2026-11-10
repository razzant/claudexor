import { describe, expect, it, vi } from "vitest";
import { RunWaitManyInput, RunWaitManyResult } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/RunWaitManyInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/RunWaitManyResult.schema.json" with { type: "json" };
import { defaultClaudexorTools, type RunnerFn } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";

const TOKEN = "A".repeat(43);
const body: RunWaitManyResult = {
  wakeReason: "attention",
  attention: [1],
  summaries: [
    { status: null, pending: null, token: null, problem: "snapshot_unavailable" },
    { status: "running", pending: true, token: TOKEN, problem: null },
  ],
};

function tool(runner: RunnerFn) {
  const matches = defaultClaudexorTools(runner).filter((t) => t.name === "claudexor_runs_wait");
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("claudexor_runs_wait", () => {
  it("registers once with schema-owned compact input/output and read-only hints", () => {
    const runner = vi.fn(async () => body);
    const wait = tool(runner);
    expect(wait.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(wait.inputSchema).toEqual(inlineJsonSchemaRefs(inputSchema));
    expect(wait.outputSchema).toEqual(inlineJsonSchemaRefs(resultSchema));
    expect(wait.runMode).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not add the collection observer to the Delegate belt", () => {
    const runner = vi.fn();
    expect(
      beltClaudexorTools(runner, {
        parentRunId: "parent",
        repoRoot: "/fixture",
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "unlimited" },
      }).some((t) => t.name === "claudexor_runs_wait"),
    ).toBe(false);
  });

  it("dispatches __runs_wait with omitted wait, normalized handles and the host signal", async () => {
    const runner = vi.fn(async () => body);
    const signal = new AbortController().signal;
    // A null seen acknowledges the problem row it echoes.
    const args = {
      targets: [
        { runId: " job-a ", seen: null },
        { runId: "run-a", seen: TOKEN },
      ],
    };
    expect(await tool(runner).handler(args, { signal })).toEqual({
      text: JSON.stringify(body),
      structured: body,
    });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      {
        mode: "__runs_wait",
        targets: [
          { runId: "job-a", seen: null },
          { runId: "run-a", seen: TOKEN },
        ],
      },
      { signal },
    );
    expect(args.targets[0]!.runId).toBe(" job-a ");
  });

  it("forwards only a true includeBlocking and advertises the blocking row it returns (#628)", async () => {
    const marked: RunWaitManyResult = {
      wakeReason: "attention",
      attention: [0],
      summaries: [
        { status: "running", pending: true, token: TOKEN, problem: null, blocking: false },
      ],
    };
    const runner = vi.fn<RunnerFn>(async () => marked);
    const targets = [{ runId: "job-a" }];
    expect(await tool(runner).handler({ targets, includeBlocking: true }, {})).toEqual({
      text: JSON.stringify(marked),
      structured: marked,
    });
    await tool(runner).handler({ targets, includeBlocking: false }, {});
    expect(runner.mock.calls.map(([input]) => input)).toEqual([
      { mode: "__runs_wait", targets, includeBlocking: true },
      // false is the daemon default; sending it would only fail on an older daemon.
      { mode: "__runs_wait", targets },
    ]);
    const input = tool(runner).inputSchema as { properties: Record<string, { type?: string }> };
    expect(input.properties["includeBlocking"]).toMatchObject({ type: "boolean" });
    expect(JSON.stringify(tool(runner).outputSchema)).toContain('"blocking"');
  });

  it.each([0, 50_000])(
    "forwards explicit wait boundary %i unchanged, preserving duplicates",
    async (waitMs) => {
      const duplicate: RunWaitManyResult = {
        wakeReason: "timeout",
        attention: [],
        summaries: Array.from({ length: 2 }, () => ({
          status: "running",
          pending: true,
          token: TOKEN,
          problem: null,
        })),
      };
      const runner = vi.fn(async () => duplicate);
      const targets = [
        { runId: "job-a", seen: TOKEN },
        { runId: "job-a", seen: TOKEN },
      ];
      await tool(runner).handler({ targets, waitMs }, {});
      expect(runner).toHaveBeenCalledExactlyOnceWith(
        { mode: "__runs_wait", targets, waitMs },
        { signal: undefined },
      );
    },
  );

  it.each([
    {},
    { targets: [] },
    { targets: Array.from({ length: 1001 }, () => ({ runId: "r" })) },
    { targets: [{ runId: " \t " }] },
    { targets: [{ runId: "x".repeat(257) }] },
    { targets: [{ runId: "r", seen: "A".repeat(42) }] },
    { targets: [{ runId: "r", seen: `${"A".repeat(42)}+` }] },
    { targets: [{ runId: "r", afterSeq: 1 }] },
    { targets: [{ runId: "r" }], afterSeq: 1 },
    { targets: [{ runId: "r" }], waitMs: -1 },
    { targets: [{ runId: "r" }], waitMs: 50_001 },
    { targets: [{ runId: "r" }], waitMs: 0.5 },
    { targets: [{ runId: "r" }], waitMs: "0" },
    { targets: [{ runId: "r" }], waitMs: null },
  ])(
    "rejects strict contract violation case %# in direct handlers before the runner",
    async (args) => {
      const runner = vi.fn();
      expect(RunWaitManyInput.safeParse(args).success).toBe(false);
      expect(await tool(runner).handler(args, {})).toMatchObject({ isError: true });
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("rejects aggregate request bytes that generated JSON Schema alone cannot bound", async () => {
    const args = {
      targets: Array.from({ length: 1000 }, () => ({ runId: "\u0001".repeat(256) })),
      waitMs: 0,
    };
    expect(Buffer.byteLength(JSON.stringify(args), "utf8")).toBeGreaterThan(1_048_576);
    const runner = vi.fn();
    expect(await tool(runner).handler(args, {})).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves omitted waitMs at exactly 1MiB for downstream admission", async () => {
    let controls = 155_910;
    const targets = Array.from({ length: 1000 }, () => {
      const count = Math.min(256, controls);
      controls -= count;
      return { runId: "\u0001".repeat(count) + "x".repeat(256 - count) };
    });
    targets[999]!.runId = "€" + "é".repeat(11) + "x".repeat(244);
    const input = { targets };
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBe(1_048_576);
    const result: RunWaitManyResult = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({
        status: "interrupted",
        pending: false,
        token: TOKEN,
        problem: null,
      })),
    };
    const runner = vi.fn(async (params: Record<string, unknown>) => {
      const { mode, ...wire } = params;
      expect(mode).toBe("__runs_wait");
      expect(Buffer.byteLength(JSON.stringify(wire), "utf8")).toBe(1_048_576);
      expect(wire).toEqual(input);
      expect(wire).not.toHaveProperty("waitMs");
      // Downstream admission still applies the ordinary default, without a
      // second charge for bytes that the caller never supplied.
      expect(RunWaitManyInput.parse(wire).waitMs).toBe(25_000);
      return result;
    });
    const output = await tool(runner).handler(input, {});
    if (typeof output === "string") throw new Error("expected compact structured output");
    expect(output.isError).not.toBe(true);
    expect(output.structured).toEqual(result);
    expect(output.text).toBe(JSON.stringify(result));
    expect(runner).toHaveBeenCalledOnce();
    runner.mockClear();
    const overLimit = {
      targets: [...targets.slice(0, 999), { runId: "€" + "é".repeat(12) + "x".repeat(243) }],
    };
    expect(Buffer.byteLength(JSON.stringify(overLimit), "utf8")).toBe(1_048_577);
    expect(await tool(runner).handler(overLimit, {})).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps text equal to structured JSON for all 1000 longest rows without adding fields", async () => {
    const large: RunWaitManyResult = {
      wakeReason: "attention",
      attention: Array.from({ length: 1000 }, (_, i) => i),
      summaries: Array.from({ length: 1000 }, () => ({
        status: "interrupted",
        pending: false,
        token: TOKEN,
        problem: null,
      })),
    };
    const runner = vi.fn(async () => large);
    const output = await tool(runner).handler(
      {
        targets: Array.from({ length: 1000 }, () => ({ runId: "x".repeat(256) })),
      },
      {},
    );
    if (typeof output === "string") throw new Error("wait-many must provide structured content");
    expect(output.isError).not.toBe(true);
    expect(output.text).toBe(JSON.stringify(large));
    expect(JSON.parse(output.text)).toEqual(output.structured);
    expect(RunWaitManyResult.parse(output.structured)).toEqual(large);
    expect(Buffer.byteLength(output.text, "utf8")).toBe(113_944);
    expect(Buffer.byteLength(JSON.stringify(output.structured), "utf8")).toBeLessThanOrEqual(
      131_072,
    );
    // The MCP protocol duplicates text and structured content; only the logical
    // result has the 128 KiB cap, not the enclosing duplicated protocol packet.
    expect(runner).toHaveBeenCalledOnce();
  });

  it("preserves typed unavailable-daemon evidence as a tool error", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("compact observation is unavailable"), {
        code: "run_observation_unavailable",
        retryable: false,
        requiredActions: ["use a daemon supporting wait-many"],
      });
    });
    expect(await tool(runner).handler({ targets: [{ runId: "r" }] }, {})).toMatchObject({
      isError: true,
      structured: {
        status: "failed",
        failure: {
          code: "run_observation_unavailable",
          retryable: false,
          requiredActions: ["use a daemon supporting wait-many"],
        },
      },
    });
    expect(runner).toHaveBeenCalledOnce();
  });
});
