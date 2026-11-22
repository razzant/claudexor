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
    const secret = `sk-${"a".repeat(32)}`;
    const settled = settleJobError({
      thrown: Object.assign(new Error("preflight refused"), {
        code: "trust_required",
        status: 409,
        retryable: false,
        requiredActions: [`replace ${secret}`, "retry"],
        context: { turnId: "tn-1", detail: secret },
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
      errorRequiredActions: [expect.stringContaining("[redacted]"), "retry"],
      errorContext: { turnId: "tn-1", detail: expect.stringContaining("[redacted]") },
    });
    expect(JSON.stringify(settled)).not.toContain(secret);
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

  it("attests manual replay only for an accepted turn that failed before run binding", () => {
    const settle = (record: JobRecord, thrown: Error, aborted = false) =>
      settleJobError({ thrown, record, aborted, commands: {}, update });
    const turn = { ...runningRecord, params: { turnId: "tn-1" } };
    const refusal = Object.assign(new Error("workspace file unavailable"), {
      code: "mandatory_context_unavailable",
      status: 409,
      retryable: false,
      turnRetryable: true,
    });
    expect(settle(turn, refusal)).toMatchObject({
      errorRetryable: false,
      errorContext: { turnRetryable: true },
    });
    expect(settle(runningRecord, refusal).errorContext).toEqual({});
    expect(settle({ ...turn, runId: "run-1" }, refusal).errorContext).toEqual({});
    expect(settle(turn, refusal, true).errorContext).toEqual({});
    const frozen = Object.assign(new Error("plan is not ready"), {
      code: "plan_not_ready",
      retryable: false,
      context: { turnRetryable: true }, // opaque diagnostics cannot grant replay
    });
    const frozenJob = settle(turn, frozen);
    expect(frozenJob.errorRetryable).toBe(false);
    expect(frozenJob.errorContext).toEqual({});
  });
});
