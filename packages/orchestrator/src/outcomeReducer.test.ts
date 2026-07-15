import { describe, expect, it } from "vitest";
import { reduceOrchestrateOutcome, type OrchestrateStepOutcome } from "./outcomeReducer.js";

function step(
  terminalStatus: OrchestrateStepOutcome["terminalStatus"],
  overrides: Partial<OrchestrateStepOutcome> = {},
): OrchestrateStepOutcome {
  return {
    required: true,
    executionStatus: "done",
    terminalStatus,
    ...overrides,
  };
}

describe("reduceOrchestrateOutcome", () => {
  it.each([
    ["failed", "failed"],
    ["interrupted_unknown", "interrupted_unknown"],
    ["blocked", "blocked"],
    ["ungated", "blocked"],
    ["review_not_run", "blocked"],
    ["cost_unverifiable", "cost_unverifiable"],
    ["exhausted_overshoot", "exhausted_overshoot"],
    ["exhausted", "exhausted"],
    ["not_converged", "not_converged"],
    ["stuck_no_progress", "stuck_no_progress"],
    ["cancelled", "cancelled"],
    ["success", "success"],
    ["no_op", "success"],
  ] as const)("reduces required terminal %s to %s", (child, parent) => {
    expect(reduceOrchestrateOutcome([step(child)])).toBe(parent);
  });

  it("uses the locked precedence independent of step order", () => {
    const terminals = [
      "success",
      "cancelled",
      "not_converged",
      "exhausted",
      "exhausted_overshoot",
      "cost_unverifiable",
      "blocked",
      "interrupted_unknown",
      "failed",
    ] as const;
    expect(reduceOrchestrateOutcome(terminals.map((terminal) => step(terminal)))).toBe("failed");
    expect(
      reduceOrchestrateOutcome([...terminals].reverse().map((terminal) => step(terminal))),
    ).toBe("failed");
  });

  it("blocks on missing, pending, running, or skipped required work", () => {
    for (const executionStatus of ["pending", "running", "skipped"] as const) {
      expect(
        reduceOrchestrateOutcome([step(null, { executionStatus, terminalStatus: null })]),
      ).toBe("blocked");
    }
  });

  it("ignores optional work while still requiring every required step to succeed", () => {
    expect(
      reduceOrchestrateOutcome([
        step("success"),
        step(null, { required: false, executionStatus: "skipped" }),
      ]),
    ).toBe("success");
    expect(
      reduceOrchestrateOutcome([
        step("success"),
        step("failed", { required: false, executionStatus: "failed" }),
      ]),
    ).toBe("success");
  });
});
