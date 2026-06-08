import type { ConvergencePredicate, GateResult, ReviewFinding } from "@claudexor/schema";
import { isBlocking } from "@claudexor/schema";
import { gatesPassed } from "./gates.js";

export interface ConvergenceInput {
  predicate: ConvergencePredicate;
  gates: GateResult[];
  findings: ReviewFinding[];
  /** A cross-family clean review exists for the final diff. */
  finalReviewClean: boolean;
  /** The final diff has not changed since the final review (not stale). */
  diffStableAfterReview: boolean;
}

export interface ConvergenceResult {
  converged: boolean;
  reasons: string[];
  openBlockers: ReviewFinding[];
}

/**
 * Evaluate the convergence predicate. Convergence does NOT mean "no model can
 * invent any new nit" — it means no accepted important finding remains open,
 * required gates pass, and the final scope-valid review is clean/stable.
 */
export function evaluateConvergence(input: ConvergenceInput): ConvergenceResult {
  const reasons: string[] = [];
  const p = input.predicate;
  const openBlockers = input.findings.filter((f) => isBlocking(f));

  if (p.require_tests_pass && !gatesPassed(input.gates)) {
    reasons.push("required gates are not all passing");
  }
  if (p.require_no_accepted_block_open && openBlockers.some((f) => f.severity === "BLOCK")) {
    reasons.push("an accepted BLOCK finding is open");
  }
  if (p.require_no_accepted_fix_first_open && openBlockers.some((f) => f.severity === "FIX_FIRST")) {
    reasons.push("an accepted FIX_FIRST finding is open");
  }
  if (p.require_final_cross_family_clean_review && !input.finalReviewClean) {
    reasons.push("no final cross-family clean review");
  }
  if (p.require_final_diff_stable_after_review && !input.diffStableAfterReview) {
    reasons.push("diff changed after final review (review is stale)");
  }

  return { converged: reasons.length === 0, reasons, openBlockers };
}
