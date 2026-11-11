import type {
  DecisionRecord,
  GateResult,
  PairwiseComparison,
  ReviewFinding,
  WorkState,
} from "@claudexor/schema";
import {
  DecisionRecord as DecisionRecordSchema,
  isBlocking,
  reviewAllowsApply,
} from "@claudexor/schema";

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

/**
 * The candidate's CONFIGURED deterministic gates. The synthetic `harness`
 * pseudo-gate row (appended by the evidence producer when a run errored) is
 * process/lifecycle evidence, never a configured check — every checks-axis
 * consumer routes through this ONE filter so a producer that appends the
 * pseudo-gate (or repollutes the test counts) can't resurrect
 * "tests=0% / required gates FAILED" on a zero-configured-gate run.
 */
function configuredGates(c: CandidateEvidence): GateResult[] {
  return c.gates.filter((g) => g.id !== "harness");
}

/** Test counts for the label surfaces: when a producer's numeric counts were
 * computed over the AUGMENTED array (the sentinel present), re-derive from the
 * configured gates so "tests=0%" cannot resurrect through the numbers alone.
 * A gate-less producer keeps its own numbers — testsTotal is not always a
 * gate count on the public CandidateEvidence surface. */
function configuredTestCounts(c: CandidateEvidence): { passed: number; total: number } {
  const hasSentinel = c.gates.some((g) => g.id === "harness");
  if (!hasSentinel) return { passed: c.testsPassed, total: c.testsTotal };
  const configured = configuredGates(c);
  return {
    passed: configured.filter((g) => g.status === "passed").length,
    total: configured.length,
  };
}

/**
 * Ranking predicate — reads the AUGMENTED gates array ON PURPOSE: the
 * synthetic `harness` pseudo-gate is how an errored candidate is demoted in
 * the score tuple, and routing this through `configuredGates` was reproduced
 * to let an errored empty-diff candidate outrank a healthy one and terminate
 * the run harness_failed. The honesty fixes live in the LABEL and the checks
 * axis (both read `configuredGates`); ranking keeps lifecycle demotion.
 */
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
 * Test pass-fraction — the RANKING value, reading the RAW producer counts on
 * purpose. Routing it through `configuredTestCounts` was reproduced to change
 * existing ordering: two harness-errored candidates with 1/10 and 9/10 test
 * evidence both re-derived to 1/1 = 100% and the smaller-diff 1/10 candidate
 * won the axis. Zero tests is zero test EVIDENCE (0, never a vacuous 1).
 * (The held-out split axis was retired in the v0.15 triage: no producer ever
 * populated it — re-add WITH a real held-out runner if that
 * anti-reward-hacking design returns.)
 */
function effectiveTestFraction(c: CandidateEvidence): number {
  return c.testsTotal > 0 ? c.testsPassed / c.testsTotal : 0;
}

/** Human label for test evidence on VERDICT surfaces (why_winner,
 * final_checks): honest "n/a" when no tests exist at all — label-only, so it
 * may re-derive augmented-computed counts through `configuredTestCounts`. */
function testEvidenceLabel(c: CandidateEvidence): string {
  const { passed, total } = configuredTestCounts(c);
  if (total === 0) return "n/a";
  return `${((passed / total) * 100).toFixed(0)}%`;
}

/** The RANKING-axis format: describes the same raw counts the axis VALUE
 * ranks on (QA-028 — value and label on one surface may never disagree; the
 * configured label rendered two errored candidates as "100% vs 100%" while
 * raw 1/10-vs-9/10 decided the ordering, leaving the persisted decisive_axis
 * unable to explain itself). Verdict surfaces keep `testEvidenceLabel`. */
function rawTestAxisLabel(c: CandidateEvidence): string {
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
    // The axis FORMAT must describe the same predicate the axis RANKS on
    // (QA-028: value and label on one surface may never disagree). Ranking
    // reads the AUGMENTED gates, so a harness-errored candidate formats as
    // FAILED-with-cause here even when zero gates are configured — while the
    // verdict surfaces (requiredGateLabel/checks) keep configured-only truth.
    format: (c) => {
      if (requiredGatesPassed(c)) return requiredGateLabel(c);
      return configuredGates(c).some((gate) => gate.required)
        ? "required gates FAILED"
        : "required gates FAILED (harness errored; none configured)";
    },
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
    format: (c) => rawTestAxisLabel(c),
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
  const required = configuredGates(candidate).filter((gate) => gate.required);
  if (required.length === 0) return "required gates n/a (none configured)";
  // The label describes CONFIGURED gates only — lifecycle (the pseudo-gate)
  // must not turn "every configured gate passed" into a FAILED claim.
  return required.every((gate) => gate.status === "passed")
    ? "required gates passed"
    : "required gates FAILED";
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
  opts: {
    /** Frozen run intent; absence preserves historical review-required behavior. */
    reviewRequested?: boolean;
    spendUsd?: number | null;
    estimatedSpend?: boolean;
    /** QA-010b: settled cash vs subscription-valuation split from the ledger,
     * so the decision record carries the reviewer-inclusive totals (not just
     * the cash figure). */
    cashUsd?: number | null;
    /** Cap-governed cash beside an unknown total (unobserved included debit). */
    controllableCashUsd?: number | null;
    valuationUsd?: number | null;
    valuationKnowledge?: "exact" | "estimated" | "unknown";
  } = {},
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
          ...(opts.reviewRequested !== undefined ? { review_requested: opts.reviewRequested } : {}),
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

  const blockerCount = openBlockerCount(winner);
  const hasDiff = (winner.diffBytes ?? winner.diffSize ?? 0) > 0;
  const harnessFailed = winner.gates.some((g) => g.id === "harness" && g.status === "failed");
  // v3 AXES (D8/D18): the harness pseudo-gate row is process evidence, not a
  // configured deterministic check — it feeds lifecycle and RANKING, never the
  // checks axis (the old lattice let it flip hasGates and reroute the whole
  // tree). So EVERY input to the checks axis is configured-derived: the gates
  // via `configuredGates`, the counts via `configuredTestCounts` (a producer
  // that computed counts over the augmented array cannot re-admit the
  // pseudo-gate through the numbers), and the required predicate over the
  // configured rows — `requiredGatesPassed` reads the augmented gates for the
  // score tuple and must not leak here, or a configured-green run whose
  // harness errored renders "required gates passed" beside checks=failed on
  // one record. Gate-less producers keep their raw test counts, so failing
  // tests without gates still fail checks (base behavior).
  const realGates = configuredGates(winner);
  const cfgCounts = configuredTestCounts(winner);
  const checksConfigured = cfgCounts.total > 0 || realGates.length > 0;
  const cfgRequired = realGates.filter((g) => g.required);
  const cfgRequiredOk =
    cfgRequired.length === 0 ? true : cfgRequired.every((g) => g.status === "passed");
  const checksPassed =
    checksConfigured &&
    cfgRequiredOk &&
    (cfgCounts.total === 0 || cfgCounts.passed === cfgCounts.total);
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
    ...(opts.reviewRequested !== undefined ? { review_requested: opts.reviewRequested } : {}),
    reason,
    ...(workState ? { work_state: workState } : {}),
  } as const;
  // Honest disclosure of WHAT verified an applyable run. "both" requires a
  // DETERMINISTIC check — a real test count or a REQUIRED gate that passed —
  // not mere presence. A no-check run adopted on review evidence is
  // cross_family_review. Review permission and verification evidence differ.
  const gateVerified =
    (winner.testsTotal > 0 && winner.testsPassed === winner.testsTotal) ||
    realGates.some((g) => g.required && g.status === "passed");
  const applyable =
    lifecycle === "succeeded" && reviewAllowsApply(facts) && checks !== "failed" && !workVeto;
  const verificationBasis = !applyable
    ? "none"
    : review === "approved"
      ? gateVerified
        ? "both"
        : "cross_family_review"
      : gateVerified
        ? "deterministic_checks"
        : "none";

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
      opts.reviewRequested === false
        ? "model review not requested"
        : `final cross-family review ${winner.finalReviewClean ? "clean" : "not clean"}`,
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
      // An explicit null is the ledger's unknown total, not a missing figure.
      spend_usd: opts.spendUsd !== undefined ? opts.spendUsd : (winner.costUsd ?? null),
      estimated: opts.estimatedSpend ?? false,
      cash_usd: opts.cashUsd ?? null,
      ...(opts.controllableCashUsd !== undefined
        ? { controllable_cash_usd: opts.controllableCashUsd }
        : {}),
      valuation_usd: opts.valuationUsd ?? null,
      ...(opts.valuationKnowledge ? { valuation_knowledge: opts.valuationKnowledge } : {}),
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
