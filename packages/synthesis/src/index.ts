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
 * Auto mode only synthesizes a 3rd candidate when there are at least this many
 * candidates. best-of-2 just picks the winner: synthesizing on n=2 adds a 3rd
 * paid harness run + a 3rd full review pass (~3x cost) for marginal benefit.
 * `--synthesis always` overrides this; `never` disables.
 */
export const AUTO_SYNTHESIS_MIN_CANDIDATES = 3;

/**
 * Decide whether synthesizing a new candidate is worthwhile. Auto mode
 * synthesizes (when >= AUTO_SYNTHESIS_MIN_CANDIDATES) if there is no clear
 * winner, the best candidate has fixable accepted findings, or candidates have
 * complementary strengths. A single clearly-winning candidate — and any n<3
 * auto race — is NOT synthesized.
 */
export function decideSynthesis(
  candidates: CandidateEvidence[],
  mode: SynthesisMode = "auto",
): SynthesisDecision {
  if (mode === "never") return { synthesize: false, reason: "synthesis disabled", sources: [] };
  if (candidates.length < 2) {
    return {
      synthesize: false,
      reason: "need >= 2 candidates to synthesize",
      sources: candidates.map((c) => c.attemptId),
    };
  }
  if (mode === "always") {
    return {
      synthesize: true,
      reason: "synthesis forced (always)",
      sources: candidates.map((c) => c.attemptId),
    };
  }
  if (candidates.length < AUTO_SYNTHESIS_MIN_CANDIDATES) {
    return {
      synthesize: false,
      reason: `auto synthesis needs >= ${AUTO_SYNTHESIS_MIN_CANDIDATES} candidates (best-of-${candidates.length} picks the winner)`,
      sources: candidates.map((c) => c.attemptId),
    };
  }

  const ranked = [...candidates].sort(compareCandidates);
  const top = ranked[0] as CandidateEvidence;
  const second = ranked[1] as CandidateEvidence;
  const ts = candidateSummary(top);
  const ss = candidateSummary(second);

  const strictlyBetter = compareCandidates(top, second) < 0;
  const clearWinner = ts.gatesPassed && ts.clean && ts.blockers === 0 && strictlyBetter;
  const topFixable = top.findings.some((f) => FIXABLE_STATUSES.has(f.status));
  // Only a GREEN runner-up can contribute complementary strengths: a failed
  // candidate with an empty diff is not "simpler", and synthesizing against it
  // wastes a paid run plus a full review pass.
  const complementary =
    ss.gatesPassed &&
    (ss.testFraction > ts.testFraction ||
      ss.acceptance > ts.acceptance ||
      ss.blockers < ts.blockers ||
      (second.diffSize ?? 0) < (top.diffSize ?? 0)); // second is simpler on a lower-priority axis

  if (clearWinner && !topFixable && !complementary) {
    return {
      synthesize: false,
      reason: "a single candidate clearly passes all gates and review",
      sources: [top.attemptId],
    };
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

/**
 * The stable marker phrase the deep-scan reducer prompt opens with. A fake
 * harness keys on this substring to emit a deterministic merged report for the
 * reducer-success canary WITHOUT changing its ordinary `synthesize` behavior
 * (best-of synthesis, which never carries this marker, stays untouched).
 */
export const DEEP_SCAN_REDUCER_MARKER = "DEEP-SCAN SYNTHESIS REDUCER";

/**
 * Build the read-only bounded reducer prompt for `ask --deep-scan` (#27 / D-6).
 * Like the plan-council merge, it POINTS at the raw scout report FILES by
 * absolute path (the argv-size law: reports ride a file, never argv) and asks
 * for ONE deduplicated synthesis that surfaces disagreements with per-scout
 * attribution and preserves omissions — never a concatenation. Read-only: the
 * reducer must not edit files or output implementations.
 */
export function buildDeepScanReducerPrompt(
  goal: string,
  scouts: readonly { attemptId: string; harnessId: string; absPath: string }[],
): string {
  const pointerLines = scouts.map((s) => `- ${s.attemptId} (${s.harnessId}): ${s.absPath}`);
  return [
    `You are the ${DEEP_SCAN_REDUCER_MARKER}. You are MERGING ${scouts.length} independent scout research reports into ONE synthesis. Work read-only: do not edit files, run tools that mutate, or output implementations.`,
    ``,
    `## Original research goal`,
    goal,
    ``,
    `## Scout reports to merge (read each file before merging)`,
    ...pointerLines,
    ``,
    `Read every scout report above by its absolute path. Then produce a SINGLE coherent synthesis, not a list of the reports:`,
    `1. Deduplicate claims that multiple scouts made — state each finding once.`,
    `2. Where scouts DISAGREE or conflict, surface the disagreement explicitly and attribute each side to the scout(s) that made it (name them, e.g. "a01 vs a03").`,
    `3. Preserve anything only one scout found, and preserve every scout's stated unknowns/omissions — do not silently drop a minority finding.`,
    `4. Keep evidence citations (file paths, symbols) that the scouts provided.`,
    ``,
    `Ground every claim in THIS repository. Do NOT paste large code blocks; describe findings and reference real paths. Keep it concise and well-structured in Markdown.`,
  ].join("\n");
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
    borrowTestsFrom
      ? `Use the stronger gate/test results from ${bestTests.label} as evidence, but do not edit protected tests or gate configuration unless the user explicitly asked for test changes.`
      : "",
    fixFindings.length > 0 ? `Fix the accepted findings (${fixFindings.length}).` : "",
    "Produce a single coherent patch; do not blindly concatenate diffs. The result will be re-reviewed.",
  ]
    .filter(Boolean)
    .join(" ");

  return { baseFrom: base.attemptId, borrowTestsFrom, fixFindings, instructions };
}
