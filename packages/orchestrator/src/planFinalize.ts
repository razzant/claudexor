import { join } from "node:path";
import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  type ActiveTaskContract,
  type CouncilProjection,
} from "@claudexor/schema";
import { newId } from "@claudexor/util";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { BudgetLedger } from "@claudexor/budget";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import type { OrchestratorResult, RunInput } from "./orchestrator.js";
import type { plannerAttemptSummary } from "./plannerAttempt.js";
import type { PlanRunDeps } from "./planRun.js";
import { extractPlanQuestions } from "./planQuestions.js";
import { emitPlanTerminal, resolvePlanTerminalFacts } from "./planTerminal.js";
import { councilDegradationNote } from "./council.js";

type PlanAttemptSummary = ReturnType<typeof plannerAttemptSummary>;

/** Write final plan artifacts (plan.md, questions.json, work_product, summary,
 * telemetry) and the terminal event, then return the result. ONE owner for both
 * the solo and council success tails so the artifacts are shape-identical. */
export function finalizePlanRun(
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
    plans: { id: string; text: string }[];
    planAttempts: PlanAttemptSummary[];
    attemptTelemetries: { attemptId: string; harnessId: string; telemetry: AttemptTelemetry }[];
    winnerAttemptId?: string | null;
    council: CouncilProjection | null;
    councilUnverifiedInputs?: number;
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
  // final/plan.md is the PURE plan body (implement freezes+hashes it; V6a).
  const planDoc = winner?.text ?? "(no output)";
  store.writeText(join(paths.finalDir, "plan.md"), planDoc + "\n");
  // Engine-parsed open questions (final/questions.json): the ONE artifact plan
  // readiness derives from. For council this runs on the MERGE output only.
  const parsedQuestions = extractPlanQuestions(planDoc);
  store.writeJson(join(paths.finalDir, "questions.json"), parsedQuestions);
  if (council) store.writeYaml(join(paths.root, "council", "membership.yaml"), council);
  // A plan is a delivered work product (a report); result_kind=plan tells
  // surfaces NO files changed.
  store.writeYaml(join(paths.finalDir, "work_product.yaml"), {
    id: newId("wp"),
    kind: "report",
    source_task_id: taskId,
    producer_attempt_id: winnerAttemptId,
    meta: {
      mode: "plan",
      result_kind: "plan",
      planners: council?.members.length ?? plans.length,
      diffstat: { files: 0, additions: 0, deletions: 0 },
      blockers: 0,
      adopted: null,
    },
  });
  const readiness = derivePlanReadiness(PlanQuestionsArtifact.parse(parsedQuestions));
  const councilNote = council ? councilDegradationNote(council) : "";
  const councilInputs = `${council?.drafted ?? 0} contract-accepted draft(s), ${args.councilUnverifiedInputs ?? 0} unverified draft(s)`;
  // D-16: fold the WINNING attempt's work_state into the plan terminal (INV-116; see planTerminal.ts).
  const { planFacts, planVetoed, lifecycleLine, summarySuffix } = resolvePlanTerminalFacts(
    args.attemptTelemetries,
    winnerAttemptId,
  );
  store.writeText(
    join(paths.finalDir, "summary.md"),
    [
      `# Run ${runId} (plan)`,
      "",
      lifecycleLine,
      council
        ? `- Council: merged by ${council.mergedBy ?? "(none)"}; inputs: ${councilInputs}; ${council.requested} member(s) requested`
        : `- Planner: ${winnerHarness}`,
      `- Plan: final/plan.md`,
      `- Open questions: ${readiness.questionCount}${parsedQuestions.parse === "none_found" ? " (no tagged block — unverified)" : ""}`,
      `- Goal: ${input.prompt.slice(0, 400)}`,
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
  // D-16 terminal disclosure keyed on the folded facts (see planTerminal.ts).
  emitPlanTerminal(store, paths, log, planFacts, planVetoed);
  return {
    spendUsd: ledger.spend(),
    runId,
    taskId,
    mode: "plan",
    lifecycle: planFacts.lifecycle,
    facts: planFacts,
    winner: null,
    runDir: paths.root,
    summary: `${council ? `Council plan (merged by ${winnerHarness}; ${councilInputs})` : `Plan by ${winnerHarness}`}; ${readiness.questionCount} open question(s)${parsedQuestions.parse === "none_found" ? " (untagged plan — unverified)" : ""}${summarySuffix}.`,
    candidates: planAttempts.map((p) => ({
      attemptId: p.attemptId,
      harnessId: p.harnessId,
      status: p.status,
    })),
  };
}
