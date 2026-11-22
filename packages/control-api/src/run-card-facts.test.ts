/** run-deadline/1: a queued run its deadline ended keeps its typed reason on the run read. */
import { describe, expect, it } from "vitest";
import { legacyRunOutcomeFacts, readFailure } from "./run-card-facts.js";

describe("readFailure without run artifacts", () => {
  it("projects run_deadline_expired as a typed cancelled failure", () => {
    expect(
      readFailure({
        id: "job-1",
        state: "cancelled",
        error: "run deadline passed before the run started",
        errorCode: "run_deadline_expired",
      }),
    ).toMatchObject({ category: "cancelled", code: "run_deadline_expired", phase: "queued" });
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
