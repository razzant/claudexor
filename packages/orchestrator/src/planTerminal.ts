import { makeOutcomeFacts, type RunOutcomeFacts } from "@claudexor/schema";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import type { EventLog } from "@claudexor/event-log";
import type { AttemptTelemetry } from "./attemptTelemetry.js";
import { writeFailure } from "./runTerminals.js";

/**
 * D-16 plan terminal facts (extracted from planRun.ts so the plan finalizer does
 * not absorb the work_state fold — complexity ratchet). The plan finalizer
 * previously ALWAYS emitted a clean succeeded and ignored the winning planner /
 * merge attempt's model-attested work_state; a capable route that reported
 * needs_input / incomplete or exhausted its context then read as done and exited
 * 0. This folds the WINNER's telemetry (selected by winnerAttemptId) into the
 * terminal facts — parity with the read-only report path (INV-116).
 */
export interface PlanTerminalFacts {
  planFacts: RunOutcomeFacts;
  planVetoed: boolean;
  /** The summary.md lifecycle bullet, honest about a veto/interruption. */
  lifecycleLine: string;
  /** The plan-result summary suffix disclosing a veto/interruption ("" when clean). */
  summarySuffix: string;
}

/** Select the winner's telemetry by winnerAttemptId and fold its work_state into
 * the plan terminal facts. A terminal context exhaustion with no completed report
 * ⇒ interrupted; a needs_input/incomplete report ⇒ a succeeded lifecycle whose
 * work_state vetoes applyability and a clean exit; a completed/absent report ⇒ the
 * clean plan terminal. A plan changes no files, so noChanges stays true. */
export function resolvePlanTerminalFacts(
  attemptTelemetries: { attemptId: string; telemetry: AttemptTelemetry }[],
  winnerAttemptId: string | null,
): PlanTerminalFacts {
  const winnerTelemetry = attemptTelemetries.find(
    (t) => t.attemptId === winnerAttemptId,
  )?.telemetry;
  const winnerWorkState = winnerTelemetry?.outcome?.workState;
  const planFacts =
    winnerTelemetry?.contextExhausted && winnerWorkState?.state !== "completed"
      ? makeOutcomeFacts("interrupted", { reason: "context_capacity_exhausted", noChanges: true })
      : winnerWorkState?.state === "needs_input" || winnerWorkState?.state === "incomplete"
        ? makeOutcomeFacts("succeeded", {
            noChanges: true,
            reason: winnerWorkState.state === "needs_input" ? "input_required" : "work_incomplete",
            work_state: winnerWorkState,
          })
        : winnerWorkState
          ? makeOutcomeFacts("succeeded", { noChanges: true, work_state: winnerWorkState })
          : makeOutcomeFacts("succeeded", { noChanges: true });
  const planVetoed =
    planFacts.work_state?.state === "needs_input" || planFacts.work_state?.state === "incomplete";
  const lifecycleLine =
    planFacts.lifecycle === "interrupted"
      ? "- Lifecycle: interrupted (context exhausted — partial plan)"
      : planVetoed
        ? `- Lifecycle: succeeded, ${planFacts.work_state?.state === "needs_input" ? "needs input" : "incomplete"} (plan only — no files changed)`
        : "- Lifecycle: succeeded (plan only — no files changed)";
  const summarySuffix = planVetoed
    ? ` — ${planFacts.work_state?.state === "needs_input" ? "needs input" : "incomplete"}`
    : planFacts.lifecycle === "interrupted"
      ? " — interrupted (context exhausted)"
      : "";
  return { planFacts, planVetoed, lifecycleLine, summarySuffix };
}

/** Emit the D-16 plan terminal event keyed on the folded facts (mirrors the
 * read-only report path): an interrupted context exhaustion is run.failed; a
 * work_state veto is run.blocked (a needs-me terminal whose outcome-aware exit is
 * non-zero); an otherwise-clean plan is run.completed. */
export function emitPlanTerminal(
  store: ArtifactStore,
  paths: RunPaths,
  log: EventLog,
  facts: RunOutcomeFacts,
  planVetoed: boolean,
): void {
  if (facts.lifecycle !== "succeeded") {
    writeFailure(store, paths, {
      phase: "harness",
      category: "harness_error",
      safeMessage: `plan ended ${facts.lifecycle}${facts.reason ? ` (${facts.reason.replaceAll("_", " ")})` : ""}`,
      runDir: paths.root,
      nextActions: ["Inspect the partial plan", "Re-run with a narrower scope"],
    });
    log.emit("run.failed", {
      lifecycle: facts.lifecycle,
      facts,
      reason: facts.reason,
      phase: "harness",
      failure_ref: "final/failure.yaml",
    });
  } else if (planVetoed) {
    log.emit("run.blocked", { lifecycle: facts.lifecycle, facts, reason: facts.reason });
  } else {
    log.emit("run.completed", { lifecycle: facts.lifecycle, facts, reason: null });
  }
}
