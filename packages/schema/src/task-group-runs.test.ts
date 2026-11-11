import { describe, expect, it } from "vitest";
import { ControlRunState } from "./control.js";
import { RunWaitManySummary } from "./run-observation.js";
import {
  TaskGroupCursor,
  TaskGroupRunsInput,
  TaskGroupRunsResult,
  encodeTaskGroupCursor,
  decodeTaskGroupCursor,
} from "./task-group-runs.js";

const taskGroupId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";
const observation = { status: "queued", pending: false, token: "A".repeat(43), problem: null };
const member = { jobId: "job-a", runId: null, createdAt: "2026-10-22T00:00:00.000Z", observation };
const empty = {
  taskGroupId,
  storeId,
  visibility: "current_served_generations",
  retention: "retained_only",
  viewToken: "B".repeat(43),
  members: [],
  hasMore: false,
  nextCursor: null,
};

describe("retained task group page schemas", () => {
  it("defaults only the bounded page limit and keeps optional filters absent", () => {
    expect(TaskGroupRunsInput.parse({ taskGroupId })).toEqual({ taskGroupId, limit: 50 });
    for (const limit of [1, 200])
      expect(TaskGroupRunsInput.parse({ taskGroupId, limit }).limit).toBe(limit);
    for (const state of ControlRunState.options)
      expect(TaskGroupRunsInput.parse({ taskGroupId, state }).state).toBe(state);
    expect(
      TaskGroupRunsInput.parse({ taskGroupId, cursor: "c".repeat(2048), expectedStoreId: storeId }),
    ).toMatchObject({ cursor: "c".repeat(2048), expectedStoreId: storeId });
  });

  it.each([
    {},
    { taskGroupId: null },
    { taskGroupId: "group" },
    { taskGroupId: ` ${taskGroupId}` },
    ...[0, 201, 1.5, "50", null, Infinity].map((limit) => ({ taskGroupId, limit })),
    ...["pending", "complete", "waiting_on_user", null].map((state) => ({ taskGroupId, state })),
    { taskGroupId, cursor: "c".repeat(2049) },
    { taskGroupId, cursor: null },
    { taskGroupId, expectedStoreId: "" },
    { taskGroupId, expectedStoreId: null },
    { taskGroupId, afterSeq: 1 },
    { taskGroupId, projectId: "p" },
    { taskGroupId, total: true },
  ])("refuses invalid input without silently stripping it: %j", (input) => {
    expect(TaskGroupRunsInput.safeParse(input).success).toBe(false);
  });

  it("keeps empty retained-view qualifiers and actual nullable run binding", () => {
    expect(TaskGroupRunsResult.parse(empty)).toEqual(empty);
    const result = { ...empty, members: [member, { ...member, jobId: "job-b", runId: "run-b" }] };
    expect(TaskGroupRunsResult.parse(result)).toEqual(result);
    expect(TaskGroupRunsResult.parse(result).members[0]!.runId).toBeNull();
    expect(result).not.toHaveProperty("total");
  });

  it("reuses all compact observations, including explicit unavailable rather than pending:false", () => {
    for (const summary of [
      observation,
      ...["not_found", "snapshot_unavailable", "not_observed"].map((problem) => ({
        status: null,
        pending: null,
        token: null,
        problem,
      })),
    ]) {
      const shared = RunWaitManySummary.parse(summary);
      expect(
        TaskGroupRunsResult.parse({ ...empty, members: [{ ...member, observation: shared }] })
          .members[0]!.observation,
      ).toEqual(shared);
    }
  });

  it.each([
    { ...empty, storeId: "" },
    { ...empty, taskGroupId: "wrong" },
    { ...empty, visibility: "all_history" },
    { ...empty, retention: "complete" },
    { ...empty, total: 0 },
    { ...empty, params: {} },
    { ...empty, members: [{ ...member, prompt: "body" }] },
    { ...empty, members: [{ ...member, result: {} }] },
    {
      ...empty,
      members: [
        {
          ...member,
          observation: {
            status: null,
            pending: false,
            token: null,
            problem: "snapshot_unavailable",
          },
        },
      ],
    },
    { ...empty, members: [{ ...member, observation: { ...observation, token: null } }] },
    // Members never carry the wait-many opt-in's blocking fact.
    {
      ...empty,
      members: [{ ...member, observation: { ...observation, pending: true, blocking: false } }],
    },
    { ...empty, members: Array.from({ length: 201 }, () => member) },
    { ...empty, nextCursor: "x".repeat(2049), hasMore: true },
  ])("rejects expanded or malformed output: %j", (result) => {
    expect(TaskGroupRunsResult.safeParse(result).success).toBe(false);
  });

  it("enforces 131072 UTF-8 bytes using multibyte/escaped metadata before projection can truncate", () => {
    const result = { ...empty, members: [{ ...member, jobId: "界".repeat(44_000) }] };
    expect(JSON.stringify(result).length).toBeLessThan(131_072);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(131_072);
    expect(TaskGroupRunsResult.safeParse(result).success).toBe(false);
    expect(
      TaskGroupRunsResult.safeParse({
        ...empty,
        members: [{ ...member, jobId: "\u0001".repeat(30_000) }],
      }).success,
    ).toBe(false);
  });

  it("accepts exactly 131072 logical bytes and rejects the next byte", () => {
    const overhead = Buffer.byteLength(
      JSON.stringify({ ...empty, members: [{ ...member, jobId: "" }] }),
      "utf8",
    );
    const jobId = "j".repeat(131_072 - overhead);
    const exact = { ...empty, members: [{ ...member, jobId }] };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(131_072);
    expect(TaskGroupRunsResult.parse(exact)).toEqual(exact);
    const excess = { ...empty, members: [{ ...member, jobId: jobId + "j" }] };
    expect(Buffer.byteLength(JSON.stringify(excess), "utf8")).toBe(131_073);
    expect(TaskGroupRunsResult.safeParse(excess).success).toBe(false);
  });

  it("reuses the existing nonempty opaque store identity grammar", () => {
    const opaque = "store:retained/opaque-identity";
    expect(TaskGroupRunsInput.parse({ taskGroupId, expectedStoreId: opaque }).expectedStoreId).toBe(
      opaque,
    );
    expect(TaskGroupRunsResult.parse({ ...empty, storeId: opaque }).storeId).toBe(opaque);
  });
});

describe("strict versioned task group cursor codec", () => {
  const cursor = {
    version: 1,
    taskGroupId,
    state: null,
    storeId,
    viewToken: "B".repeat(43),
    last: { createdAt: member.createdAt, id: member.jobId },
  };
  it("round trips the complete binding without binding the mutable page limit", () => {
    expect(TaskGroupCursor.parse(cursor)).toEqual(cursor);
    const encoded = encodeTaskGroupCursor(TaskGroupCursor.parse(cursor));
    expect(encoded.length).toBeLessThanOrEqual(2048);
    expect(decodeTaskGroupCursor(encoded)).toEqual(cursor);
    const opaque = TaskGroupCursor.parse({ ...cursor, storeId: "store:opaque/non-uuid" });
    expect(decodeTaskGroupCursor(encodeTaskGroupCursor(opaque))).toEqual(opaque);
    expect(
      decodeTaskGroupCursor(encodeTaskGroupCursor({ ...cursor, version: 1, state: "running" })),
    ).toEqual({ ...cursor, state: "running" });
  });
  it.each([
    { ...cursor, version: 2 },
    { ...cursor, version: "1" },
    { ...cursor, taskGroupId: "bad" },
    { ...cursor, storeId: "" },
    { ...cursor, state: "waiting_on_user" },
    { ...cursor, state: undefined },
    { ...cursor, limit: 50 },
    { ...cursor, last: { ...cursor.last, offset: 1 } },
    { ...cursor, last: { createdAt: cursor.last.createdAt } },
    { ...cursor, last: { id: "", createdAt: cursor.last.createdAt } },
    { ...cursor, viewToken: undefined },
  ])("rejects malformed/unknown payload fields in both schema and decoder: %j", (payload) => {
    expect(TaskGroupCursor.safeParse(payload).success).toBe(false);
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => decodeTaskGroupCursor(encoded)).toThrow();
  });
  it.each([
    "",
    "not a cursor",
    "a".repeat(2049),
    Buffer.from("null").toString("base64url"),
    Buffer.from("[]").toString("base64url"),
  ])("rejects invalid encoding without an empty-page fallback: %s", (value) => {
    expect(() => decodeTaskGroupCursor(value)).toThrow();
  });
});
