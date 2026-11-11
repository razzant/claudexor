import { describe, expect, it } from "vitest";
import { acceptedReceiptMetadata, TaskGroupId, taskGroupReceiptMetadata } from "./task-group.js";
import {
  ControlQueuedRunInfo,
  ControlRunRetryResponse,
  ControlRunStartInfo,
  ControlRunStartRequest,
  RecordedControlRunStartRequest,
} from "./control.js";
import { COMMAND_SUMMARY_PARAM_KEYS } from "./command-summary.js";
import {
  ControlRunStartResponse,
  ControlThreadTurnRequest,
  ControlThreadTurnResponse,
} from "./control-operation-responses.js";
import {
  ControlThreadCreateRequest,
  ControlThreadUpdateRequest,
} from "./control-thread-requests.js";
import { McpRunToolResult, McpThreadTurnResult } from "./mcp-run-result.js";

const taskGroupId = "11111111-1111-4111-8111-111111111111";
const storeId = "22222222-2222-4222-8222-222222222222";

describe("retained task group contracts", () => {
  it("accepts a caller UUID without creating a group when omitted", () => {
    expect(TaskGroupId.parse(taskGroupId)).toBe(taskGroupId);
    for (const schema of [ControlRunStartRequest, RecordedControlRunStartRequest]) {
      expect(schema.parse({ prompt: "work", taskGroupId })).toHaveProperty(
        "taskGroupId",
        taskGroupId,
      );
      expect(schema.parse({ prompt: "work" })).not.toHaveProperty("taskGroupId");
      for (const invalid of [null, "", "task", 1, ` ${taskGroupId}`])
        expect(schema.safeParse({ prompt: "work", taskGroupId: invalid }).success).toBe(false);
    }
    expect(COMMAND_SUMMARY_PARAM_KEYS).toContain("taskGroupId");
  });

  it("preserves tagged and legacy queued, bound and retry receipt shapes", () => {
    for (const [schema, legacy] of [
      [ControlQueuedRunInfo, { jobId: "job", state: "queued" }],
      [ControlRunStartInfo, { jobId: "job", runId: "run", runDir: "/fixture/run" }],
      [ControlRunStartResponse, { jobId: "job", state: "queued" }],
      [ControlRunStartResponse, { jobId: "job", runId: "run", runDir: "/fixture/run" }],
      [
        ControlRunRetryResponse,
        { retryOf: "source", jobId: "job", runId: null, turnId: null, state: "queued" },
      ],
      [
        McpRunToolResult,
        {
          summary: "queued",
          jobId: "job",
          runId: null,
          runDir: null,
          status: "queued",
          applyEligibility: null,
        },
      ],
    ] as const) {
      expect(schema.parse({ ...legacy, taskGroupId, storeId })).toMatchObject({
        taskGroupId,
        storeId,
      });
      const untagged = schema.parse(legacy);
      expect(untagged).not.toHaveProperty("taskGroupId");
      expect(untagged).not.toHaveProperty("storeId");
    }
  });

  it("lets a thread-turn receipt name its accepting store, with or without a bound run", () => {
    for (const legacy of [
      { threadId: "thread", turnId: "turn", jobId: "job", state: "queued" },
      { threadId: "thread", turnId: "turn", jobId: "job", runId: "run", runDir: "/fixture/run" },
    ]) {
      const untagged = ControlThreadTurnResponse.parse(legacy);
      expect(untagged).not.toHaveProperty("storeId");
      expect(ControlThreadTurnResponse.parse({ ...legacy, storeId })).toMatchObject({ storeId });
      expect(ControlThreadTurnResponse.safeParse({ ...legacy, storeId: "" }).success).toBe(false);
    }
    expect(
      McpThreadTurnResult.parse({
        summary: "queued",
        threadId: "thread",
        turnId: "turn",
        jobId: "job",
        state: "queued",
        storeId,
      }),
    ).toMatchObject({ storeId });
  });

  it("copies a group pair or an ordinary receipt's lone store, never half a group", () => {
    const pair = { taskGroupId, storeId };
    expect(acceptedReceiptMetadata({ jobId: "job", ...pair })).toEqual(pair);
    expect(acceptedReceiptMetadata({ jobId: "job", storeId })).toEqual({ storeId });
    for (const invalid of [
      { jobId: "job" },
      { taskGroupId },
      { taskGroupId: "not-a-uuid", storeId },
      { storeId: "" },
      { storeId: 42 },
      null,
      "receipt",
    ])
      expect(acceptedReceiptMetadata(invalid)).toEqual({});
    // A problem context is not an accepted handle: a producer's lone key stays out.
    expect(taskGroupReceiptMetadata({ storeId })).toEqual({});
  });

  it("keeps group metadata outside thread creation, updates, turns and receipts", () => {
    for (const [schema, ordinary] of [
      [ControlThreadCreateRequest, {}],
      [ControlThreadUpdateRequest, { title: "task" }],
      [ControlThreadTurnRequest, { prompt: "work" }],
      [
        ControlThreadTurnResponse,
        { threadId: "thread", turnId: "turn", jobId: "job", state: "queued" },
      ],
      [
        ControlThreadTurnResponse,
        { threadId: "thread", turnId: "turn", jobId: "job", runId: "run", runDir: "/fixture/run" },
      ],
    ] as const) {
      expect(schema.safeParse(ordinary).success).toBe(true);
      // A derived non-strict receipt may strip unknown keys; it must never expose them.
      const tagged = schema.safeParse({ ...ordinary, taskGroupId });
      if (tagged.success) expect(tagged.data).not.toHaveProperty("taskGroupId");
    }
    expect(ControlThreadTurnRequest.safeParse({ prompt: "work", taskGroupId }).success).toBe(false);
  });
});
