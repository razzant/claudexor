/** run-deadline/1: a queued run its deadline ended keeps its typed reason on the run read. */
import { describe, expect, it } from "vitest";
import { makeOutcomeFacts } from "@claudexor/schema";
import { releasedRunReader } from "../../schema/fixtures/run-results-6.2.0.js";
import {
  detailForReader,
  legacyRunOutcomeFacts,
  readFailure,
  runFactsForReader,
} from "./run-card-facts.js";
import { detailFor } from "./run-projection.js";
import type { DaemonRunRecord } from "./run-record.js";

describe("readFailure without run artifacts", () => {
  it("keeps a deadline expiry in the failure shape earlier clients read", () => {
    expect(
      readFailure({
        id: "job-1",
        state: "cancelled",
        error: "run deadline passed before the run started",
        errorCode: "run_deadline_expired",
      }),
    ).toMatchObject({
      category: "cancelled",
      code: null,
      phase: "queued",
      safeMessage: "run deadline passed before the run started",
    });
    expect(
      readFailure({
        id: "job-4",
        state: "cancelled",
        startedAt: "2026-11-25T00:00:00.000Z",
        error: "run deadline passed before the run started",
        errorCode: "run_deadline_expired",
      }),
    ).toMatchObject({ category: "cancelled", code: null, phase: "preparing" });
  });

  it("keeps every other unbound failure untyped", () => {
    expect(
      readFailure({ id: "job-2", state: "failed", error: "boom", errorCode: "something_else" }),
    ).toMatchObject({ category: "unknown", code: null });
  });

  it("keeps the deadline's cause in the outcome the card reads, and the generic fallback otherwise", () => {
    const expired = {
      id: "job-1",
      state: "cancelled",
      error: "run deadline passed before the run started",
      errorCode: "run_deadline_expired",
    };
    expect(legacyRunOutcomeFacts(expired, null, readFailure(expired))).toMatchObject({
      lifecycle: "cancelled",
      reason: "run_deadline_expired",
    });
    const legacy = { id: "job-3", state: "cancelled", error: "stopped" };
    expect(legacyRunOutcomeFacts(legacy, null, readFailure(legacy))?.reason).not.toBe(
      "run_deadline_expired",
    );
  });
});

describe("run-deadline/1 facts for this answer's reader", () => {
  const expired: DaemonRunRecord = {
    id: "job-5",
    state: "cancelled",
    params: { prompt: "fixture", deadline: { at: "2026-11-25T00:00:00.000Z" } },
    error: "run deadline passed before the run started",
    errorCode: "run_deadline_expired",
    errorStatus: 409,
    errorRetryable: false,
  };

  it("keeps every fact as recorded for a reader that opted in", () => {
    const row = { outcomeFacts: legacyRunOutcomeFacts(expired, null, readFailure(expired)) };
    expect(runFactsForReader(row, true)).toBe(row);
    expect(row.outcomeFacts?.reason).toBe("run_deadline_expired");
  });

  it("reads a deadline stop as the engine's for an earlier reader, never Stop or maxSeconds", () => {
    const row = { outcomeFacts: legacyRunOutcomeFacts(expired, null, readFailure(expired)) };
    expect(runFactsForReader(row, false).outcomeFacts).toMatchObject({
      lifecycle: "cancelled",
      reason: "host_cancelled",
    });
  });

  it("leaves Stop, maxSeconds and ordinary outcomes as they are", () => {
    for (const facts of [
      makeOutcomeFacts("cancelled", { reason: "user_cancelled" }),
      makeOutcomeFacts("cancelled", { reason: "wall_clock_exceeded" }),
      makeOutcomeFacts("succeeded"),
    ]) {
      const row = { outcomeFacts: facts };
      expect(runFactsForReader(row, false)).toEqual(row);
    }
  });

  it("answers a released reader with the whole detail and its banner, an opted-in one exactly", () => {
    const detail = detailFor(expired, []);
    expect(detail.summary.outcomeFacts?.reason).toBe("run_deadline_expired");
    expect(detail.outcomeBanner).toBe("Deadline reached");
    expect(detailForReader(detail, true)).toBe(detail);
    const earlier = detailForReader(detail, false);
    expect(releasedRunReader("ControlRunDetail")(JSON.parse(JSON.stringify(earlier)))).toBe(true);
    expect(earlier.summary).toMatchObject({
      failure: { category: "cancelled", phase: "queued", code: null, safeMessage: expired.error },
      outcomeFacts: { lifecycle: "cancelled", reason: "host_cancelled" },
    });
    expect(earlier.outcomeBanner).toBe("Deadline reached");
  });
});
