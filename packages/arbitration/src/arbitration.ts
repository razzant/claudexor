import type { DecisionRecord, GateResult, PairwiseComparison, ReviewFinding } from "@claudexor/schema";
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
  /** Held-out tests hidden from the implementer — authoritative when present. */
  heldOutPassed?: number;
  heldOutTotal?: number;
  finalReviewClean: boolean;
  reviewVerified?: boolean;
  /** Smaller = simpler (e.g. diff line count). */
  diffSize?: number;
  diffBytes?: number;
  costUsd?: number;
  latencyMs?: number;
}

function requiredGatesPassed(c: CandidateEvidence): boolean {
  const required = c.gates.filter((g) => g.required);
  return required.length === 0 ? true : required.every((g) => g.status === "passed");
}

function acceptanceFraction(c: CandidateEvidence): number {
  return c.acceptanceTotal > 0 ? c.acceptanceCovered.length / c.acceptanceTotal : 1;
}

function openBlockerCount(c: CandidateEvidence): number {
  return c.findings.filter((f) => isBlocking(f)).length;
}

/**
 * Effective test pass-fraction. Held-out tests are authoritative when present
 * (anti-reward-hacking): a candidate that passes visible tests but fails the
 * held-out split must NOT outrank one that passes both.
 */
function effectiveTestFraction(c: CandidateEvidence): number {
  if (c.heldOutTotal && c.heldOutTotal > 0) {
    const held = (c.heldOutPassed ?? 0) / c.heldOutTotal;
    const visible = c.testsTotal > 0 ? c.testsPassed / c.testsTotal : 1;
    // Weight held-out heavily; a held-out failure dominates.
    return held * 0.8 + visible * 0.2;
  }
  return c.testsTotal > 0 ? c.testsPassed / c.testsTotal : 1;
}

/** Higher is better, compared lexicographically (evidence-first ordering). */
export function scoreTuple(c: CandidateEvidence): number[] {
  return [
    requiredGatesPassed(c) ? 1 : 0, // hard gates
    acceptanceFraction(c), // acceptance coverage
    -openBlockerCount(c), // fewer accepted blockers
    effectiveTestFraction(c), // tests/repro (held-out authoritative)
    c.finalReviewClean ? 1 : 0, // final clean review
    -(c.diffSize ?? 0), // simplicity
    -(c.costUsd ?? 0), // cost
    -(c.latencyMs ?? 0), // latency
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

const CRITERIA: { key: string; better: (a: CandidateEvidence, b: CandidateEvidence) => "a" | "b" | "tie" }[] = [
  {
    key: "gates",
    better: (a, b) =>
      requiredGatesPassed(a) === requiredGatesPassed(b) ? "tie" : requiredGatesPassed(a) ? "a" : "b",
  },
  {
    key: "acceptance",
    better: (a, b) =>
      acceptanceFraction(a) === acceptanceFraction(b) ? "tie" : acceptanceFraction(a) > acceptanceFraction(b) ? "a" : "b",
  },
  {
    key: "blockers",
    better: (a, b) =>
      openBlockerCount(a) === openBlockerCount(b) ? "tie" : openBlockerCount(a) < openBlockerCount(b) ? "a" : "b",
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

function pairwise(a: CandidateEvidence, b: CandidateEvidence): PairwiseComparison {
  const criteria: PairwiseComparison["criteria"] = {};
  for (const c of CRITERIA) {
    const winner = c.better(a, b);
    criteria[c.key] = { winner, reason: `${c.key}` };
  }
  return { candidate_a: a.label, candidate_b: b.label, criteria };
}

/**
 * Evidence-first arbitration. Ranks candidates lexicographically by hard gates,
 * acceptance coverage, accepted blockers, (held-out-authoritative) tests, clean
 * review, simplicity, cost, latency — LLM judgment is reserved for ties only
 * (caller-provided), never overriding hard evidence.
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

  const requiredOk = requiredGatesPassed(winner);
  const blockerCount = openBlockerCount(winner);
  const winnerOk = requiredOk && winner.finalReviewClean && blockerCount === 0;
  const noOpOk = requiredOk && blockerCount === 0;
  const hasDiff = (winner.diffBytes ?? winner.diffSize ?? 0) > 0;
  const hasGates = winner.testsTotal > 0 || winner.gates.length > 0;
  const reviewRan = winner.reviewVerified === true;
  const harnessFailed = winner.gates.some((g) => g.id === "harness" && g.status === "failed");
  const outcome =
    harnessFailed
      ? "blocked"
      : !hasDiff
        ? noOpOk
          ? "no_op"
          : "blocked"
      : !hasGates
        ? "ungated"
        : !reviewRan
          ? "review_not_run"
          : winnerOk
            ? "ready"
            : "blocked";
  const status =
    harnessFailed
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
    if (acceptanceFraction(c) < acceptanceFraction(winner)) reasons.push("lower acceptance coverage");
    if (effectiveTestFraction(c) < effectiveTestFraction(winner)) reasons.push("weaker test evidence");
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
    why_winner: `${winner.label}: gates=${requiredGatesPassed(winner)}, acceptance=${(acceptanceFraction(winner) * 100).toFixed(0)}%, blockers=${openBlockerCount(winner)}, tests=${(effectiveTestFraction(winner) * 100).toFixed(0)}%, cleanReview=${winner.finalReviewClean}`,
    why_not_others: whyNot,
    accepted_risks: acceptedRisks,
    final_checks: [
      `required gates ${requiredGatesPassed(winner) ? "passed" : "FAILED"}`,
      `final cross-family review ${winner.finalReviewClean ? "clean" : "not clean"}`,
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
  });

  const pairs: PairwiseComparison[] = [];
  for (let i = 0; i < ranking.length; i++) {
    for (let j = i + 1; j < ranking.length; j++) {
      pairs.push(pairwise(ranking[i] as CandidateEvidence, ranking[j] as CandidateEvidence));
    }
  }

  return { ranking, decision, pairwise: pairs };
}
