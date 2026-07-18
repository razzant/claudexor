import type {
  DecisionRecord,
  GateResult,
  PairwiseComparison,
  ReviewFinding,
} from "@claudexor/schema";
import { DecisionRecord as DecisionRecordSchema, isBlocking } from "@claudexor/schema";

/** Evidence assembled for one tournament candidate. */
export interface CandidateEvidence {
  attemptId: string;
  /** Anonymized label shown to the arbiter (e.g. "Candidate A"). */
  label: string;
  gates: GateResult[];
  acceptanceCovered: string[];
  acceptanceTotal: number;
  findings: ReviewFinding[];
  testsPassed: number;
  testsTotal: number;
  finalReviewClean: boolean;
  reviewVerified?: boolean;
  /** Non-blocking tool hygiene warnings from the engine-owned attempt outcome. */
  toolWarningsCount?: number;
  /** Smaller = simpler (e.g. diff line count). */
  diffSize?: number;
  diffBytes?: number;
  costUsd?: number;
}

function requiredGatesPassed(c: CandidateEvidence): boolean {
  const required = c.gates.filter((g) => g.required);
  return required.length === 0 ? true : required.every((g) => g.status === "passed");
}

/**
 * Acceptance coverage fraction. Zero configured success criteria is zero
 * acceptance EVIDENCE (0, never a vacuous 1), mirroring `effectiveTestFraction`.
 * Since all candidates in a tournament share one contract, a 0 here is a neutral
 * tie axis (no relative penalty) — it only removes the false "100%" claim.
 */
function acceptanceFraction(c: CandidateEvidence): number {
  return c.acceptanceTotal > 0 ? c.acceptanceCovered.length / c.acceptanceTotal : 0;
}

/** Human label for gate-derived criteria coverage: honest "n/a" when no
 * criteria exist. Named gates_coverage in decision strings: the
 * number is a PROXY derived from the deterministic gates (all criteria
 * count as covered only when gates pass), not independent per-criterion
 * acceptance evidence. */
function acceptanceLabel(c: CandidateEvidence): string {
  return c.acceptanceTotal > 0 ? `${(acceptanceFraction(c) * 100).toFixed(0)}%` : "n/a";
}

function openBlockerCount(c: CandidateEvidence): number {
  return c.findings.filter((f) => isBlocking(f)).length;
}

/**
 * Test pass-fraction. Zero configured tests is zero test EVIDENCE (0, never a
 * vacuous 1): a candidate with no tests must not score "100%" in rankings or
 * user-facing decision strings. (The held-out split axis was retired in the
 * v0.15 triage: no producer ever populated it — re-add WITH a real held-out
 * runner if that anti-reward-hacking design returns.)
 */
function effectiveTestFraction(c: CandidateEvidence): number {
  return c.testsTotal > 0 ? c.testsPassed / c.testsTotal : 0;
}

/** Human label for test evidence: honest "n/a" when no tests exist at all. */
function testEvidenceLabel(c: CandidateEvidence): string {
  if (c.testsTotal === 0) return "n/a";
  return `${(effectiveTestFraction(c) * 100).toFixed(0)}%`;
}

/** Higher is better, compared lexicographically (evidence-first ordering). */
export function scoreTuple(c: CandidateEvidence): number[] {
  return [
    requiredGatesPassed(c) ? 1 : 0, // hard gates
    acceptanceFraction(c), // acceptance coverage
    -openBlockerCount(c), // fewer accepted blockers
    effectiveTestFraction(c), // deterministic test pass fraction
    c.finalReviewClean ? 1 : 0, // final clean review
    -(c.toolWarningsCount ?? 0), // cleaner tool hygiene
    -(c.diffSize ?? 0), // simplicity
    -(c.costUsd ?? 0), // cost
  ];
}

function compareTuples(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? -1 : 1; // sort best-first
  }
  return 0;
}

/** Compare two candidates (best-first): negative if `a` should rank ahead of `b`. */
export function compareCandidates(a: CandidateEvidence, b: CandidateEvidence): number {
  return compareTuples(scoreTuple(a), scoreTuple(b));
}

export interface CandidateSummary {
  gatesPassed: boolean;
  blockers: number;
  acceptance: number;
  testFraction: number;
  clean: boolean;
}

export function candidateSummary(c: CandidateEvidence): CandidateSummary {
  return {
    gatesPassed: requiredGatesPassed(c),
    blockers: openBlockerCount(c),
    acceptance: acceptanceFraction(c),
    testFraction: effectiveTestFraction(c),
    clean: c.finalReviewClean,
  };
}

export interface ArbitrationResult {
  ranking: CandidateEvidence[];
  decision: DecisionRecord;
  pairwise: PairwiseComparison[];
}

const CRITERIA: {
  key: string;
  better: (a: CandidateEvidence, b: CandidateEvidence) => "a" | "b" | "tie";
}[] = [
  {
    key: "gates",
    better: (a, b) =>
      requiredGatesPassed(a) === requiredGatesPassed(b)
        ? "tie"
        : requiredGatesPassed(a)
          ? "a"
          : "b",
  },
  {
    key: "gates_coverage",
    better: (a, b) =>
      acceptanceFraction(a) === acceptanceFraction(b)
        ? "tie"
        : acceptanceFraction(a) > acceptanceFraction(b)
          ? "a"
          : "b",
  },
  {
    key: "blockers",
    better: (a, b) =>
      openBlockerCount(a) === openBlockerCount(b)
        ? "tie"
        : openBlockerCount(a) < openBlockerCount(b)
          ? "a"
          : "b",
  },
  {
    key: "tests",
    better: (a, b) =>
      effectiveTestFraction(a) === effectiveTestFraction(b)
        ? "tie"
        : effectiveTestFraction(a) > effectiveTestFraction(b)
          ? "a"
          : "b",
  },
];

/** Concrete per-criterion evidence values, so the persisted pairwise reason
 * says WHAT differed (not just which axis name was consulted). */
function criterionValue(key: string, c: CandidateEvidence): string {
  switch (key) {
    case "gates":
      return requiredGateLabel(c);
    case "gates_coverage":
      return `acceptance ${(acceptanceFraction(c) * 100).toFixed(0)}%`;
    case "blockers":
      return `${openBlockerCount(c)} open blocker(s)`;
    case "tests":
      return `tests ${testEvidenceLabel(c)}`;
    default:
      return key;
  }
}

function requiredGateLabel(candidate: CandidateEvidence): string {
  if (!candidate.gates.some((gate) => gate.required)) return "required gates n/a (none configured)";
  return requiredGatesPassed(candidate) ? "required gates passed" : "required gates FAILED";
}

function pairwise(a: CandidateEvidence, b: CandidateEvidence): PairwiseComparison {
  const criteria: PairwiseComparison["criteria"] = {};
  for (const c of CRITERIA) {
    const winner = c.better(a, b);
    criteria[c.key] = {
      winner,
      reason: `${a.label}: ${criterionValue(c.key, a)} vs ${b.label}: ${criterionValue(c.key, b)}`,
    };
  }
  return { candidate_a: a.label, candidate_b: b.label, criteria };
}

/**
 * Evidence-first arbitration. Ranks candidates lexicographically by hard gates,
 * acceptance coverage, accepted blockers, tests, clean
 * review, simplicity, cost. When the top two candidates are an EXACT
 * tie on every evidence axis, the winner is chosen deterministically by route
 * order and that tie is DISCLOSED in the decision (final_checks) — there is no
 * hidden LLM tie-break, so the choice is never silently presented as decisive.
 */
export function arbitrate(
  candidates: CandidateEvidence[],
  opts: { spendUsd?: number | null; estimatedSpend?: boolean } = {},
): ArbitrationResult {
  if (candidates.length === 0) {
    return {
      ranking: [],
      decision: DecisionRecordSchema.parse({
        winner: null,
        status: "failed",
        outcome: "blocked",
        why_winner: "no candidates",
        evidence_facts: ["no candidates were produced"],
        apply_recommendation: "continue",
      }),
      pairwise: [],
    };
  }

  const ranking = [...candidates].sort((a, b) => compareTuples(scoreTuple(a), scoreTuple(b)));
  const winner = ranking[0] as CandidateEvidence;
  const runnerUp = ranking[1];
  // An exact tie on every evidence axis: the winner is the first in route order.
  // Disclose it instead of presenting the pick as evidence-decisive.
  const tiedWithRunnerUp = runnerUp
    ? compareTuples(scoreTuple(winner), scoreTuple(runnerUp)) === 0
    : false;

  const requiredOk = requiredGatesPassed(winner);
  const blockerCount = openBlockerCount(winner);
  const winnerOk = requiredOk && winner.finalReviewClean && blockerCount === 0;
  const noOpOk = requiredOk && blockerCount === 0;
  const hasDiff = (winner.diffBytes ?? winner.diffSize ?? 0) > 0;
  const hasGates = winner.testsTotal > 0 || winner.gates.length > 0;
  const reviewRan = winner.reviewVerified === true;
  // A clean, route-proof-VERIFIED cross-family review is real verification even
  // when no deterministic test gate is configured. `reviewRan` already
  // requires crossFamilyVerified (observed route proofs, §5), so this never
  // adopts an unobserved/argv-echo review. The patch-hash binding is enforced
  // separately by the apply gate.
  const reviewCleanVerified = reviewRan && winner.finalReviewClean && blockerCount === 0;
  const harnessFailed = winner.gates.some((g) => g.id === "harness" && g.status === "failed");
  const outcome = harnessFailed
    ? "blocked"
    : !hasDiff
      ? noOpOk
        ? "no_op"
        : "blocked"
      : !hasGates
        ? reviewCleanVerified
          ? "ready"
          : "ungated"
        : !reviewRan
          ? "review_not_run"
          : winnerOk
            ? "ready"
            : "blocked";
  // Honest disclosure of WHAT verified an applyable run. "both" requires a
  // DETERMINISTIC gate — a real test count or a REQUIRED gate that passed — not
  // mere gate presence (a non-required/diagnostic gate must not read as "tests
  // passed"). A no-gate run adopted on review evidence is cross_family_review.
  const gateVerified =
    (winner.testsTotal > 0 && winner.testsPassed === winner.testsTotal) ||
    winner.gates.some((g) => g.required && g.status === "passed");
  const verificationBasis =
    outcome === "ready" ? (gateVerified ? "both" : "cross_family_review") : "none";
  const status = harnessFailed
    ? "failed"
    : outcome === "ready"
      ? "success"
      : outcome === "no_op"
        ? "no_op"
        : outcome === "ungated"
          ? "ungated"
          : outcome === "review_not_run"
            ? "review_not_run"
            : "not_converged";

  const whyNot: Record<string, string> = {};
  for (const c of ranking.slice(1)) {
    const reasons: string[] = [];
    if (!requiredGatesPassed(c)) reasons.push("required gates not all passing");
    if (openBlockerCount(c) > 0) reasons.push(`${openBlockerCount(c)} open blocker(s)`);
    if (acceptanceFraction(c) < acceptanceFraction(winner))
      reasons.push("lower gates-derived criteria coverage");
    if (effectiveTestFraction(c) < effectiveTestFraction(winner))
      reasons.push("weaker test evidence");
    if (!c.finalReviewClean) reasons.push("no clean final review");
    whyNot[c.label] = reasons.length > 0 ? reasons.join("; ") : "narrowly behind on tie-breakers";
  }

  const acceptedRisks = winner.findings
    .filter((f) => f.status === "accepted_risk")
    .map((f) => f.claim);

  const decision = DecisionRecordSchema.parse({
    winner: winner.attemptId,
    status,
    outcome,
    why_winner: `${winner.label}: gates=${requiredGateLabel(winner)}, gates_coverage=${acceptanceLabel(winner)}, blockers=${openBlockerCount(winner)}, tests=${testEvidenceLabel(winner)}, cleanReview=${winner.finalReviewClean}`,
    why_not_others: whyNot,
    accepted_risks: acceptedRisks,
    final_checks: [
      requiredGateLabel(winner),
      `final cross-family review ${winner.finalReviewClean ? "clean" : "not clean"}`,
      ...(tiedWithRunnerUp
        ? [
            `tie: winner chosen by route order (no distinguishing evidence vs ${runnerUp?.label ?? "runner-up"})`,
          ]
        : []),
    ],
    evidence_facts: [
      `diff ${hasDiff ? "non-empty" : "empty"}`,
      `gates ${hasGates ? "configured" : "not configured"}`,
      `review ${reviewRan ? "verified" : "not verified"}`,
      `blockers ${openBlockerCount(winner)}`,
    ],
    budget_summary: {
      spend_usd: opts.spendUsd ?? winner.costUsd ?? null,
      estimated: opts.estimatedSpend ?? false,
    },
    apply_recommendation:
      outcome === "ready"
        ? "apply"
        : outcome === "no_op"
          ? "inspect"
          : outcome === "ungated" || outcome === "review_not_run"
            ? "human_review"
            : openBlockerCount(winner) > 0
              ? "human_review"
              : "continue",
    verification_basis: verificationBasis,
  });

  const pairs: PairwiseComparison[] = [];
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      pairs.push(pairwise(ranking[i] as CandidateEvidence, ranking[j] as CandidateEvidence));
    }
  }

  return { ranking, decision, pairwise: pairs };
}
