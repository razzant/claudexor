import { describe, expect, it, vi } from "vitest";
import { TaskGroupRunsInput, TaskGroupRunsResult } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/TaskGroupRunsInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/TaskGroupRunsResult.schema.json" with { type: "json" };
import { defaultClaudexorTools, type RunnerFn } from "./index.js";
import { beltClaudexorTools } from "./delegation-belt.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";

const GROUP = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const body = {
  taskGroupId: GROUP,
  storeId: STORE,
  visibility: "current_served_generations" as const,
  retention: "retained_only" as const,
  viewToken: "A".repeat(43),
  members: [
    {
      jobId: "job-a",
      runId: null,
      createdAt: "2026-10-22T00:00:00.000Z",
      observation: {
        status: null,
        pending: null,
        token: null,
        problem: "snapshot_unavailable" as const,
      },
    },
  ],
  hasMore: true,
  nextCursor: "next-page",
};
function tool(runner: RunnerFn) {
  const matches = defaultClaudexorTools(runner).filter(
    (t) => t.name === "claudexor_task_group_runs",
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("claudexor_task_group_runs thin recovery surface", () => {
  it("registers canonical schema-owned input/output with read-only hints", () => {
    const runner = vi.fn();
    const read = tool(runner);
    expect(read.inputSchema).toEqual(inlineJsonSchemaRefs(inputSchema));
    expect(read.outputSchema).toEqual(inlineJsonSchemaRefs(resultSchema));
    expect(read.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(read.runMode).toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("forwards exactly one bounded page with filters and host signal; text equals structured JSON", async () => {
    const runner = vi.fn(async () => body);
    const signal = new AbortController().signal;
    const input = {
      taskGroupId: GROUP,
      limit: 2,
      state: "queued",
      cursor: "opaque+/=&",
      expectedStoreId: STORE,
    };
    const output = await tool(runner).handler(input, { signal });
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      { mode: "__task_group_runs", ...input },
      { signal },
    );
    expect(output).toEqual({ text: JSON.stringify(body), structured: body });
    if (typeof output === "string") throw new Error("expected typed group page");
    expect(TaskGroupRunsResult.parse(output.structured)).toEqual(body);
    expect(Buffer.byteLength(output.text, "utf8")).toBeLessThanOrEqual(131_072);
  });

  it("uses the shared default page limit without requiring a hidden traversal", async () => {
    const runner = vi.fn<RunnerFn>(async () => body);
    await tool(runner).handler({ taskGroupId: GROUP }, {});
    expect(runner).toHaveBeenCalledOnce();
    const [wire, context] = runner.mock.calls[0]!;
    // Omission may be preserved on the wire; admission still uses the schema default.
    const { mode, ...input } = wire;
    expect(mode).toBe("__task_group_runs");
    expect(TaskGroupRunsInput.parse(input)).toEqual({ taskGroupId: GROUP, limit: 50 });
    expect(context).toEqual({ signal: undefined });
  });

  it.each([
    {},
    { taskGroupId: "bad" },
    { taskGroupId: GROUP, limit: 0 },
    { taskGroupId: GROUP, limit: 201 },
    { taskGroupId: GROUP, limit: 1.5 },
    { taskGroupId: GROUP, limit: "50" },
    { taskGroupId: GROUP, state: "pending" },
    { taskGroupId: GROUP, cursor: "c".repeat(2049) },
    { taskGroupId: GROUP, expectedStoreId: "" },
    { taskGroupId: GROUP, total: true },
    { taskGroupId: GROUP, resume: true },
    { taskGroupId: GROUP, afterSeq: 0 },
  ])("rejects strict invalid input before runner invocation: %j", async (input) => {
    const runner = vi.fn();
    expect(TaskGroupRunsInput.safeParse(input).success).toBe(false);
    expect(await tool(runner).handler(input, {})).toMatchObject({ isError: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves typed unsupported/stale/store refusal instead of an empty successful page", async () => {
    for (const code of ["task_group_runs_unavailable", "stale_cursor", "store_mismatch"]) {
      const runner = vi.fn(async () => {
        throw Object.assign(new Error("group read refused"), {
          code,
          retryable: false,
          requiredActions: ["read a fresh supporting store view"],
        });
      });
      expect(await tool(runner).handler({ taskGroupId: GROUP }, {})).toMatchObject({
        isError: true,
        structured: {
          status: "failed",
          failure: {
            code,
            retryable: false,
            requiredActions: ["read a fresh supporting store view"],
          },
        },
      });
      expect(runner).toHaveBeenCalledOnce();
    }
  });

  it.each([
    { ...body, total: 5 },
    { ...body, members: [{ ...body.members[0]!, prompt: "body" }] },
    {
      ...body,
      members: [
        {
          ...body.members[0]!,
          observation: {
            status: null,
            pending: false,
            token: null,
            problem: "snapshot_unavailable",
          },
        },
      ],
    },
  ])("refuses malformed/expanded runner output case %#", async (reply) => {
    const runner = vi.fn(async () => reply);
    expect(await tool(runner).handler({ taskGroupId: GROUP }, {})).toMatchObject({ isError: true });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("does not expose task group recovery through the Delegate belt", () => {
    const runner = vi.fn();
    expect(
      beltClaudexorTools(runner, {
        parentRunId: "parent",
        repoRoot: "/fixture",
        depth: 0,
        maxSubRuns: 8,
        parentBudget: { kind: "unlimited" },
      }).some((t) => t.name === "claudexor_task_group_runs"),
    ).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
