import { describe, expect, it } from "vitest";
import type { JobRecord } from "./job-record.js";
import { settleJobError } from "./job-settlement.js";

const runningRecord: JobRecord = {
  id: "job-1",
  state: "running",
  params: {},
  createdAt: "2026-07-26T12:00:00.000Z",
};

const update = (record: JobRecord, patch: Partial<JobRecord>): JobRecord => ({
  ...record,
  ...patch,
});

describe("settleJobError", () => {
  it("preserves typed metadata on an ordinary runner failure", () => {
    const settled = settleJobError({
      thrown: Object.assign(new Error("preflight refused"), {
        code: "trust_required",
        status: 409,
        retryable: false,
      }),
      record: runningRecord,
      aborted: false,
      commands: {},
      update,
    });

    expect(settled).toMatchObject({
      state: "failed",
      error: "preflight refused",
      errorCode: "trust_required",
      errorStatus: 409,
      errorRetryable: false,
    });
  });

  it("keeps a failed immediate terminal recovery provisional and redacts both errors", () => {
    const secret = `sk-${"a".repeat(32)}`;
    const settled = settleJobError({
      thrown: Object.assign(new Error(`local finalization failed ${secret}`), {
        code: "terminal_recovery_required",
        status: 503,
        retryable: false,
      }),
      record: runningRecord,
      aborted: true,
      commands: {},
      update,
    });

    expect(settled).toMatchObject({
      state: "interrupted",
      errorCode: "terminal_recovery_required",
      errorStatus: 503,
      errorRetryable: false,
    });
    expect(settled.error).toContain(
      "immediate terminal recovery failed: durable terminal event was not found",
    );
    expect(settled.error).not.toContain(secret);
  });
});
