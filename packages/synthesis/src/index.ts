import type { CandidateEvidence } from "@claudexor/arbitration";
import { candidateSummary, compareCandidates } from "@claudexor/arbitration";

export type SynthesisMode = "auto" | "always" | "never";

export interface SynthesisDecision {
  synthesize: boolean;
  reason: string;
  sources: string[];
}

const FIXABLE_STATUSES = new Set(["accepted", "accepted_risk"]);

/**
 * Decide whether synthesizing a new candidate is worthwhile. Auto mode
 * synthesizes when there is no clear winner, the best candidate has fixable
 * accepted findings, or candidates have complementary strengths. A single
 * clearly-winning candidate is NOT synthesized.
 */
export function decideSynthesis(candidates: CandidateEvidence[], mode: SynthesisMode = "auto"): SynthesisDecision {
  if (mode === "never") return { synthesize: false, reason: "synthesis disabled", sources: [] };
  if (candidates.length < 2) {
    return { synthesize: false, reason: "need >= 2 candidates to synthesize", sources: candidates.map((c) => c.attemptId) };
  }
  if (mode === "always") {
    return { synthesize: true, reason: "synthesis forced (always)", sources: candidates.map((c) => c.attemptId) };
  }

  const ranked = [...candidates].sort(compareCandidates);
  const top = ranked[0] as CandidateEvidence;
  const second = ranked[1] as CandidateEvidence;
  const ts = candidateSummary(top);
  const ss = candidateSummary(second);

  const strictlyBetter = compareCandidates(top, second) < 0;
  const clearWinner = ts.gatesPassed && ts.clean && ts.blockers === 0 && strictlyBetter;
  const topFixable = top.findings.some((f) => FIXABLE_STATUSES.has(f.status));
  const complementary =
    ss.testFraction > ts.testFraction ||
    ss.acceptance > ts.acceptance ||
    ss.blockers < ts.blockers ||
    (second.diffSize ?? 0) < (top.diffSize ?? 0); // second is simpler on a lower-priority axis

  if (clearWinner && !topFixable && !complementary) {
    return { synthesize: false, reason: "a single candidate clearly passes all gates and review", sources: [top.attemptId] };
  }

  const reasons: string[] = [];
  if (!clearWinner) reasons.push("no clear winner");
  if (topFixable) reasons.push("best candidate has fixable accepted findings");
  if (complementary) reasons.push("candidates have complementary strengths");

  return {
    synthesize: true,
    reason: reasons.join("; "),
    sources: ranked.slice(0, Math.min(3, ranked.length)).map((c) => c.attemptId),
  };
}

export interface SynthesisPlan {
  baseFrom: string;
  borrowTestsFrom: string | null;
  fixFindings: string[];
  instructions: string;
}

/**
 * Build a plan for the synthesizer harness. The synthesized output MUST then be
 * re-run through gates + review + revalidation + arbitration as a new candidate
 * (never applied unchecked, never a blind diff concatenation).
 */
export function buildSynthesisPlan(candidates: CandidateEvidence[]): SynthesisPlan {
  const ranked = [...candidates].sort(compareCandidates);
  const base = ranked[0] as CandidateEvidence;
  const bestTests = [...candidates].sort(
    (a, b) => candidateSummary(b).testFraction - candidateSummary(a).testFraction,
  )[0] as CandidateEvidence;

  const fixFindings = [
    ...new Set(
      candidates.flatMap((c) =>
        c.findings.filter((f) => FIXABLE_STATUSES.has(f.status)).map((f) => f.claim),
      ),
    ),
  ];

  const borrowTestsFrom = bestTests.attemptId !== base.attemptId ? bestTests.attemptId : null;
  const instructions = [
    `Start from ${base.label}.`,
    borrowTestsFrom ? `Adopt the stronger tests from ${bestTests.label}.` : "",
    fixFindings.length > 0 ? `Fix the accepted findings (${fixFindings.length}).` : "",
    "Produce a single coherent patch; do not blindly concatenate diffs. The result will be re-reviewed.",
  ]
    .filter(Boolean)
    .join(" ");

  return { baseFrom: base.attemptId, borrowTestsFrom, fixFindings, instructions };
}
