import { describe, expect, it } from "vitest";
import type { ConvergencePredicate, ReviewFinding } from "@claudexor/schema";
import { evaluateConvergence } from "./convergence.js";

const predicate = (over: Partial<ConvergencePredicate> = {}): ConvergencePredicate => ({
  require_tests_pass: false,
  require_no_accepted_block_open: true,
  require_no_accepted_fix_first_open: true,
  require_final_cross_family_clean_review: false,
  require_final_diff_stable_after_review: false,
  require_no_accepted_needs_human_open: true,
  ...over,
});

const needsHuman: ReviewFinding = {
  id: "f-1",
  severity: "NEEDS_HUMAN",
  category: "architecture",
  claim: "protected path changed",
  linked_acceptance_criteria: [],
  evidence: { files: [], diff_hunks: [], commands: [], logs: [] },
  proposed_fix: null,
  reviewer: {
    harness_id: "claude",
    requested_model: null,
    requested_effort: null,
    observed_model: null,
    route_proof_status: "unverified",
  },
  status: "accepted",
};

describe("evaluateConvergence NEEDS_HUMAN gate", () => {
  it("does NOT converge with an open accepted NEEDS_HUMAN, even when cross-family clean review is disabled", () => {
    const r = evaluateConvergence({
      predicate: predicate(),
      gates: [],
      findings: [needsHuman],
      finalReviewClean: true,
      diffStableAfterReview: true,
    });
    expect(r.converged).toBe(false);
    expect(r.reasons).toContain("an accepted NEEDS_HUMAN escalation is open");
  });

  it("converges only when the NEEDS_HUMAN gate is explicitly disabled", () => {
    const r = evaluateConvergence({
      predicate: predicate({ require_no_accepted_needs_human_open: false }),
      gates: [],
      findings: [needsHuman],
      finalReviewClean: true,
      diffStableAfterReview: true,
    });
    expect(r.converged).toBe(true);
  });

  it("ignores a NEEDS_HUMAN that is only proposed (not accepted)", () => {
    const r = evaluateConvergence({
      predicate: predicate(),
      gates: [],
      findings: [{ ...needsHuman, status: "proposed" }],
      finalReviewClean: true,
      diffStableAfterReview: true,
    });
    expect(r.converged).toBe(true);
  });
});
