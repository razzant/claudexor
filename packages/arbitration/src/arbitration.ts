import type {
  DecisionRecord,
  GateResult,
  PairwiseComparison,
  ReviewFinding,
  WorkState,
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
  /** D-16 model-attested work outcome for this candidate (INV-116): a
   * needs_input/incomplete state vetoes applyability without flipping the
   * lifecycle. Absent on routes with no work_report transport. */
  workState?: WorkState;
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

/**
 * The single ordered ranking-axis registry (QA-028 root cause #1). Ranking,
 * the pairwise artifact, the winner/loser explanations, the decisive-axis
 * disclosure, and the per-candidate scorecard ALL derive from this one list, so
 * a new axis can never be added to the score tuple without also appearing in
 * every evidence surface. `value` is higher-is-better (compared lexicographically,
 * best-first); `format` is the human/machine value shown on every surface.
 */
interface RankingAxis {
  key: string;
  value: (c: CandidateEvidence) => number;
  format: (c: CandidateEvidence) => string;
}

const AXES: RankingAxis[] = [
  {
    key: "required_gates",
    value: (c) => (requiredGatesPassed(c) ? 1 : 0),
    format: (c) => requiredGateLabel(c),
  },
  {
    key: "acceptance_coverage",
    value: (c) => acceptanceFraction(c),
    format: (c) => acceptanceLabel(c),
  },
  {
    key: "blockers",
    value: (c) => -openBlockerCount(c),
    format: (c) => `${openBlockerCount(c)}`,
  },
  {
    key: "tests",
    value: (c) => effectiveTestFraction(c),
    format: (c) => testEvidenceLabel(c),
  },
  {
    key: "clean_review",
    value: (c) => (c.finalReviewClean ? 1 : 0),
    format: (c) => `${c.finalReviewClean}`,
  },
  {
    key: "tool_warnings",
    value: (c) => -(c.toolWarningsCount ?? 0),
    format: (c) => `${c.toolWarningsCount ?? 0}`,
  },
  {
    key: "diff_size",
    value: (c) => -(c.diffSize ?? 0),
    format: (c) => `${c.diffSize ?? 0}`,
  },
  {
    key: "cost",
    value: (c) => -(c.costUsd ?? 0),
    format: (c) => (c.costUsd === undefined ? "unknown" : `${c.costUsd}`),
  },
];

/** The ordered ranking-axis keys, in precedence (best-first) order. */
export function scoreAxisKeys(): string[] {
  return AXES.map((a) => a.key);
}

/** Higher is better, compared lexicographically (evidence-first ordering). */
export function scoreTuple(c: CandidateEvidence): number[] {
  return AXES.map((a) => a.value(c));
}

/** The first ranking axis on which two candidates differ, with both formatted
 * values — the axis that actually decided the pair. Null on an exact tie. */
function decisiveAxis(
  winner: CandidateEvidence,
  runnerUp: CandidateEvidence,
): { key: string; winner_value: string; runner_up_value: string } | null {
  for (const axis of AXES) {
    if (axis.value(winner) !== axis.value(runnerUp)) {
      return {
        key: axis.key,
        winner_value: axis.format(winner),
        runner_up_value: axis.format(runnerUp),
      };
    }
  }
  return null;
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

function requiredGateLabel(candidate: CandidateEvidence): string {
  if (!candidate.gates.some((gate) => gate.required)) return "required gates n/a (none configured)";
  return requiredGatesPassed(candidate) ? "required gates passed" : "required gates FAILED";
}

/** Pairwise comparison over EVERY ranking axis (QA-028 root cause #2): the
 * persisted artifact now serializes the same axes the score tuple ranks by,
 * with both candidates' concrete values, so the axis that actually decided the
 * pair is never absent from the record. */
function pairwise(a: CandidateEvidence, b: CandidateEvidence): PairwiseComparison {
  const criteria: PairwiseComparison["criteria"] = {};
  for (const axis of AXES) {
    const av = axis.value(a);
    const bv = axis.value(b);
    const winner = av === bv ? "tie" : av > bv ? "a" : "b";
    criteria[axis.key] = {
      winner,
      reason: `${a.label}: ${axis.format(a)} vs ${b.label}: ${axis.format(b)}`,
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
        facts: {
          lifecycle: "failed",
          noChanges: true,
          checks: "not_configured",
          review: "not_run",
          reason: "harness_failed",
        },
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
  const hasDiff = (winner.diffBytes ?? winner.diffSize ?? 0) > 0;
  const harnessFailed = winner.gates.some((g) => g.id === "harness" && g.status === "failed");
  // v3 AXES (D8/D18): the harness pseudo-gate row is process evidence, not a
  // configured deterministic check — it feeds lifecycle, never the checks
  // axis (the old lattice let it flip hasGates and reroute the whole tree).
  const realGates = winner.gates.filter((g) => g.id !== "harness");
  const checksConfigured = winner.testsTotal > 0 || realGates.length > 0;
  const checksPassed =
    checksConfigured &&
    requiredOk &&
    (winner.testsTotal === 0 || winner.testsPassed === winner.testsTotal);
  const checks = checksConfigured ? (checksPassed ? "passed" : "failed") : "not_configured";
  const reviewRan = winner.reviewVerified === true;
  // Accepted blockers ALWAYS surface as review=blocked — even from an
  // unverified panel (the old lattice masked them behind "ungated"/
  // "review_not_run"; that collapse class is the D18 fix). A clean verdict
  // still requires the VERIFIED cross-family review (observed route proofs).
  const review =
    blockerCount > 0
      ? "blocked"
      : reviewRan
        ? winner.finalReviewClean
          ? "approved"
          : "blocked"
        : "not_run";
  const lifecycle = harnessFailed ? "failed" : "succeeded";
  const noChanges = !hasDiff;
  // D-16 work_state veto (INV-116): a needs_input/incomplete winner keeps the
  // succeeded lifecycle but is non-applyable and carries a typed reason — it
  // only ELEVATES, never masking a harder failure (harness/review/checks win).
  const workState = winner.workState;
  const workVeto =
    lifecycle === "succeeded" &&
    (workState?.state === "needs_input" || workState?.state === "incomplete");
  const reason = harnessFailed
    ? "harness_failed"
    : review === "blocked"
      ? "review_blocked"
      : checks === "failed"
        ? "checks_failed"
        : workVeto
          ? workState?.state === "needs_input"
            ? "input_required"
            : "work_incomplete"
          : noChanges
            ? "no_changes"
            : null;
  const facts = {
    lifecycle,
    noChanges,
    checks,
    review,
    reason,
    ...(workState ? { work_state: workState } : {}),
  } as const;
  // Honest disclosure of WHAT verified an applyable run. "both" requires a
  // DETERMINISTIC check — a real test count or a REQUIRED gate that passed —
  // not mere presence. A no-check run adopted on review evidence is
  // cross_family_review. Only an APPROVED review is applyable-quality.
  const gateVerified =
    (winner.testsTotal > 0 && winner.testsPassed === winner.testsTotal) ||
    realGates.some((g) => g.required && g.status === "passed");
  const applyable =
    lifecycle === "succeeded" && review === "approved" && checks !== "failed" && !workVeto;
  const verificationBasis = applyable ? (gateVerified ? "both" : "cross_family_review") : "none";

  // The decisive axis for the WINNER vs the runner-up: the first axis on which
  // they differ (null on an exact tie, where route order decided).
  const decisive = runnerUp ? decisiveAxis(winner, runnerUp) : null;

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
    // QA-028 root cause #4: when a candidate lost purely on a tie-breaker axis,
    // NAME that axis and both values instead of the opaque "narrowly behind on
    // tie-breakers". The per-loser decisive axis is computed against the winner.
    if (reasons.length === 0) {
      const loserDecisive = decisiveAxis(winner, c);
      whyNot[c.label] = loserDecisive
        ? `lost on ${loserDecisive.key}: ${loserDecisive.runner_up_value} vs winner ${loserDecisive.winner_value}`
        : "exact tie on every ranking axis; winner chosen by route order";
    } else {
      whyNot[c.label] = reasons.join("; ");
    }
  }

  // Full per-candidate scorecard, in final ranking order (QA-028 root cause #6):
  // every ranking axis value for every candidate, so the decision is
  // self-contained and no surface has to re-derive the tuple order from source.
  const rankingScorecard = ranking.map((c) => ({
    attempt_id: c.attemptId,
    label: c.label,
    axes: Object.fromEntries(AXES.map((axis) => [axis.key, axis.format(c)])),
  }));

  const acceptedRisks = winner.findings
    .filter((f) => f.status === "accepted_risk")
    .map((f) => f.claim);

  const decision = DecisionRecordSchema.parse({
    winner: winner.attemptId,
    facts,
    why_winner: `${winner.label}: gates=${requiredGateLabel(winner)}, gates_coverage=${acceptanceLabel(winner)}, blockers=${openBlockerCount(winner)}, tests=${testEvidenceLabel(winner)}, cleanReview=${winner.finalReviewClean}${
      decisive
        ? `; decisive_axis=${decisive.key} (${decisive.winner_value} vs ${decisive.runner_up_value})`
        : runnerUp
          ? "; exact tie on every ranking axis, winner chosen by route order"
          : ""
    }`,
    why_not_others: whyNot,
    ranking_policy_version: 1,
    score_axes: scoreAxisKeys(),
    ranking_scorecard: rankingScorecard,
    decisive_axis: decisive,
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
      `checks ${checks}`,
      `review ${review}${reviewRan ? " (verified)" : ""}`,
      `blockers ${openBlockerCount(winner)}`,
    ],
    budget_summary: {
      spend_usd: opts.spendUsd ?? winner.costUsd ?? null,
      estimated: opts.estimatedSpend ?? false,
    },
    apply_recommendation: applyable
      ? noChanges
        ? "inspect"
        : "apply"
      : noChanges && review !== "blocked" && checks !== "failed"
        ? "inspect"
        : review === "blocked" || checks === "failed" || review === "not_run"
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
