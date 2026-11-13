import { join } from "node:path";
import { finalizePlanRun } from "./planFinalize.js";
export { finalizePlanRun } from "./planFinalize.js";
import {
  MAX_COUNCIL_MEMBERS_DEFAULT,
  type ActiveTaskContract,
  makeOutcomeFacts,
  type ModeKind,
} from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { BudgetLedger } from "@claudexor/budget";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { readOnlyNoSuccessTerminal } from "./attemptFinalize.js";
import { cancelledResult, writeFailure } from "./runTerminals.js";
import { requestRefusalFailure } from "./runTerminalResults.js";
import { unanimousDeclaredFailure } from "./candidateEvidence.js";
import { type BudgetDenial, budgetFailureRecord, classifyBudgetFailure } from "./budgetFailure.js";
import { attemptCauseLines, attemptVendorFailure } from "./harnessFailure.js";
import { dominantHarnessFailureCategory, harnessFailureNextActions } from "./harnessFailure.js";
import {
  buildCouncilProjection,
  councilDraftRelPath,
  councilMergePrompt,
  resolveCouncilWidth,
} from "./council.js";
import { stageCouncilDraft, type CouncilMergeInput } from "./council-input.js";
import type { OrchestratorResult, RoutedAdapter, RunInput } from "./orchestrator.js";
import {
  plannerAttemptSummary,
  type PlannerAttemptArgs,
  type PlannerAttemptOutcome,
} from "./plannerAttempt.js";
type PlanAttemptSummary = ReturnType<typeof plannerAttemptSummary>;
/** Council orchestration and shared solo/Council finalize/failure tails. */
export interface PlanRunDeps {
  /** One native read-only planner spawn, shared by solo, Council draft and merge. */
  runPlannerAttempt(args: PlannerAttemptArgs): Promise<PlannerAttemptOutcome>;
  /** Persist the run telemetry artifact (auth-preference resolution lives on
   * the orchestrator, so this stays a bound method). */
  writeRunTelemetry(
    store: ArtifactStore,
    paths: RunPaths,
    contract: ActiveTaskContract,
    runId: string,
    taskId: string,
    mode: ModeKind,
    attempts: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[],
    finalAttemptId: string | null,
  ): void;
  /** The tree the harness executes in (project vs. isolated thread worktree). */
  execRootOf(input: RunInput): string;
  /** The solo planner prompt (native plan-mode template with the tagged Open
   * Questions block); council members draft with the same prompt. */
  planPrompt(goal: string): string;
  /** Startup-frozen cap for Council membership. */
  maxCouncilMembers?: number;
}

/** Council (INV-031/D31) drafts in parallel through the ordinary read-only
 * planner, then the primary synthesizes surviving file-backed inputs.
 * Only the merged plan supplies final questions/artifacts. Failed members stay
 * failed even when their narrowly eligible unverified text informs the merge. */
export async function runCouncilPlan(
  deps: PlanRunDeps,
  args: {
    input: RunInput;
    contract: ActiveTaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    adapters: RoutedAdapter[];
    roHome: { env: Record<string, string>; dispose: () => Promise<void> };
    contextSection: string;
    laneRun: boolean;
    estimateUsdFloor: number;
  },
): Promise<OrchestratorResult> {
  const { input, contract, taskId, runId, store, paths, log, ledger, adapters, roHome } = args;
  const planAttempts: PlanAttemptSummary[] = [];
  const attemptTelemetries: {
    attemptId: string;
    harnessId: string;
    telemetry: AttemptTelemetry;
  }[] = [];
  // Distinct pool members, primary first (adapters are already ordered +
  // deduped by resolveCandidateAdapters with n=undefined). Council never
  // duplicates a harness into two members.
  const { requested, members: memberCount } = resolveCouncilWidth(
    input.n,
    adapters.length,
    deps.maxCouncilMembers ?? MAX_COUNCIL_MEMBERS_DEFAULT,
  );
  const memberAdapters = adapters.slice(0, memberCount);
  log.emit("council.started", {
    requested,
    members: memberAdapters.map((a) => a.adapter.id),
  });
  const mergeInputs: CouncilMergeInput[] = [];
  const draftedIds = new Set<string>();
  const preservedDrafts: string[] = [];
  // First pre-spawn budget refusal owns an all-members-failed budget terminal.
  let councilBudgetDenial: BudgetDenial | null = null;
  try {
    // Round 1 — parallel drafts (each member = one planner attempt).
    const outcomes = await Promise.allSettled(
      memberAdapters.map((routed, idx) =>
        deps.runPlannerAttempt({
          input,
          contract,
          taskId,
          runId,
          log,
          store,
          paths,
          ledger,
          routed,
          attemptId: `p${String(idx + 1).padStart(2, "0")}`,
          laneRun: args.laneRun,
          fallbackHome: roHome.env,
          promptBody: deps.planPrompt(input.prompt) + args.contextSection,
          intent: "plan",
          reservationEstimateUsd:
            idx > 0 || input.delegatedFromRunId ? args.estimateUsdFloor : undefined,
        }),
      ),
    );
    for (const settled of outcomes) {
      if (settled.status === "rejected") continue;
      const outcome = settled.value;
      const staged = stageCouncilDraft(outcome, store, paths, input.signal?.aborted === true);
      if (staged.preservedDraft) preservedDrafts.push(staged.preservedDraft);
      if (staged.input) mergeInputs.push(staged.input);
      if (outcome.telemetry)
        attemptTelemetries.push({
          attemptId: outcome.attemptId,
          harnessId: outcome.harnessId,
          telemetry: outcome.telemetry,
        });
      planAttempts.push({
        ...plannerAttemptSummary(outcome),
        status: outcome.status === "success" && !staged.input ? "failed" : outcome.status,
        error: staged.error,
      });
      if (outcome.budgetDenied) councilBudgetDenial ??= outcome.budgetDenial ?? null;
      if (staged.input && !staged.input.unverified) {
        draftedIds.add(outcome.harnessId);
        log.emit("council.draft", {
          harness_id: outcome.harnessId,
          path: councilDraftRelPath(outcome.harnessId),
        });
      } else {
        log.emit("council.member.failed", {
          harness_id: outcome.harnessId,
          attempt_id: outcome.attemptId,
          error: staged.input?.unverified ? outcome.error : staged.error,
          ...(staged.input?.unverified
            ? { unverified_draft_path: councilDraftRelPath(outcome.harnessId) }
            : {}),
        });
      }
    }
    // A planner already normalizes harness failures. Unexpected persistence or
    // event failures remain run failures, after siblings and saved inputs settle.
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected) throw rejected.reason;
  } catch (err) {
    // QA-047 root cause 2: the success path keeps roHome alive so the merge
    // REUSES the admitted context (draft authenticated there) instead of a
    // fresh HOME whose cold native-status probe times out. Leak-safe here.
    await roHome.dispose();
    throw err;
  }

  if (input.signal?.aborted) {
    await roHome.dispose();
    return cancelledResult(
      log,
      runId,
      taskId,
      "plan",
      paths.root,
      planAttempts.map((p) => ({
        attemptId: p.attemptId,
        harnessId: p.harnessId,
        status: p.status,
      })),
      () =>
        deps.writeRunTelemetry(
          store,
          paths,
          contract,
          runId,
          taskId,
          "plan",
          attemptTelemetries,
          null,
        ),
      ledger.spend(),
      input.signal,
      store,
    );
  }

  if (mergeInputs.length === 0) {
    await roHome.dispose();
    return writePlanHarnessFailure(
      deps,
      {
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
        budgetDenial: councilBudgetDenial,
        aggregateFailure: true,
        preservedDrafts,
      },
      "all council members failed",
    );
  }

  // Prefer accepted drafts in admitted order, then the first eligible unverified lane.
  const primary =
    memberAdapters.find((a) => draftedIds.has(a.adapter.id)) ??
    (memberAdapters.find((a) =>
      mergeInputs.some((d) => d.harnessId === a.adapter.id),
    ) as RoutedAdapter);
  let mergeOutcome: PlannerAttemptOutcome;
  try {
    mergeOutcome = await deps.runPlannerAttempt({
      input,
      contract,
      taskId,
      runId,
      log,
      store,
      paths,
      ledger,
      routed: primary,
      attemptId: `p${String(memberCount + 1).padStart(2, "0")}`,
      laneRun: args.laneRun,
      // QA-047 root cause 2: merge in the SAME admitted route context (not a
      // fresh HOME whose cold native-status probe times out as an absent login).
      fallbackHome: roHome.env,
      promptBody: councilMergePrompt(input.prompt, mergeInputs),
      // D31: the merge is a synthesis iteration on the primary.
      intent: "synthesize",
      reservationEstimateUsd: input.delegatedFromRunId ? args.estimateUsdFloor : undefined,
    });
  } finally {
    await roHome.dispose();
  }
  if (mergeOutcome.telemetry)
    attemptTelemetries.push({
      attemptId: mergeOutcome.attemptId,
      harnessId: mergeOutcome.harnessId,
      telemetry: mergeOutcome.telemetry,
    });
  planAttempts.push(plannerAttemptSummary(mergeOutcome));

  const mergedBy = mergeOutcome.status === "success" ? primary.adapter.id : null;
  // QA-047 root cause 4: a member card carries its DRAFT error only — the
  // primary owns two attempts under one harness id (draft + merge), so a
  // harness-id-only lookup would misattach the merge failure to a drafted member.
  const mergeAttemptId = mergeOutcome.attemptId;
  const councilProjection = buildCouncilProjection({
    requested,
    members: memberAdapters.map((a) => ({
      harnessId: a.adapter.id,
      role: a.adapter.id === primary.adapter.id ? "primary" : "member",
      drafted: draftedIds.has(a.adapter.id),
      error:
        planAttempts.find(
          (p) => p.harnessId === a.adapter.id && p.attemptId !== mergeAttemptId && p.error,
        )?.error ?? null,
    })),
    mergedBy,
  });
  log.emit("council.merged", {
    merged_by: mergedBy,
    drafted: councilProjection.drafted,
    requested: councilProjection.requested,
    degraded: councilProjection.degraded,
  });

  if (mergeOutcome.status !== "success" || !mergeOutcome.text) {
    // The merge itself failed despite surviving drafts — no unified plan
    // exists. Fail typed; the drafts remain as disclosed artifacts.
    await store.writeYamlAsync(join(paths.root, "council", "membership.yaml"), councilProjection);
    return writePlanHarnessFailure(
      deps,
      {
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
        budgetDenial: mergeOutcome.budgetDenied ? (mergeOutcome.budgetDenial ?? null) : null,
        preservedDrafts,
      },
      `council merge failed: ${mergeOutcome.error ?? "the primary produced no unified plan"}`,
    );
  }

  return finalizePlanRun(deps, {
    input,
    contract,
    taskId,
    runId,
    store,
    paths,
    log,
    ledger,
    plans: [{ id: primary.adapter.id, text: mergeOutcome.text }],
    planAttempts,
    attemptTelemetries,
    winnerAttemptId: mergeOutcome.attemptId,
    council: councilProjection,
    councilUnverifiedInputs: mergeInputs.filter((d) => d.unverified).length,
  });
}

/** Shared failure projection when solo planning or Council produces no plan. */
export function writePlanHarnessFailure(
  deps: PlanRunDeps,
  ctx: {
    contract: ActiveTaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    planAttempts: PlanAttemptSummary[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
    /** QA-050: preserve a planner's pre-spawn budget denial. */
    budgetDenial?: BudgetDenial | null;
    preservedDrafts?: string[];
    aggregateFailure?: boolean;
  },
  fallbackMessage: string,
): OrchestratorResult {
  const { contract, taskId, runId, store, paths, log, ledger, planAttempts } = ctx;
  const blocked = planAttempts.some((p) => p.status === "blocked");
  // QA-050: budget and policy precedence is independent of input refusals.
  const budgetMapping =
    !blocked && (ctx.budgetDenial || ledger.terminal())
      ? classifyBudgetFailure({ denial: ctx.budgetDenial ?? null, terminal: ledger.terminal() })
      : null;
  // QA-047: successful drafts remain preserved evidence, never failure lines.
  const failed = planAttempts.filter((p) => p.status !== "success");
  const failedLines = attemptCauseLines(failed, ctx.attemptTelemetries);
  const preserved =
    ctx.preservedDrafts ??
    planAttempts.filter((p) => p.status === "success").map((p) => `${p.attemptId}/${p.harnessId}`);
  const message = redactSecrets(
    `${budgetMapping ? budgetMapping.safeMessage : failedLines.length > 0 ? failedLines.join("\n") : fallbackMessage}${preserved.length > 0 ? `\nPreserved drafts: ${preserved.join(", ")}` : ""}`.trim(),
  );
  deps.writeRunTelemetry(
    store,
    paths,
    contract,
    runId,
    taskId,
    "plan",
    ctx.attemptTelemetries,
    null,
  );
  store.writeText(
    join(paths.contextDir, "context_error.md"),
    `# ${budgetMapping ? "Budget Denied" : "Harness Error"}\n\n${message}\n`,
  );
  if (budgetMapping) {
    writeFailure(
      store,
      paths,
      budgetFailureRecord(budgetMapping, {
        eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
        runDir: paths.root,
      }),
    );
  } else {
    const refusals = (ctx.aggregateFailure ? planAttempts : planAttempts.slice(-1)).map(
      (p) =>
        p.declaredFailure ??
        (() => {
          const refusal = ctx.attemptTelemetries.find((a) => a.attemptId === p.attemptId)?.telemetry
            .requestRefusal;
          return refusal && requestRefusalFailure(refusal);
        })(),
    );
    const declared = blocked
      ? null
      : unanimousDeclaredFailure(
          refusals.map((refusal) => ({
            declaredFailure: refusal,
          })),
        );
    const harnessCategory = dominantHarnessFailureCategory(
      ctx.attemptTelemetries.flatMap((attempt) => attempt.telemetry.transientFailures),
    );
    writeFailure(store, paths, {
      // The typed provenance the attempt declared (code, reset, refusals) speaks.
      ...declared,
      phase: "harness",
      category: blocked ? "policy" : (declared?.category ?? "harness_error"),
      vendorFailure: ctx.aggregateFailure
        ? null
        : attemptVendorFailure(ctx.attemptTelemetries, planAttempts.at(-1)?.attemptId),
      safeMessage: message,
      eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
      runDir: paths.root,
      nextActions: harnessFailureNextActions(
        declared?.category === "config_error" ? "config_error" : harnessCategory,
      ),
    });
  }
  // D-16/#299: a typed limit stays interrupted after policy/budget precedence.
  const limit = planAttempts.find((p) => p.interruption !== null)?.interruption;
  // No canonical plan: the read-only owner must not promote discarded raw output.
  const noPlanTerminal = readOnlyNoSuccessTerminal({
    webBlocked: blocked,
    hasDeliverable: false,
    budgetStopped: false,
    attemptsCount: planAttempts.length,
  });
  const planFailFacts =
    !blocked && !budgetMapping && limit
      ? makeOutcomeFacts("interrupted", { reason: limit })
      : budgetMapping
        ? makeOutcomeFacts("failed", { reason: budgetMapping.reason })
        : makeOutcomeFacts(noPlanTerminal.lifecycle, { reason: noPlanTerminal.reason });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (plan)\n\n- Lifecycle: ${planFailFacts.lifecycle}${planFailFacts.reason ? ` (${planFailFacts.reason})` : ""}\n\n${message}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  const failPhase = budgetMapping ? budgetMapping.phase : "harness";
  log.emit("run.failed", {
    lifecycle: planFailFacts.lifecycle,
    facts: planFailFacts,
    reason: planFailFacts.reason,
    phase: failPhase,
    ...(budgetMapping?.harnessId ? { harness_id: budgetMapping.harnessId } : {}),
    error: message,
    failure_ref: "final/failure.yaml",
  });
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode: "plan",
    lifecycle: planFailFacts.lifecycle,
    facts: planFailFacts,
    winner: null,
    runDir: paths.root,
    summary: message,
    candidates: planAttempts.map((p) => ({
      attemptId: p.attemptId,
      harnessId: p.harnessId,
      status: p.status,
    })),
  };
}
