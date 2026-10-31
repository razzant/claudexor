import { describe, expect, it } from "vitest";
import { McpRunToolResult } from "@claudexor/schema";
import { formatRunResult, structuredRunResult } from "./run-result-format.js";

describe("launch handle mirrors", () => {
  it.each([
    { jobId: "job-q", runId: "", status: "queued" },
    { jobId: "job-f", runId: "", status: "failed" },
    { jobId: "job-b", runId: "actual-run", status: "running" },
  ])("mirrors accepted group/store metadata in both channels for $status", (handle) => {
    const taskGroupId = "11111111-1111-4111-8111-111111111111";
    const storeId = "22222222-2222-4222-8222-222222222222";
    const receipt = { ...handle, summary: "accepted", taskGroupId, storeId };
    const text = formatRunResult(receipt);
    expect(text).toContain(`taskGroupId: ${taskGroupId}`);
    expect(text).toContain(`storeId: ${storeId}`);
    const structured = structuredRunResult(receipt);
    expect(structured).toMatchObject({
      jobId: handle.jobId,
      runId: handle.runId || null,
      taskGroupId,
      storeId,
    });
    expect(McpRunToolResult.parse(structured)).toMatchObject({ taskGroupId, storeId });
  });

  it("carries a queued job id in text and structured content", () => {
    const queued = {
      summary: "accepted as job job-q",
      jobId: "job-q",
      runId: "",
      status: "queued",
    };
    expect(formatRunResult(queued)).toBe("accepted as job job-q\n\njobId: job-q\nstatus: queued");
    expect(structuredRunResult(queued)).not.toHaveProperty("taskGroupId");
    expect(structuredRunResult(queued)).not.toHaveProperty("storeId");
    expect(McpRunToolResult.parse(structuredRunResult(queued))).toMatchObject({
      jobId: "job-q",
      runId: null,
      status: "queued",
    });
  });

  it("names both handles of a bound run and an unknown state as null", () => {
    const bound = { summary: "run running", jobId: "job-1", runId: "run-1", status: "" };
    expect(formatRunResult(bound)).toBe("run running\n\nrunId: run-1\njobId: job-1");
    expect(structuredRunResult(bound)).toMatchObject({
      jobId: "job-1",
      runId: "run-1",
      status: null,
    });
  });

  it("mirrors a result's typed patch-view absence in both channels", () => {
    const objectResult = {
      digest: `sha256:${"a".repeat(64)}`,
      patchView: "unavailable",
      reason: "exceeds_view_limit",
      estimatedBytes: 300_000_000,
      changedFiles: 3,
    };
    const run = { summary: "run succeeded", runId: "run-1", status: "succeeded", objectResult };
    expect(formatRunResult(run)).toContain("no patch view (exceeds_view_limit, 3 changed files)");
    const structured = structuredRunResult(run);
    expect(structured["objectResult"]).toEqual(objectResult);
    expect(McpRunToolResult.parse(structured).objectResult).toEqual(objectResult);
  });

  it("states a run without an object result as null, never as an absent fact", () => {
    const structured = structuredRunResult({ summary: "answered", runId: "run-1" });
    expect(structured["objectResult"]).toBeNull();
    expect(McpRunToolResult.parse(structured).objectResult).toBeNull();
  });
});
