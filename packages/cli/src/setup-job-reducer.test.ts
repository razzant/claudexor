import { describe, expect, it } from "vitest";
import type { ControlSetupJob } from "@claudexor/schema";
import { initialSetupJob, reduceSetupJob } from "./setup-job-reducer.js";

function queued(): ControlSetupJob {
  return initialSetupJob({
    jobId: "setup-reducer",
    harness: "codex",
    action: "login",
    state: "queued",
    phase: "preparing",
    command: null,
    guideUrl: "https://example.com/setup",
    message: "queued",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    authCapability: {
      attemptId: "attempt-reducer",
      challengeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
      disclosure: {
        schemaVersion: 1,
        protocolVersion: 1,
        harness: "codex",
        requested: "subscription",
        requiredRoute: "vendor_native",
        requiredSource: "native_session",
        networkScope: "selected_harness_only",
        billingKnowledge: "unknown",
        incrementalCostKnowledge: "unknown",
        mayConsumeQuota: true,
        generatedAt: "2026-01-01T00:00:00.000Z",
      },
      state: "disclosed",
    },
  });
}

describe("setup lifecycle reducer", () => {
  it("accepts a valid queued -> failed launch lifecycle", () => {
    const start = queued();
    expect(
      reduceSetupJob(start, {
        ...start,
        state: "failed",
        phase: "completed",
        outcome: { reason: "launch_failed" },
        finishedAt: "2026-01-01T00:00:02.000Z",
      }).state,
    ).toBe("failed");
  });

  it("rejects terminal laundering and immutable identity changes", () => {
    const start = queued();
    const failed = reduceSetupJob(start, {
      ...start,
      state: "failed",
      phase: "completed",
      outcome: { reason: "launch_failed" },
      finishedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(() =>
      reduceSetupJob(failed, {
        ...failed,
        state: "running",
        phase: "verifying",
        outcome: undefined,
        finishedAt: null,
      }),
    ).toThrow(/failed -> running/);
    expect(() =>
      reduceSetupJob(start, {
        ...start,
        harness: "claude",
        authCapability: {
          ...start.authCapability!,
          disclosure: { ...start.authCapability!.disclosure, harness: "claude" },
        },
      }),
    ).toThrow(/harness.*immutable/);
    expect(() =>
      reduceSetupJob(start, { ...start, createdAt: "2027-01-01T00:00:00.000Z" }),
    ).toThrow(/createdAt.*immutable/);
  });

  it("requires complete terminal evidence and chronological timestamps", () => {
    const start = queued();
    expect(() => reduceSetupJob(start, { ...start, state: "failed", phase: "completed" })).toThrow(
      /outcome/,
    );
    expect(() =>
      reduceSetupJob(start, {
        ...start,
        state: "failed",
        phase: "completed",
        outcome: { reason: "launch_failed" },
        finishedAt: "2025-12-31T23:59:59.000Z",
      }),
    ).toThrow(/finishedAt/);
  });
});
