import {
  reviewerProcessingAdmission,
  ProcessingBudgetAdmissionError,
} from "./processing-dispatch.js";
import { unrenderedResultNotice } from "./resultNotice.js";
import type { BudgetDenial } from "./budgetFailure.js";
import { join } from "node:path";
import { reviewerProcessingCost } from "./processing-routing.js";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { BudgetLedger } from "@claudexor/budget";
import { reviewUsageCostSettlement, attemptCostEvidence } from "@claudexor/budget";
import type { CandidateEvidence } from "@claudexor/arbitration";
import type { EventLog } from "@claudexor/event-log";
import {
  type ReviewerSpec,
  reviewCandidate,
  revalidateFindings,
  evaluateConvergence,
} from "@claudexor/review";
import {
  type ActiveTaskContract,
  isBlocking,
  resolveRunReviewRequested,
  runStartStrategyViolations,
} from "@claudexor/schema";
import { writeText } from "@claudexor/util";
import { scopeMarkerEnv } from "@claudexor/core";
import {
  hasCandidateChanges,
  type CandidateRun,
  toCandidateEvidence,
} from "./candidateEvidence.js";
import { policyFindings } from "./policyFindings.js";
import { renderTestsEvidence } from "./contract-gates.js";
import { reviewerTimeoutMs, envInheritance, type ResolvedConfigLike } from "./runSupport.js";
import type { OrchestratorDeps, RunInput } from "./orchestrator.js";
import { prepareDirectoryReview } from "./directoryCandidate.js";
import { materializeUnrenderedCandidate, type UnrenderedCandidateFiles } from "./savedCandidate.js";

/** Direct embedders may explicitly inject a panel. Accepted wire requests have
 * their boolean already frozen, so later global panel defaults cannot enable it. */
export function resolveEngineReview(input: RunInput, deps: OrchestratorDeps): boolean {
  const value = {
    ...input,
    ...(input.review === undefined
      ? {
          reviewerPanel: deps.reviewers?.length ? deps.reviewers : deps.reviewerPanel,
          reviewerModels: deps.reviewerModels,
          reviewerEfforts: deps.reviewerEfforts,
        }
      : {}),
  };
  const violations = runStartStrategyViolations({
    mode: value.mode,
    review: value.review,
    n: value.n,
    attempts: value.attempts,
    untilClean: value.untilClean,
  });
  if (violations.length)
    throw Object.assign(new Error(violations.join("; ")), {
      code: "invalid_strategy",
      status: 400,
      retryable: false,
    });
  return resolveRunReviewRequested(value);
}

/** Preserve deterministic policy evidence without preparing any reviewer work. */
export function unreviewedCandidateEvidence(
  run: CandidateRun,
  contract: ActiveTaskContract,
  store: ArtifactStore,
  paths: RunPaths,
  log: EventLog,
): CandidateEvidence {
  const policy = policyFindings(
    run,
    false,
    contract.constraints.protected_paths,
    contract.constraints.auto_protected_paths,
    contract.constraints.protected_path_approvals,
    contract.constraints.deny_paths,
    false,
  );
  store.writeYaml(join(paths.reviewsDir, `${run.attemptId}.yaml`), {
    attempt_id: run.attemptId,
    review_requested: false,
    review_verified: false,
    final_review_clean: false,
    reviewer_requests: [],
    route_proofs: [],
    risk: policy.risk,
    findings: policy.findings,
  });
  for (const finding of policy.findings)
    log.emit("finding.revalidated", {
      attempt_id: run.attemptId,
      severity: finding.severity,
      status: finding.status,
    });
  return toCandidateEvidence(run, contract, policy.findings, false, false);
}

/** Capped review-off repair still checks gates, policy and the work report. */
export function evaluateUnreviewedConvergence(
  evidence: CandidateEvidence,
  contract: ActiveTaskContract,
) {
  const result = evaluateConvergence({
    predicate: contract.convergence,
    gates: evidence.gates,
    findings: evidence.findings,
    finalReviewClean: false,
    diffStableAfterReview: false,
  });
  const work = evidence.workState?.state;
  if (work === "needs_input" || work === "incomplete") {
    result.converged = false;
    result.reasons.push(`work report: ${work}`);
  }
  return result;
}

interface ReviewRunsInput {
  runs: CandidateRun[];
  reviewers: ReviewerSpec[];
  reviewVerified: boolean;
  reviewDir: string;
  cwd: string;
  contract: ActiveTaskContract;
  store: ArtifactStore;
  paths: RunPaths;
  log: EventLog;
  ledger?: BudgetLedger;
  taskId?: string;
  signal?: AbortSignal;
  reservationEstimateUsd?: number;
  /** Convergence verifies its full candidate even when a repair made no change. */
  reviewUnchanged?: boolean;
  /** The run's process-scope marker: reviewer processes are the run's to end too. */
  runScopeMarker?: string;
}
interface ReviewRunsDeps {
  prepareReviewEvidenceDir: (source: string, cwd: string) => string;
  recordReviewEvidenceCleanup: (
    store: ArtifactStore,
    path: string,
    attemptId: string,
    dir: string,
    cwd: string,
  ) => void;
  reviewScoped: (
    input: Parameters<typeof reviewCandidate>[0],
  ) => ReturnType<typeof reviewCandidate>;
  config: (cwd: string) => ResolvedConfigLike;
}

/** Existing candidate-review owner, shared by race and synthesized candidates. */
export async function reviewCandidateRuns(
  input: ReviewRunsInput,
  deps: ReviewRunsDeps,
): Promise<CandidateEvidence[]> {
  const {
    runs,
    reviewers,
    reviewVerified,
    reviewDir,
    cwd,
    contract,
    store,
    paths,
    log,
    ledger,
    taskId,
    signal,
    reservationEstimateUsd,
    runScopeMarker,
  } = input;
  if (contract.review_requested === false) {
    return runs.map((run) => unreviewedCandidateEvidence(run, contract, store, paths, log));
  }
  const evidences: CandidateEvidence[] = [];
  for (const run of runs) {
    let candidateCwd = run.reviewCwd ?? cwd;
    const candidateEvidenceDir = deps.prepareReviewEvidenceDir(reviewDir, candidateCwd);
    let directoryReview: Awaited<ReturnType<typeof prepareDirectoryReview>> | undefined;
    let savedFiles: UnrenderedCandidateFiles | null = null;
    try {
      if (run.files) {
        directoryReview = await prepareDirectoryReview(run.files, candidateEvidenceDir);
        candidateCwd = directoryReview.cwd;
      }
      writeText(
        join(candidateEvidenceDir, "TESTS.txt"),
        renderTestsEvidence(contract, run.gates).trim() + "\n",
      );
      // a candidate that changed NO files has nothing to review — never
      // spend a reviewer panel on "(empty diff)" (a trivial greeting in agent mode used to
      // cost two reviewers). It still flows through policy gates and arbitration
      // (so a failing test gate or no_op outcome is unchanged), just unreviewed.
      const hasDiff = input.reviewUnchanged || hasCandidateChanges(run);
      // Reviewer panels spend real money: reserve before, settle the observed cost.
      const reviewLease =
        hasDiff && reviewers.length > 0
          ? ledger?.reserve({
              taskId: taskId ?? "task",
              attemptId: run.attemptId,
              intent: "review",
              harnessId: "review-panel",
              cost: attemptCostEvidence(
                "review-panel",
                run.attemptId,
                reservationEstimateUsd,
                "unknown",
                reviewerProcessingCost(reviewers),
              ),
            })
          : undefined;
      let processingDenial: BudgetDenial | null = null;
      const reviewing = hasDiff && reviewers.length > 0 && (reviewLease?.granted ?? true);
      // Reviewers judge the same exact result that apply consumes. An unrendered
      // object result (#535) gets an explicit bounded notice, its changed paths form
      // the candidate inventory, and they read those files from its saved tree: a
      // configured gate has run in the workspace since the capture. A copy that
      // failed gives them its typed causes instead, and nothing to read.
      if (reviewing && run.patchViewUnavailable) {
        savedFiles = await materializeUnrenderedCandidate(
          run,
          join(paths.reviewsDir, `${run.attemptId}-saved-files`),
          contract.repo.root,
          candidateCwd,
        );
        if (savedFiles) candidateCwd = savedFiles.dir;
      }
      const result = reviewing
        ? await deps.reviewScoped({
            candidateLabel: run.label,
            diff: run.patchViewUnavailable ? unrenderedResultNotice(run) : run.diff,
            ...(directoryReview
              ? { candidatePaths: directoryReview.paths, candidatePathsHaveManifest: true }
              : run.patchViewUnavailable
                ? {
                    candidatePaths: run.changedPaths ?? [],
                    savedCopy: {
                      unavailable:
                        savedFiles?.unavailable ??
                        (run.changedPaths ?? []).map((path) => ({
                          path,
                          reason: "saved_file_unavailable",
                        })),
                      // No copy, or a failed one: nothing is read from `cwd`.
                      failed: savedFiles?.failed ?? true,
                    },
                  }
                : {}),
            evidenceDir: candidateEvidenceDir,
            artifactsDir: join(paths.reviewsDir, `${run.attemptId}-reviewers`),
            cwd: candidateCwd,
            reviewers,
            reviewerTimeoutMs: reviewerTimeoutMs(deps.config(contract.repo.root)),
            envInheritance: envInheritance(deps.config(cwd)),
            // The reviewer's scratch HOME is decided by the review engine; the
            // run marker is added here so the reviewer and its shells are the
            // run's members (the #449 orphans were reviewer-slot shells).
            ...(runScopeMarker ? { env: scopeMarkerEnv(runScopeMarker) } : {}),
            signal,
            onReviewerEvent: (event) => log.emit(event.type, { ...event }),
            onBeforeDispatch:
              ledger && reviewLease?.granted
                ? reviewerProcessingAdmission(
                    ledger,
                    reviewLease.lease!.lease_id,
                    reviewers,
                    run.attemptId,
                    (denial) => {
                      processingDenial ??= denial;
                    },
                  )
                : undefined,
            onUsageCost: (usd) => {
              if (reviewLease?.granted) ledger?.updateHold(reviewLease.lease!.lease_id, usd);
              return ledger?.tier() === "hard";
            },
          })
        : {
            findings: [],
            routeProofs: [],
            reviewerRequests: [],
            crossFamilyHealthy: false,
            healthyProviders: [],
            crossFamilyVerified: false,
            distinctProviders: [],
            reviewSpendUsd: 0,
            reviewSpendEstimated: false,
            reviewCashUsd: 0,
            reviewCashKnowledge: "unknown" as const,
            reviewValuationUsd: 0,
            reviewValuationKnowledge: "unknown" as const,
            reviewUnknownUsd: 0,
          };
      if (reviewLease?.granted) {
        ledger?.settle(
          reviewLease.lease?.lease_id ?? "",
          reviewUsageCostSettlement(
            result.reviewCashUsd,
            result.reviewValuationUsd,
            {
              cash: result.reviewCashKnowledge,
              allowanceDebitUnobserved: result.reviewAllowanceDebitUnobserved,
              valuation: result.reviewValuationKnowledge,
            },
            [`attempt:${run.attemptId}`, "review:panel"],
            result.reviewUnknownUsd,
          ),
        );
        if ((result.reviewSpendUsd ?? 0) > 0) {
          log.emit("budget.observation", {
            harness_id: "review-panel",
            attempt_id: run.attemptId,
            kind: "spend",
            usd: result.reviewSpendUsd,
            cash_usd: result.reviewCashUsd,
            valuation_usd: result.reviewValuationUsd,
            unknown_usd: result.reviewUnknownUsd,
            estimated: result.reviewSpendEstimated === true,
          });
        }
      } else if (reviewLease && !reviewLease.granted) {
        log.emit("budget.lease.created", {
          granted: false,
          reason: reviewLease.reason,
          attempt_id: run.attemptId,
          harness_id: "review-panel",
        });
      }
      if (processingDenial) throw new ProcessingBudgetAdmissionError(processingDenial);
      const revalidated = await revalidateFindings(result.findings, {
        candidateRoot: candidateCwd,
        evidenceDir: candidateEvidenceDir,
      });
      // The high-risk human gate must key off the ACTUAL cross-family verification
      // (stream-observed route proofs), not the preliminary routeVerified (families
      // merely configured). Otherwise a high-risk diff skips its NEEDS_HUMAN gate
      // when two families were configured but their route proofs went unverified.
      // Mirrors the convergence path (actualReviewVerified).
      const candidateReviewVerified =
        reviewVerified && result.crossFamilyHealthy && result.crossFamilyVerified;
      // Typed policy gate (risk + protected paths) merges with reviewer findings.
      const policy = policyFindings(
        run,
        candidateReviewVerified,
        contract.constraints.protected_paths,
        contract.constraints.auto_protected_paths,
        contract.constraints.protected_path_approvals,
        contract.constraints.deny_paths,
      );
      const allFindings = [...policy.findings, ...revalidated];
      const inconclusive = allFindings.some(
        (f) => f.severity === "INSUFFICIENT_EVIDENCE" || f.status === "insufficient_evidence",
      );
      const noBlockers = !allFindings.some((f) => isBlocking(f));
      const reviewClean =
        result.crossFamilyHealthy && result.crossFamilyVerified && noBlockers && !inconclusive;
      store.writeYaml(join(paths.reviewsDir, `${run.attemptId}.yaml`), {
        attempt_id: run.attemptId,
        review_verified: candidateReviewVerified,
        final_review_clean: reviewClean,
        cross_family_healthy: result.crossFamilyHealthy,
        cross_family_verified: result.crossFamilyVerified,
        healthy_providers: result.healthyProviders,
        verified_providers: result.distinctProviders,
        reviewer_requests: result.reviewerRequests,
        risk: policy.risk,
        findings: allFindings,
        route_proofs: result.routeProofs,
        // Candidate files no reviewer could inspect (#535): named, never dropped.
        ...(result.uninspectableFiles?.length
          ? {
              uninspectable_files: result.uninspectableFiles.map((file) => ({
                path: file.path,
                reason: file.reason,
              })),
            }
          : {}),
      });
      for (const f of allFindings)
        log.emit("finding.revalidated", {
          attempt_id: run.attemptId,
          severity: f.severity,
          status: f.status,
        });
      evidences.push(
        toCandidateEvidence(run, contract, allFindings, reviewClean, candidateReviewVerified),
      );
    } finally {
      await directoryReview?.dispose();
      await savedFiles?.dispose();
      deps.recordReviewEvidenceCleanup(
        store,
        join(paths.reviewsDir, `${run.attemptId}-evidence-cleanup.yaml`),
        run.attemptId,
        candidateEvidenceDir,
        candidateCwd,
      );
    }
  }
  return evidences;
}
