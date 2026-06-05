import { describe, expect, it } from "vitest";
import type { CandidateEvidence } from "@claudex/arbitration";
import { buildSynthesisPlan, decideSynthesis } from "./index.js";

function cand(label: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    attemptId: label,
    label,
    gates: [{ id: "t", command: "t", exit_code: 0, status: "passed", duration_ms: 1, required: true }],
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

describe("decideSynthesis", () => {
  it("never / <2 candidates / always", () => {
    expect(decideSynthesis([cand("A"), cand("B")], "never").synthesize).toBe(false);
    expect(decideSynthesis([cand("A")], "auto").synthesize).toBe(false);
    expect(decideSynthesis([cand("A"), cand("B")], "always").synthesize).toBe(true);
  });

  it("does NOT synthesize when one candidate clearly dominates", () => {
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 10 });
    const b = cand("B", { testsPassed: 8, testsTotal: 10, diffSize: 100 });
    expect(decideSynthesis([a, b], "auto").synthesize).toBe(false);
  });

  it("synthesizes on complementary strengths (top wins tests, second is simpler)", () => {
    const a = cand("A", { testsPassed: 10, testsTotal: 10, diffSize: 100 });
    const b = cand("B", { testsPassed: 8, testsTotal: 10, diffSize: 10 });
    const d = decideSynthesis([a, b], "auto");
    expect(d.synthesize).toBe(true);
    expect(d.reason).toContain("complementary");
  });

  it("builds a plan: base = overall winner, borrow tests from the best-tests candidate", () => {
    // A wins overall (required gate passes), but B has stronger tests despite a failing gate.
    const a = cand("A", { testsPassed: 8, testsTotal: 10 });
    const b = cand("B", {
      gates: [{ id: "t", command: "t", exit_code: 1, status: "failed", duration_ms: 1, required: true }],
      testsPassed: 10,
      testsTotal: 10,
    });
    const plan = buildSynthesisPlan([a, b]);
    expect(plan.baseFrom).toBe("A");
    expect(plan.borrowTestsFrom).toBe("B");
  });
});
