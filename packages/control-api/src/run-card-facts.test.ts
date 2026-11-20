/** run-deadline/1: a queued run its deadline ended keeps its typed reason on the run read. */
import { describe, expect, it } from "vitest";
import { readFailure } from "./run-card-facts.js";

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
});
