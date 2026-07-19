import { join } from "node:path";
import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  makeOutcomeFacts,
  type CouncilProjection,
  type ModeKind,
  type TaskContract,
} from "@claudexor/schema";
import { newId, redactSecrets } from "@claudexor/util";
import { ArtifactStore, type RunPaths } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import { BudgetLedger } from "@claudexor/budget";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { cancelledResult, writeFailure } from "./runTerminals.js";
import { extractPlanQuestions } from "./planQuestions.js";
import { resolveReadOnlyRouteContext } from "./routeContext.js";
import {
  buildCouncilProjection,
  councilDegradationNote,
  councilDraftRelPath,
  councilMergePrompt,
  resolveCouncilWidth,
} from "./council.js";
import type {
  OrchestratorResult,
  PlannerAttemptArgs,
  PlannerAttemptOutcome,
  RoutedAdapter,
  RunInput,
} from "./orchestrator.js";

/**
 * Council plan strategy (INV-031 / D31) + the shared plan-run finalize/failure
 * tails, extracted from orchestrator.ts so the god-file does not absorb the new
 * behavior (complexity ratchet). These are FREE functions that receive the few
 * orchestrator methods they need via `PlanRunDeps`; every other collaborator is
 * a module-level import, identical to what the orchestrator used inline.
 */
export interface PlanRunDeps {
  /** One planner spawn (native plan mode, read-only) — the SAME machinery the
   * solo plan loop drives; council reuses it per member + for the merge. */
  runPlannerAttempt(args: PlannerAttemptArgs): Promise<PlannerAttemptOutcome>;
  /** Persist the run telemetry artifact (auth-preference resolution lives on
   * the orchestrator, so this stays a bound method). */
  writeRunTelemetry(
    store: ArtifactStore,
    paths: RunPaths,
    contract: TaskContract,
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
}

/**
 * Council plan strategy (INV-031 / D31). Round 1: every member drafts a plan
 * in parallel, REUSING the same planner spawn (native plan mode, read-only,
 * own lane home on a thread turn). Drafts land as file-backed run artifacts.
 * Merge: ONE extra planner iteration on the PRIMARY (intent=synthesize) whose
 * prompt POINTS at the surviving draft files by absolute path — the tagged
 * Open-Questions parser then runs on the MERGE output only, producing the
 * same final artifacts a solo plan produces (downstream unchanged). A failed
 * member is disclosed and the merge proceeds with survivors; ALL members
 * failing is a typed failure.
 */
export async function runCouncilPlan(
  deps: PlanRunDeps,
  args: {
    input: RunInput;
    contract: TaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    adapters: RoutedAdapter[];
    roHome: { env: Record<string, string>; dispose: () => void };
    contextSection: string;
    laneRun: boolean;
  },
): Promise<OrchestratorResult> {
  const { input, contract, taskId, runId, store, paths, log, ledger, adapters, roHome } = args;
  const planAttempts: {
    attemptId: string;
    harnessId: string;
    status: "success" | "failed" | "blocked";
    error: string | null;
  }[] = [];
  const attemptTelemetries: {
    attemptId: string;
    harnessId: string;
    telemetry: AttemptTelemetry;
  }[] = [];
  // Distinct pool members, primary first (adapters are already ordered +
  // deduped by resolveCandidateAdapters with n=undefined). Council never
  // duplicates a harness into two members.
  const { requested, members: memberCount } = resolveCouncilWidth(input.n, adapters.length);
  const memberAdapters = adapters.slice(0, memberCount);
  log.emit("council.started", {
    requested,
    members: memberAdapters.map((a) => a.adapter.id),
  });
  let drafts: { harnessId: string; text: string; absPath: string }[] = [];
  try {
    // Round 1 — parallel drafts (each member = one planner attempt).
    const outcomes = await Promise.all(
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
        }),
      ),
    );
    for (const [idx, outcome] of outcomes.entries()) {
      const routed = memberAdapters[idx] as RoutedAdapter;
      if (outcome.telemetry)
        attemptTelemetries.push({
          attemptId: outcome.attemptId,
          harnessId: outcome.harnessId,
          telemetry: outcome.telemetry,
        });
      planAttempts.push({
        attemptId: outcome.attemptId,
        harnessId: outcome.harnessId,
        status: outcome.status,
        error: outcome.error,
      });
      if (outcome.status === "success" && outcome.text) {
        const rel = councilDraftRelPath(routed.adapter.id);
        const absPath = join(paths.root, rel);
        store.writeText(absPath, redactSecrets(outcome.text) + "\n");
        drafts.push({ harnessId: routed.adapter.id, text: outcome.text, absPath });
        log.emit("council.draft", { harness_id: routed.adapter.id, path: rel });
      } else {
        log.emit("council.member.failed", {
          harness_id: outcome.harnessId,
          attempt_id: outcome.attemptId,
          error: outcome.error,
        });
      }
    }
  } finally {
    // Round-1 planners done — reclaim the shared read-only route context BEFORE
    // the merge (which spawns in the primary's own lane/route home again).
    roHome.dispose();
  }

  if (input.signal?.aborted) {
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

  // Degradation is honest: ALL members failed → typed failure (no plan to
  // merge). One survivor still merges (normalizes format + extracts questions).
  if (drafts.length === 0) {
    return writePlanHarnessFailure(
      deps,
      {
        input,
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
      },
      "all council members failed",
    );
  }

  // The merger is the primary when it survived round 1, else the first
  // surviving member — degradation must not sink an otherwise-good council on
  // a dead nominal primary. drafts.length > 0 guarantees a survivor exists.
  const draftedIds = new Set(drafts.map((d) => d.harnessId));
  const primary =
    memberAdapters.find((a) => draftedIds.has(a.adapter.id)) ??
    (memberAdapters[0] as RoutedAdapter);
  const roHome2 = resolveReadOnlyRouteContext(deps.execRootOf(input));
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
      fallbackHome: roHome2.env,
      // The merge references the draft FILES by absolute path (pointer lines);
      // full draft text never rides the prompt bubble.
      promptBody: councilMergePrompt(
        input.prompt,
        drafts.map((d) => ({ harnessId: d.harnessId, absPath: d.absPath })),
      ),
      // D31: the merge is a synthesis iteration on the primary.
      intent: "synthesize",
    });
  } finally {
    roHome2.dispose();
  }
  if (mergeOutcome.telemetry)
    attemptTelemetries.push({
      attemptId: mergeOutcome.attemptId,
      harnessId: mergeOutcome.harnessId,
      telemetry: mergeOutcome.telemetry,
    });
  planAttempts.push({
    attemptId: mergeOutcome.attemptId,
    harnessId: mergeOutcome.harnessId,
    status: mergeOutcome.status,
    error: mergeOutcome.error,
  });

  const mergedBy = mergeOutcome.status === "success" ? primary.adapter.id : null;
  const councilProjection = buildCouncilProjection({
    requested,
    members: memberAdapters.map((a) => ({
      harnessId: a.adapter.id,
      role: a.adapter.id === primary.adapter.id ? "primary" : "member",
      drafted: draftedIds.has(a.adapter.id),
      error: planAttempts.find((p) => p.harnessId === a.adapter.id && p.error)?.error ?? null,
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
    store.writeYaml(join(paths.root, "council", "membership.yaml"), councilProjection);
    return writePlanHarnessFailure(
      deps,
      {
        input,
        contract,
        taskId,
        runId,
        store,
        paths,
        log,
        ledger,
        planAttempts,
        attemptTelemetries,
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
  });
}

/** Write final plan artifacts (plan.md, questions.json, work_product,
 * summary, telemetry) and the terminal event, then return the result. ONE
 * owner for both the solo and council success tails so the artifacts are
 * shape-identical (downstream readiness/freeze/implement never branch). */
export function finalizePlanRun(
  deps: PlanRunDeps,
  args: {
    input: RunInput;
    contract: TaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    plans: { id: string; text: string }[];
    planAttempts: {
      attemptId: string;
      harnessId: string;
      status: "success" | "failed" | "blocked";
      error: string | null;
    }[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
    winnerAttemptId?: string | null;
    council: CouncilProjection | null;
  },
): OrchestratorResult {
  const {
    input,
    contract,
    taskId,
    runId,
    store,
    paths,
    log,
    ledger,
    plans,
    planAttempts,
    council,
  } = args;
  const failedPlanners = planAttempts.filter((p) => p.status !== "success");
  const winner = plans[0];
  const winnerHarness = winner?.id ?? "(none)";
  const winnerAttemptId =
    args.winnerAttemptId ?? planAttempts.find((p) => p.status === "success")?.attemptId ?? null;
  // final/plan.md is the PURE plan body (the winning planner's / merger's own
  // text): implement freezes and hashes THIS file, so wrapper prose lives in
  // summary.md instead (advisor pass, V6a).
  const planDoc = redactSecrets(winner?.text ?? "(no output)");
  store.writeText(join(paths.finalDir, "plan.md"), planDoc + "\n");
  // Engine-parsed open questions (final/questions.json): the ONE artifact
  // plan readiness derives from. For council this runs on the MERGE output
  // only — draft questions never leak into the final set.
  const parsedQuestions = extractPlanQuestions(planDoc);
  store.writeJson(join(paths.finalDir, "questions.json"), parsedQuestions);
  if (council) store.writeYaml(join(paths.root, "council", "membership.yaml"), council);
  // A plan is a delivered work product (a report), even with risks — parity
  // with the other read-only modes. result_kind=plan tells surfaces NO files
  // changed.
  store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: "report",
    source_task_id: taskId,
    producer_attempt_id: winnerAttemptId,
    meta: {
      mode: "plan",
      result_kind: "plan",
      planners: plans.length,
      diffstat: { files: 0, additions: 0, deletions: 0 },
      blockers: 0,
      adopted: null,
    },
  });
  const readiness = derivePlanReadiness(PlanQuestionsArtifact.parse(parsedQuestions));
  const councilNote = council ? councilDegradationNote(council) : "";
  store.writeText(
    join(paths.finalDir, "summary.md"),
    [
      `# Run ${runId} (plan)`,
      "",
      `- Lifecycle: succeeded (plan only — no files changed)`,
      council
        ? `- Council: merged by ${council.mergedBy ?? "(none)"} from ${council.drafted} of ${council.requested} member(s)`
        : `- Planner: ${winnerHarness}`,
      `- Plan: final/plan.md`,
      `- Open questions: ${readiness.questionCount}${parsedQuestions.parse === "none_found" ? " (no tagged block — unverified)" : ""}`,
      `- Goal: ${redactSecrets(input.prompt).slice(0, 400)}`,
      ...(councilNote ? [`- Council note: ${councilNote}`] : []),
      ...(failedPlanners.length > 0 && !council
        ? [
            `- Fallback omissions: ${failedPlanners.map((p) => `${p.harnessId} ${p.status}`).join(", ")}`,
          ]
        : []),
      "",
    ].join("\n"),
  );
  deps.writeRunTelemetry(
    store,
    paths,
    contract,
    runId,
    taskId,
    "plan",
    args.attemptTelemetries,
    winnerAttemptId,
  );
  log.emit("output.ready", { kind: "plan", path: "final/plan.md" });
  log.emit("plan.questions", {
    parse: parsedQuestions.parse,
    question_count: readiness.questionCount,
    readiness: readiness.state,
  });
  const planFacts = makeOutcomeFacts("succeeded", { noChanges: true });
  log.emit("run.completed", { lifecycle: planFacts.lifecycle, facts: planFacts, reason: null });
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode: "plan",
    lifecycle: planFacts.lifecycle,
    facts: planFacts,
    winner: null,
    runDir: paths.root,
    summary: `${council ? `Council plan (merged by ${winnerHarness})` : `Plan by ${winnerHarness}`}; ${readiness.questionCount} open question(s)${parsedQuestions.parse === "none_found" ? " (untagged plan — unverified)" : ""}.`,
    candidates: planAttempts.map((p) => ({
      attemptId: p.attemptId,
      harnessId: p.harnessId,
      status: p.status,
    })),
  };
}

/** Shared typed-failure tail for a plan run where NO plan body was produced
 * (every planner failed, or the council merge failed). Mirrors the solo
 * plans.length===0 path so both surfaces disclose identically. */
export function writePlanHarnessFailure(
  deps: PlanRunDeps,
  ctx: {
    input: RunInput;
    contract: TaskContract;
    taskId: string;
    runId: string;
    store: ArtifactStore;
    paths: RunPaths;
    log: EventLog;
    ledger: BudgetLedger;
    planAttempts: {
      attemptId: string;
      harnessId: string;
      status: "success" | "failed" | "blocked";
      error: string | null;
    }[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
  },
  fallbackMessage: string,
): OrchestratorResult {
  const { input, contract, taskId, runId, store, paths, log, ledger, planAttempts } = ctx;
  const blocked = planAttempts.some((p) => p.status === "blocked");
  const message =
    planAttempts.map((p) => `${p.attemptId}/${p.harnessId}: ${p.error ?? "failed"}`).join("\n") ||
    fallbackMessage;
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
  store.writeText(join(paths.contextDir, "context_error.md"), `# Harness Error\n\n${message}\n`);
  writeFailure(store, paths, {
    phase: "harness",
    category: blocked ? "policy" : "harness_error",
    safeMessage: message,
    eventRefs: planAttempts.map((p) => `attempts/${p.attemptId}/events.jsonl`),
    runDir: paths.root,
    nextActions: ["Open diagnostics", "Check harness authentication", "Retry after setup"],
  });
  store.writeText(
    join(paths.finalDir, "summary.md"),
    `# Run ${runId} (plan)\n\n- Lifecycle: ${blocked ? "succeeded (needs review)" : "failed"}\n\n${message}\n`,
  );
  log.emit("output.ready", { kind: "summary", path: "final/summary.md", state: "diagnostic" });
  const planFailFacts = blocked
    ? makeOutcomeFacts("succeeded", { review: "blocked", reason: "review_blocked" })
    : makeOutcomeFacts("failed", { reason: "harness_failed" });
  if (blocked)
    log.emit("run.blocked", {
      lifecycle: planFailFacts.lifecycle,
      facts: planFailFacts,
      phase: "harness",
      error: message,
      failure_ref: "final/failure.yaml",
    });
  else
    log.emit("run.failed", {
      lifecycle: planFailFacts.lifecycle,
      facts: planFailFacts,
      reason: planFailFacts.reason,
      phase: "harness",
      error: message,
      failure_ref: "final/failure.yaml",
    });
  void input;
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
