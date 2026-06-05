import { describe, expect, it } from "vitest";
import type { GateResult } from "@claudex/schema";
import { type CandidateEvidence, arbitrate } from "./arbitration.js";

function gate(passed: boolean): GateResult {
  return {
    id: "tests",
    command: "pnpm test",
    exit_code: passed ? 0 : 1,
    status: passed ? "passed" : "failed",
    duration_ms: 1,
    required: true,
  };
}

function candidate(label: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    attemptId: label,
    label,
    gates: [gate(true)],
    acceptanceCovered: ["AC-1"],
    acceptanceTotal: 1,
    findings: [],
    testsPassed: 10,
    testsTotal: 10,
    finalReviewClean: true,
    diffSize: 50,
    ...over,
  };
}

describe("arbitrate", () => {
  it("ranks a green candidate over one failing a required gate", () => {
    const a = candidate("A");
    const b = candidate("B", { gates: [gate(false)] });
    const res = arbitrate([b, a]);
    expect(res.ranking[0]?.label).toBe("A");
    expect(res.decision.winner).toBe("A");
    expect(res.decision.status).toBe("success");
    expect(res.decision.apply_recommendation).toBe("apply");
  });

  it("held-out tests are authoritative (anti reward hacking)", () => {
    // X games visible tests (10/10) but fails held-out; Y passes held-out.
    const x = candidate("X", { testsPassed: 10, testsTotal: 10, heldOutPassed: 0, heldOutTotal: 10 });
    const y = candidate("Y", { testsPassed: 8, testsTotal: 10, heldOutPassed: 10, heldOutTotal: 10 });
    const res = arbitrate([x, y]);
    expect(res.ranking[0]?.label).toBe("Y");
    expect(res.decision.winner).toBe("Y");
  });

  it("prefers higher acceptance coverage", () => {
    const a = candidate("A", { acceptanceCovered: ["AC-1", "AC-2"], acceptanceTotal: 2 });
    const b = candidate("B", { acceptanceCovered: ["AC-1"], acceptanceTotal: 2 });
    expect(arbitrate([b, a]).ranking[0]?.label).toBe("A");
  });

  it("returns not_converged when the winner still has issues", () => {
    const a = candidate("A", { gates: [gate(false)] });
    const res = arbitrate([a]);
    expect(res.decision.status).toBe("not_converged");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("handles no candidates", () => {
    const res = arbitrate([]);
    expect(res.decision.winner).toBeNull();
    expect(res.decision.status).toBe("failed");
  });
});
