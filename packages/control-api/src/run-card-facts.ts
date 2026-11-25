import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  RunFailure,
  isTerminalLifecycle,
  outcomeFactsFromFailure,
  type ControlRunDetail,
  type DecisionRecord,
  type RunFacts,
  type RunOutcomeFacts,
  type WorkState,
  type RunTelemetry,
  type ControlRouteInfo,
} from "@claudexor/schema";
import type { DaemonRunRecord } from "./run-record.js";
import { safeReadStructuredArtifact } from "./run-artifact-read.js";
export function readFailure(rec: DaemonRunRecord, maxBytes?: number): RunFailure | null {
  const fromArtifact = safeReadStructuredArtifact(rec, "final/failure.yaml", RunFailure, maxBytes);
  if (fromArtifact) return fromArtifact;
  if (!rec.error) return null;
  // A job its deadline ended before any run (queued, or preparing its thread
  // worktree) never produced artifacts. It keeps the failure shape an earlier
  // client reads: category and phase, code null. A reader built before the code
  // drops the whole RunFailure on a member it does not know. The cause travels in
  // outcomeFacts.reason (legacyRunOutcomeFacts) and the job's recorded problem.
  const deadlineExpired = rec.errorCode === "run_deadline_expired";
  return RunFailure.parse({
    category: deadlineExpired ? "cancelled" : "unknown",
    ...(deadlineExpired ? { phase: rec.startedAt ? "preparing" : "queued" } : {}),
    safeMessage: rec.error,
    runDir: rec.runDir ?? null,
  });
}

export function strategyFromParams(
  p: Record<string, unknown>,
): "race" | "attempts" | "until_clean" | "deep_scan" | "create" | null {
  if (p["untilClean"] === true) return "until_clean";
  if (typeof p["attempts"] === "number" && p["attempts"] > 0) return "attempts";
  if (p["create"] === true) return "create";
  if (p["deepScan"] === true) return "deep_scan";
  if (typeof p["n"] === "number" && p["n"] > 1) return "race";
  return null;
}

export function legacyRunOutcomeFacts(
  rec: DaemonRunRecord,
  decision: DecisionRecord | null,
  failure: RunFailure | null,
  workState: WorkState | null = null,
): RunOutcomeFacts | null {
  if (!isTerminalLifecycle(rec.state)) return null;
  // Arbitrated runs already carry work_state on decision.facts (INV-116).
  if (decision) return decision.facts;
  const lifecycle = rec.state as RunOutcomeFacts["lifecycle"];
  // A job its deadline ended before any run keeps that cause on the card, read
  // from the daemon's own record (its failure carries no code); a manual or
  // legacy cancellation with no recorded cause keeps the generic fallback.
  const base =
    lifecycle === "cancelled" && rec.errorCode === "run_deadline_expired"
      ? {
          ...outcomeFactsFromFailure(lifecycle, failure?.category),
          reason: "run_deadline_expired" as const,
        }
      : outcomeFactsFromFailure(lifecycle, failure?.category);
  if (!workState || lifecycle !== "succeeded") return base;
  const vetoed = workState.state === "needs_input" || workState.state === "incomplete";
  return {
    ...base,
    work_state: workState,
    ...(vetoed
      ? {
          reason:
            base.reason ??
            (workState.state === "needs_input" ? "input_required" : "work_incomplete"),
        }
      : {}),
  };
}

/** The typed fact holders of a run answer: a summary row, a run detail, a history run. */
interface RunFactHolder {
  outcomeFacts?: RunOutcomeFacts | null;
  failure?: RunFailure | null;
  runFacts?: RunFacts | null;
  decision?: DecisionRecord | null;
}

const engineStop = (facts: RunOutcomeFacts): RunOutcomeFacts =>
  facts.reason === "run_deadline_expired" ? { ...facts, reason: "host_cancelled" } : facts;

/**
 * run-deadline/1 facts of one run answer, as its HTTP reader reads them
 * (`readsRunDeadline`: `X-Claudexor-Capabilities: 1` on that request). An opted-in
 * reader gets every fact as recorded. A client built before run-deadline/1 parses
 * `RunOutcomeFacts.reason` and `RunFailure.code` as closed sets and drops the whole
 * outcome or failure on the new member; for it a deadline's stop reads as the engine's
 * (`host_cancelled`, never Stop's `user_cancelled` or maxSeconds' `wall_clock_exceeded`)
 * and that failure code as untyped. Only these typed fields change: stored records, the
 * human `outcomeBanner` and the deadline record (`GET /v2/runs/:id/deadline`, `expired`)
 * keep the exact cause for every reader.
 */
export function runFactsForReader<T extends RunFactHolder>(run: T, readsRunDeadline: boolean): T {
  if (readsRunDeadline) return run;
  return {
    ...run,
    ...(run.outcomeFacts ? { outcomeFacts: engineStop(run.outcomeFacts) } : {}),
    ...(run.failure?.code === "run_deadline_expired"
      ? { failure: { ...run.failure, code: null } }
      : {}),
    ...(run.runFacts
      ? { runFacts: { ...run.runFacts, outcome: engineStop(run.runFacts.outcome) } }
      : {}),
    ...(run.decision
      ? { decision: { ...run.decision, facts: engineStop(run.decision.facts) } }
      : {}),
  };
}

/** A run detail with its summary and children, as its reader reads them (`runFactsForReader`). */
export function detailForReader(
  detail: ControlRunDetail,
  readsRunDeadline: boolean,
): ControlRunDetail {
  if (readsRunDeadline) return detail;
  return {
    ...runFactsForReader(detail, false),
    summary: runFactsForReader(detail.summary, false),
    children: detail.children.map((child) => runFactsForReader(child, false)),
  };
}

export function planProjectionFor(
  rec: DaemonRunRecord,
  mode: string | null | undefined,
  maxBytes?: number,
) {
  const empty = { readiness: null, questions: [] };
  if (mode !== "plan" || !rec.runDir) return empty;
  const a = safeReadStructuredArtifact(
    rec,
    "final/questions.json",
    PlanQuestionsArtifact,
    maxBytes,
  );
  return a ? { readiness: derivePlanReadiness(a), questions: a.questions } : empty;
}

/** Project the recorded auth receipt identically on detail and history. */
export function projectAuthRoute(telemetry: RunTelemetry | null) {
  return telemetry?.auth_route
    ? {
        requested: telemetry.auth_route.requested,
        effective: telemetry.auth_route.effective,
        source: telemetry.auth_route.source,
        reason: telemetry.auth_route.reason,
        harnessId: telemetry.auth_route.harness_id,
        attemptId: telemetry.auth_route.attempt_id,
        profileId: telemetry.auth_route.profile_id,
        modelMismatch: telemetry.auth_route.model_mismatch,
      }
    : null;
}

/**
 * Run-level route evidence: observed model comes ONLY from telemetry (the
 * harness stream's own disclosure); the requested model from run params.
 * `verified` is never inferred from the request alone.
 */
export function controlRoute(
  telemetry: RunTelemetry | null,
  p: Record<string, unknown>,
): ControlRouteInfo | null {
  if (!telemetry) return null;
  const finalAttempt = telemetry.final_attempt_id
    ? telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    : undefined;
  const observed =
    finalAttempt?.observed_model ??
    telemetry.attempts.find((a) => a.observed_model)?.observed_model ??
    null;
  const harnessId =
    finalAttempt?.harness_id ??
    telemetry.attempts.find((a) => a.observed_model)?.harness_id ??
    null;
  return {
    // Scalar-only by design until per-candidate route evidence lands:
    // map-only pool members show requestedModel null here, honestly.
    requestedModel: typeof p["model"] === "string" ? p["model"] : null,
    observedModel: observed,
    harnessId,
    verified: observed !== null,
  };
}
