import { describe, expect, it } from "vitest";
import { makeOutcomeFacts, type RunOutcomeFacts } from "@claudexor/schema";
import { reduceOrchestrateOutcome, type OrchestrateStepOutcome } from "./outcomeReducer.js";

function step(
  terminalFacts: RunOutcomeFacts | null,
  overrides: Partial<OrchestrateStepOutcome> = {},
): OrchestrateStepOutcome {
  return {
    required: true,
    executionStatus: "done",
    terminalFacts,
    ...overrides,
  };
}

const failed = (reason: RunOutcomeFacts["reason"]) => makeOutcomeFacts("failed", { reason });
const blockedFacts = makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" });

describe("reduceOrchestrateOutcome (D8 axes)", () => {
  it("projects a single required child's terminal facts to the parent", () => {
    // A needs-decision child (review blocked) keeps a succeeded lifecycle.
    expect(reduceOrchestrateOutcome([step(blockedFacts)]).lifecycle).toBe("succeeded");
    expect(reduceOrchestrateOutcome([step(blockedFacts)]).review).toBe("blocked");
    // Failure reasons propagate 1:1.
    for (const reason of [
      "harness_failed",
      "cost_unverifiable",
      "budget_overshoot",
      "budget_exhausted",
      "not_converged",
      "stuck_no_progress",
    ] as const) {
      const parent = reduceOrchestrateOutcome([step(failed(reason))]);
      expect(parent.lifecycle).toBe("failed");
      expect(parent.reason).toBe(reason);
    }
    expect(
      reduceOrchestrateOutcome([step(makeOutcomeFacts("cancelled", { reason: "user_cancelled" }))])
        .lifecycle,
    ).toBe("cancelled");
    expect(reduceOrchestrateOutcome([step(makeOutcomeFacts("succeeded"))]).lifecycle).toBe(
      "succeeded",
    );
    expect(
      reduceOrchestrateOutcome([step(makeOutcomeFacts("succeeded", { noChanges: true }))])
        .noChanges,
    ).toBe(true);
  });

  it("lifecycle precedence (failed > interrupted > cancelled > succeeded) is order-independent", () => {
    const terminals = [
      makeOutcomeFacts("succeeded"),
      makeOutcomeFacts("cancelled", { reason: "user_cancelled" }),
      failed("not_converged"),
      failed("budget_exhausted"),
      blockedFacts,
      makeOutcomeFacts("interrupted", { reason: "crash_interrupted" }),
      failed("harness_failed"),
    ];
    expect(reduceOrchestrateOutcome(terminals.map((t) => step(t))).lifecycle).toBe("failed");
    expect(reduceOrchestrateOutcome([...terminals].reverse().map((t) => step(t))).lifecycle).toBe(
      "failed",
    );
  });

  it("surfaces a needs-decision (review blocked) on missing, pending, running, or skipped required work", () => {
    for (const executionStatus of ["pending", "running", "skipped"] as const) {
      const parent = reduceOrchestrateOutcome([
        step(null, { executionStatus, terminalFacts: null }),
      ]);
      expect(parent.lifecycle).toBe("succeeded");
      expect(parent.review).toBe("blocked");
    }
  });

  it("ignores optional work while still requiring every required step to succeed", () => {
    expect(
      reduceOrchestrateOutcome([
        step(makeOutcomeFacts("succeeded")),
        step(null, { required: false, executionStatus: "skipped" }),
      ]).lifecycle,
    ).toBe("succeeded");
    expect(
      reduceOrchestrateOutcome([
        step(makeOutcomeFacts("succeeded")),
        step(failed("harness_failed"), { required: false, executionStatus: "failed" }),
      ]).lifecycle,
    ).toBe("succeeded");
  });
});
