import { describe, expect, it } from "vitest";
import { daemonOutcomeSummary, exitCodeForState, runStatusForCli } from "./daemon-run.js";

describe("exitCodeForState", () => {
  it("maps success terminals to 0 and everything else to 1", () => {
    for (const ok of ["succeeded", "no_op"]) expect(exitCodeForState(ok)).toBe(0);
    for (const bad of [
      "ungated",
      "review_not_run",
      "blocked",
      "failed",
      "cancelled",
      "interrupted_unknown",
      "exhausted",
      "not_converged",
      "stuck_no_progress",
    ])
      expect(exitCodeForState(bad)).toBe(1);
  });
});

it("normalizes the internal succeeded command state at the public CLI boundary", () => {
  expect(runStatusForCli("succeeded")).toBe("success");
  expect(runStatusForCli("blocked")).toBe("blocked");
});

describe("daemonOutcomeSummary (P2: a reason on every non-success daemon terminal)", () => {
  it("returns undefined for success terminals (no summary key)", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "succeeded" })).toBeUndefined();
    expect(daemonOutcomeSummary({ runId: "r1", status: "no_op" })).toBeUndefined();
  });

  it("surfaces the actionable decision hint for a blocked run (which carries no error)", () => {
    const s = daemonOutcomeSummary({ runId: "run-abc", status: "blocked" });
    expect(s).toContain("blocked");
    expect(s).toContain("claudexor decision run-abc");
  });

  it("prefers a real error message when present", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "failed", error: "boom" })).toBe("boom");
  });

  it("falls back to a state label for other non-success terminals", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "not_converged" })).toBe(
      "run not_converged",
    );
    expect(daemonOutcomeSummary({ runId: "r1", status: "stuck_no_progress" })).toBe(
      "run stuck_no_progress",
    );
  });
});
