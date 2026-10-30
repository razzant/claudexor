import {
  controlRoute,
  readFailure,
  strategyFromParams,
  legacyRunOutcomeFacts,
  planProjectionFor,
  projectAuthRoute,
} from "./run-card-facts.js";
import { budgetSnapshot } from "./run-budget-snapshot.js";
import { runRepoRoot, applyEligibilityFor } from "./run-apply-projection.js";
import { projectProcessScope } from "./run-detail-scope.js";

import { readTextArtifact, safeReadStructuredArtifact } from "./run-artifact-read.js";
import { controlRunResult } from "./run-delivery-state.js";
import { lstatSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { lastRunEventSeq } from "@claudexor/event-log";
import { executionFactsOf } from "@claudexor/workspace";
import { isVanishedErrno, safeArtifactPath } from "./artifact-paths.js";

import { continuationSummary } from "./run-continuation-projection.js";
import { boundedArtifactText, outputReadyState, primaryOutput } from "./primary-output.js";

import { controlWebEvidence, latestPlanProgress, timelineEvents } from "./run-timeline.js";
import { readRunEventFacts, type RunEventFacts } from "./run-event-facts.js";
import {
  paramsRecord,
  type ControlOperatorDecisionRecord,
  type DaemonRunRecord,
} from "./run-record.js";
import { candidatesFor } from "./candidates.js";
import { listArtifacts } from "./artifact-serve-routes.js";
import { runExecutionRoot } from "./run-execution-root.js";

import {
  effectiveTerminalFacts,
  expectedRunFacts,
  projectRunFactsForDetail,
} from "./run-facts-projection.js";
import {
  CouncilProjection,
  AccessProfile,
  ControlReviewerPanelEntry,
  ControlRunDetail,
  ControlRunSummary,
  PaidBudget,
  type ControlPendingInteraction,
  DecisionRecord,
  ModeKind,
  RoutingGoal,
  ReviewFinding,
  RunFailure,
  RunTelemetry,
  StructuredOutputConformance,
  TaskContract,
  ProtectedPathApproval,
  type RunOutcomeFacts,
  type WorkState,
  outcomeBanner,
  TestCommandInvocation,
  WorkProduct,
} from "@claudexor/schema";
import { noProjectRepoRoot } from "@claudexor/util";
import { parse as parseYaml } from "yaml";

/* ---- Thread projections (engine snake_case -> control camelCase) ---- */

function projectMetadata(rec: DaemonRunRecord): {
  kind: "project" | "none";
  root: string | null;
  projectName: string | null;
  context: "off" | "auto";
} {
  const p = paramsRecord(rec);
  const scope = p["scope"];
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    const s = scope as Record<string, unknown>;
    if (s["kind"] === "none")
      return { kind: "none", root: null, projectName: null, context: "off" };
    if (s["kind"] === "project" && typeof s["root"] === "string") {
      return {
        kind: "project",
        root: s["root"],
        projectName: basename(s["root"]),
        context: "auto",
      };
    }
  }
  const repoRoot = runRepoRoot(rec);
  const noProject = repoRoot === NO_PROJECT_ROOT;
  return {
    kind: noProject ? "none" : "project",
    root: noProject ? null : repoRoot,
    projectName: noProject || !repoRoot ? null : basename(repoRoot),
    context: noProject ? "off" : "auto",
  };
}
const NO_PROJECT_ROOT = noProjectRepoRoot();

/**
 * Honest terminal outcome, projected from final/work_product.yaml's meta (the
 * orchestrator-owned record of what the turn produced). Answers the v0.9 "is the
 * game done?" gap: plan runs report kind=plan with a null diffStat (no files
 * changed), patches report a real diffStat, and a race-adopted patch reports
 * adopted=true.
 */
/** Project the D8 terminal outcome AXES for a run: decision.facts when present
 * (the arbitrated truth), else derived from the typed failure category + the
 * lifecycle (a decision-less plan/readonly/crash terminal). Null while the run
 * is not terminal. Lives here as the ONE control-plane projection; surfaces
 * read `outcomeFacts`, never re-derive. */
export function runOutcomeFacts(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  failure: RunFailure | null,
  /** D-16: the winning read-only/plan attempt's work_state (from telemetry),
   * folded into a DECISION-LESS terminal so a needs_input/incomplete ask
   * carries its veto axis just like an arbitrated agent run. */
  workState: WorkState | null = null,
): RunOutcomeFacts | null {
  const legacy = legacyRunOutcomeFacts(rec, decision, failure, workState);
  if (!legacy) return null;
  return effectiveTerminalFacts(rec.runDir, legacy, decision, expectedRunFacts(rec)).outcomeFacts;
}

/** D-16: the winning attempt's work_state from a run's telemetry.yaml, used to
 * fold the veto axis into a decision-less terminal's outcome facts. */
export function winnerWorkStateFor(rec: DaemonRunRecord): WorkState | null {
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  if (!telemetry) return null;
  const winner = telemetry.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  return winner?.outcome.work_state ?? null;
}

/** An ancestor's continuation facts from the bounded event fold run detail keeps between reads. */
function ancestorFacts(runDir: string) {
  return executionFactsOf(readRunEventFacts({ runDir }).execution);
}

/** Run detail passes its folded event facts, which also add continuity receipts. */
export function summarizeRun(rec: DaemonRunRecord, facts?: RunEventFacts): ControlRunSummary {
  const p = paramsRecord(rec);
  const project = projectMetadata(rec);
  // safeParse everywhere: one malformed job record (e.g. an old/foreign mode id)
  // must degrade to an unknown field, never 500 the whole run list forever.
  const parsedMode = ModeKind.safeParse(p["mode"]);
  const parsedRoutingGoal = RoutingGoal.safeParse(p["routingGoal"]);
  const parsedAccess = parseAccessMaybe(p["access"]);
  const task = safeReadStructuredArtifact(rec, "context/task.yaml", TaskContract);
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  const outputConformance = safeReadStructuredArtifact(
    rec,
    "final/structured_output.yaml",
    StructuredOutputConformance,
  );
  // Access truth comes from engine artifacts ONLY (contract/telemetry); client
  // params can request but never assert what was effectively enforced.
  const requestedAccess =
    telemetry?.requested_access ?? task?.access.requested_profile ?? parsedAccess;
  const effectiveAccess = telemetry?.effective_access ?? task?.access.effective_profile;
  const externalContextPolicy = telemetry?.external_context_policy ?? task?.external_context.policy;
  const webEvidence = controlWebEvidence(telemetry, task);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const failure = readFailure(rec);
  const finalAttempt = telemetry?.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  const workState = finalAttempt?.outcome.work_state ?? null;
  const legacyOutcome = legacyRunOutcomeFacts(rec, decision, failure, workState);
  const terminalFacts = legacyOutcome
    ? effectiveTerminalFacts(rec.runDir, legacyOutcome, decision, expectedRunFacts(rec))
    : { runFacts: null, outcomeFacts: null, decision };
  const budget = budgetSnapshot(rec, decision, facts);
  const parsedReviewerPanel = Array.isArray(p["reviewerPanel"])
    ? ControlReviewerPanelEntry.array().safeParse(p["reviewerPanel"])
    : null;
  const parsedProtectedPathApprovals = Array.isArray(p["protectedPathApprovals"])
    ? ProtectedPathApproval.array().safeParse(p["protectedPathApprovals"])
    : null;
  const requestTests = Array.isArray(p["tests"])
    ? TestCommandInvocation.array().safeParse(p["tests"]).data
    : undefined;
  const contractTests = task?.tests.commands.map(({ program, args, cwd, envAllowlist }) => ({
    program,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    envAllowlist,
  }));
  return ControlRunSummary.parse({
    jobId: rec.id,
    runId: rec.runId ?? rec.id,
    parentRunId:
      (typeof p["parentRunId"] === "string" ? p["parentRunId"] : null) ??
      task?.run_lineage.parent_run_id ??
      null,
    delegatedFromRunId:
      (typeof p["delegatedFromRunId"] === "string" ? p["delegatedFromRunId"] : null) ??
      task?.run_lineage.delegated_from_run_id ??
      null,
    delegation: telemetry?.delegation ?? null,
    ...continuationSummary(rec, facts, facts && ancestorFacts),
    taskId: rec.taskId,
    state: rec.state,
    runDir: rec.runDir,
    error: rec.error,
    failure,
    project,
    executionRoot: runExecutionRoot(rec, project.root),
    mode: parsedMode.success ? parsedMode.data : undefined,
    strategy: strategyFromParams(p),
    prompt:
      rec.promptPreview ??
      (typeof p["prompt"] === "string" ? promptPreview(p["prompt"]) : undefined),
    harnesses: Array.isArray(p["harnesses"])
      ? p["harnesses"].filter((x): x is string => typeof x === "string")
      : undefined,
    primaryHarness: typeof p["primaryHarness"] === "string" ? p["primaryHarness"] : undefined,
    routingGoal: parsedRoutingGoal.success ? parsedRoutingGoal.data : undefined,
    model: typeof p["model"] === "string" ? p["model"] : undefined,
    review: task?.review_requested ?? (typeof p["review"] === "boolean" ? p["review"] : undefined),
    reviewerPanel: parsedReviewerPanel?.success ? parsedReviewerPanel.data : undefined,
    protectedPathApprovals: parsedProtectedPathApprovals?.success
      ? parsedProtectedPathApprovals.data
      : undefined,
    n: typeof p["n"] === "number" ? p["n"] : undefined,
    paidBudget: PaidBudget.safeParse(p["paidBudget"]).data ?? task?.budget.paid_budget,
    spendUsd: budget.spendUsd,
    spendEstimated: budget.estimated,
    // Token usage is projected straight from the engine-owned telemetry rollup —
    // never re-derived from raw events; runs that predate it report null.
    inputTokens: telemetry?.usage_totals.input_tokens ?? null,
    outputTokens: telemetry?.usage_totals.output_tokens ?? null,
    cachedInputTokens: telemetry?.usage_totals.cached_input_tokens ?? null,
    inputTokenUsage: telemetry?.usage_totals.input_token_usage,
    // The single engine validator's receipt, projected verbatim — surfaces
    // never re-validate the answer (null = no structured-output contract).
    outputConformance: outputConformance?.status ?? null,
    authRoute: projectAuthRoute(telemetry),
    access: effectiveAccess ?? parsedAccess,
    requestedAccess,
    effectiveAccess,
    externalContextPolicy,
    webRequired: telemetry?.web_required ?? task?.external_context.web_required,
    webMode: telemetry?.effective_web_mode ?? task?.external_context.effective_mode,
    webEvidence,
    requestRequirements: telemetry?.request_requirements ?? [],
    toolPermissionPolicy: task?.tool_permission_policy,
    outputReadyState: outputReadyState(
      rec,
      parsedMode.success ? parsedMode.data : null,
      failure,
      terminalFacts.runFacts,
    ),
    toolWarningsTotal: telemetry?.tool_warnings_total ?? 0,
    result: controlRunResult(rec),
    outcomeFacts: terminalFacts.outcomeFacts,
    route: controlRoute(telemetry, p),
    // QA-034: routing rationale projected verbatim from the engine telemetry —
    // surfaces never reconstruct the order from prose.
    routingRationale: telemetry?.routing_rationale ?? null,
    // #147: what the request that produced the result carried, typed.
    rawContext: finalAttempt?.raw_context ?? null,
    tests: requestTests ?? (contractTests?.length ? contractTests : undefined),
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  });
}

export function detailFor(
  rec: DaemonRunRecord,
  pendingInteractions: ControlPendingInteraction[] = [],
  cursor?: number,
  operator: ControlOperatorDecisionRecord | null = null,
  children: ControlRunSummary[] = [],
  retentionProblem: string | null = null,
): ControlRunDetail {
  // Capture the resume fence before projection. Events arriving during queued
  // work may appear in both detail and replay; clients reconcile duplicates.
  // This prevents a resume gap without claiming an atomic snapshot across the
  // independently published artifacts or displaying every retained event.
  const lastSeq = cursor ?? (rec.runDir ? lastRunEventSeq(join(rec.runDir, "events.jsonl")) : 0);
  const failure = readFailure(rec);
  const decision = safeReadStructuredArtifact(rec, "arbitration/decision.yaml", DecisionRecord);
  const operatorDecisionRaw = operator
    ? { action: operator.action, decidedAt: operator.decidedAt }
    : null;
  // RunDetail perf (D15): fold events.jsonl ONCE per detail request and thread
  // the facts through every event-consuming projection (timeline, budget
  // fallback, plan progress, continuity). The bulk worker keeps a run's folded
  // prefix between requests, so a repeated detail parses only appended lines.
  const facts = readRunEventFacts(rec);
  const summary = summarizeRun(rec, facts);
  // applyEligibility is non-null exactly when the run has an applyable patch —
  // the authoritative "something to apply" banner signal (a convergence patch
  // may carry kind:patch with no meta.result_kind, so result.kind alone would
  // miss it).
  const { runFacts, outcomeFacts, applyEligibility, requiredActions } = projectRunFactsForDetail(
    rec.runDir,
    summary.outcomeFacts ?? null,
    operator !== null,
    () => applyEligibilityFor(rec, operator),
    expectedRunFacts(rec),
  );
  const planProjection = planProjectionFor(rec, summary.mode);
  const telemetry = safeReadStructuredArtifact(rec, "final/telemetry.yaml", RunTelemetry);
  return ControlRunDetail.parse({
    attemptExecution: telemetry?.attempts.map((attempt) => ({
      attemptId: attempt.attempt_id,
      harnessId: attempt.harness_id,
      processing: attempt.processing,
      processingCostBasis: attempt.processing_cost_basis,
      usageCost: attempt.usage_cost,
    })),
    summary: {
      ...summary,
      outcomeFacts,
      waitingOnUser: pendingInteractions.length > 0,
      processScope: projectProcessScope(rec, summary.state),
    },
    children,
    runFacts,
    // Server-owned outcome headline (D18), from the single projection owner —
    // surfaces render it verbatim above model prose, never re-derive it.
    outcomeBanner: outcomeBanner(outcomeFacts, {
      applyState: summary.result.applyState,
      hasApplyableChange: applyEligibility !== null,
    }),
    lastSeq,
    artifacts: rec.runDir ? listArtifacts(rec.runDir) : [],
    primaryOutput: retentionProblem
      ? { kind: "diagnostic", path: "events.jsonl", text: retentionProblem }
      : primaryOutput(rec, summary.mode, failure, runFacts),
    timeline: timelineEvents(rec, facts.timeline, facts.integrity),
    budget: budgetSnapshot(rec, decision, facts),
    finalSummary: boundedArtifactText(rec, "final/summary.md"),
    decision,
    operatorDecision: operatorDecisionRaw,
    workProduct: safeReadStructuredArtifact(rec, "final/work_product.yaml", WorkProduct),
    // Derived apply-gate verdict (single producer: delivery's
    // deriveApplyEligibility) — null when the run has no patch artifact.
    planReadiness: planProjection.readiness,
    planQuestions: planProjection.questions,
    council: councilFor(rec, summary.mode),
    applyEligibility,
    reviewFindings: readReviewFindings(rec),
    pendingInteractions,
    // Per-candidate evidence cards: projected from the run's attempt/
    // review artifacts; empty for single-envelope modes.
    candidates: rec.runDir ? candidatesFor(rec.runDir, decision) : [],
    // Live plan checklist: the winner's (else last) plan.progress items.
    planProgress: latestPlanProgress(rec, decision?.winner ?? null, facts.plans, facts.integrity),
    failure,
    // Minimal typed required-actions (GH #29) for a succeeded-but-blocked run,
    // from the single status-projection owner: review-blocked / checks-failed /
    // needs-decision / work_state needs_input, keyed to the same validated
    // operator decision the needs-decision + apply gates consult — the
    // canonical terminal actions plus legitimate post-terminal overlays.
    requiredActions,
  });
}

function parseAccessMaybe(value: unknown): AccessProfile | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = AccessProfile.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Council membership + merge disclosure (INV-031), projected from
 * `council/membership.yaml`. Null for solo plans and non-plan runs — the plan
 * artifacts themselves are shape-identical, so this is purely additive. */
function councilFor(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
): CouncilProjection | null {
  if (mode !== "plan" || !rec.runDir) return null;
  return safeReadStructuredArtifact(rec, "council/membership.yaml", CouncilProjection);
}

function readReviewFindings(rec: DaemonRunRecord): ReviewFinding[] {
  if (!rec.runDir) return [];
  let names: string[];
  try {
    const reviewsDir = safeArtifactPath(rec.runDir, "reviews");
    if (!reviewsDir || !lstatSync(reviewsDir).isDirectory()) return [];
    names = readdirSync(reviewsDir).sort();
  } catch (err) {
    // reviews/ vanished between resolve and read (GH #128 race class): no
    // findings, never a 500. Non-vanish errnos stay loud.
    if (isVanishedErrno(err)) return [];
    throw err;
  }
  const out: ReviewFinding[] = [];
  for (const name of names) {
    const ext = extname(name);
    if (ext !== ".yaml" && ext !== ".yml" && ext !== ".json") continue;
    try {
      const rel = `reviews/${name}`;
      const raw = readTextArtifact(rec, rel);
      if (!raw) continue;
      const doc = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const findings =
        doc && typeof doc === "object" && !Array.isArray(doc)
          ? (doc as Record<string, unknown>)["findings"]
          : [];
      if (!Array.isArray(findings)) continue;
      for (const finding of findings) out.push(ReviewFinding.parse(finding));
    } catch {
      /* malformed review artifact: omit from UI projection, artifact remains fetchable for diagnostics */
    }
  }
  return out;
}

function promptPreview(prompt: string): string {
  return prompt.length > 240 ? `${prompt.slice(0, 240)}...` : prompt;
}
