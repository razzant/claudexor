import { describe, expect, it } from "vitest";
import { daemonOutcomeSummary, exitCodeForState } from "./daemon-run.js";
import { makeOutcomeFacts } from "@claudexor/schema";

describe("exitCodeForState (D8: the lifecycle IS the exit code)", () => {
  it("maps a succeeded lifecycle to 0 and every other lifecycle to 1", () => {
    // A succeeded lifecycle is 0 — a "Done · needs review" run is still
    // succeeded and exits 0; applyability speaks through applyEligibility.
    expect(exitCodeForState("succeeded")).toBe(0);
    for (const bad of ["failed", "cancelled", "interrupted"]) {
      expect(exitCodeForState(bad)).toBe(1);
    }
  });
});

describe("daemonOutcomeSummary (P2: a reason on every non-clean daemon terminal, D8)", () => {
  it("returns undefined for a clean succeeded run (no summary key)", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "succeeded" })).toBeUndefined();
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "succeeded",
        outcomeFacts: makeOutcomeFacts("succeeded", { noChanges: true }),
      }),
    ).toBeUndefined();
  });

  it("surfaces the actionable decision hint for a needs-decision run (succeeded + review blocked)", () => {
    const s = daemonOutcomeSummary({
      runId: "run-abc",
      status: "succeeded",
      outcomeFacts: makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" }),
    });
    expect(s).toContain("decision");
    expect(s).toContain("claudexor decision run-abc");
  });

  it("prefers a real error message when present", () => {
    expect(daemonOutcomeSummary({ runId: "r1", status: "failed", error: "boom" })).toBe("boom");
  });

  it("falls back to a lifecycle+reason label for other non-succeeded terminals", () => {
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "not_converged" }),
      }),
    ).toBe("run failed (not_converged)");
    expect(
      daemonOutcomeSummary({
        runId: "r1",
        status: "failed",
        outcomeFacts: makeOutcomeFacts("failed", { reason: "stuck_no_progress" }),
      }),
    ).toBe("run failed (stuck_no_progress)");
  });
});
