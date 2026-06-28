import { describe, expect, it } from "vitest";
import type { GateResult } from "@claudexor/schema";
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
    reviewVerified: true,
    diffSize: 50,
    diffBytes: 50,
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
    expect(res.decision.verification_basis).toBe("both");
  });

  it("discloses an exact tie (winner by route order, not silently decisive)", () => {
    const a = candidate("A");
    const b = candidate("B"); // identical evidence on every axis
    const res = arbitrate([a, b]);
    expect(res.ranking[0]?.label).toBe("A"); // route order
    expect(res.decision.final_checks.some((c) => c.includes("tie: winner chosen by route order"))).toBe(true);
    // A genuinely better candidate is NOT flagged as a tie.
    const c = candidate("C", { diffSize: 10 });
    const res2 = arbitrate([c, candidate("D", { diffSize: 999 })]);
    expect(res2.decision.final_checks.some((x) => x.includes("tie:"))).toBe(false);
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

  it("uses tool warning count as a tie-breaker after hard evidence axes", () => {
    const clean = candidate("clean", { toolWarningsCount: 0 });
    const noisy = candidate("noisy", { toolWarningsCount: 4 });
    const res = arbitrate([noisy, clean]);
    expect(res.ranking[0]?.label).toBe("clean");
    expect(res.decision.winner).toBe("clean");
  });

  it("returns not_converged when the winner still has issues", () => {
    const a = candidate("A", { gates: [gate(false)] });
    const res = arbitrate([a]);
    expect(res.decision.status).toBe("not_converged");
    expect(res.decision.outcome).toBe("blocked");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("marks empty diffs as no_op instead of success", () => {
    const res = arbitrate([candidate("A", { diffBytes: 0, diffSize: 0 })]);
    expect(res.decision.status).toBe("no_op");
    expect(res.decision.outcome).toBe("no_op");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("does not mask harness failures as no_op when the diff is empty", () => {
    const res = arbitrate([
      candidate("A", {
        diffBytes: 0,
        diffSize: 0,
        gates: [{ id: "harness", status: "failed", required: true, command: "codex", exit_code: 1, duration_ms: 1 }],
        testsPassed: 0,
        testsTotal: 1,
        finalReviewClean: false,
      }),
    ]);
    expect(res.decision.status).toBe("failed");
    expect(res.decision.outcome).toBe("blocked");
    expect(res.decision.apply_recommendation).not.toBe("apply");
  });

  it("adopts a no-gate run on a VERIFIED clean cross-family review (D2), basis disclosed", () => {
    // No deterministic test gate, but the cross-family review is route-proof
    // verified and clean → applyable, recorded honestly as review-based.
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 0 })]);
    expect(res.decision.status).toBe("success");
    expect(res.decision.outcome).toBe("ready");
    expect(res.decision.apply_recommendation).toBe("apply");
    expect(res.decision.verification_basis).toBe("cross_family_review");
  });

  it("reports cross_family_review (not both) when only a NON-required gate is present", () => {
    // A non-required/diagnostic gate is not deterministic verification; a clean
    // verified review backs this run, so the basis must be cross_family_review.
    const res = arbitrate([
      candidate("A", {
        testsPassed: 0,
        testsTotal: 0,
        gates: [{ id: "lint", command: "lint", exit_code: 0, status: "passed", duration_ms: 1, required: false }],
      }),
    ]);
    expect(res.decision.status).toBe("success");
    expect(res.decision.verification_basis).toBe("cross_family_review");
  });

  it("keeps a no-gate run ungated when the review is NOT verified (no observed evidence)", () => {
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 0, reviewVerified: false })]);
    expect(res.decision.status).toBe("ungated");
    expect(res.decision.outcome).toBe("ungated");
    expect(res.decision.apply_recommendation).toBe("human_review");
    expect(res.decision.verification_basis).toBe("none");
  });

  it("marks missing verified review as review_not_run instead of success", () => {
    const res = arbitrate([candidate("A", { reviewVerified: false })]);
    expect(res.decision.status).toBe("review_not_run");
    expect(res.decision.outcome).toBe("review_not_run");
    expect(res.decision.apply_recommendation).toBe("human_review");
  });

  it("handles no candidates", () => {
    const res = arbitrate([]);
    expect(res.decision.winner).toBeNull();
    expect(res.decision.status).toBe("failed");
  });

  it("records spend honestly and never labels estimated spend as exact", () => {
    const a = candidate("A");
    const exact = arbitrate([a], { spendUsd: 0.5 });
    expect(exact.decision.budget_summary.spend_usd).toBeCloseTo(0.5);
    expect(exact.decision.budget_summary.estimated).toBe(false);

    const estimated = arbitrate([a], { spendUsd: 0.5, estimatedSpend: true });
    expect(estimated.decision.budget_summary.spend_usd).toBeCloseTo(0.5);
    expect(estimated.decision.budget_summary.estimated).toBe(true);
  });

  it("labels zero configured tests as n/a, never a vacuous 100%", () => {
    const res = arbitrate([candidate("A", { gates: [], testsPassed: 0, testsTotal: 0 })]);
    expect(res.decision.why_winner).toContain("tests=n/a");
    expect(res.decision.why_winner).not.toContain("tests=100%");
  });

  it("treats zero tests as zero test evidence in ranking (not a perfect score)", () => {
    const withTests = candidate("A", { testsPassed: 10, testsTotal: 10 });
    const noTests = candidate("B", { testsPassed: 0, testsTotal: 0 });
    const res = arbitrate([noTests, withTests]);
    expect(res.ranking[0]?.label).toBe("A");
    expect(res.decision.why_winner).toContain("tests=100%");
  });
});
