import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  RunFailure,
  isTerminalLifecycle,
  outcomeFactsFromFailure,
  type DecisionRecord,
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
  return RunFailure.parse({
    category: "unknown",
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
  const base = outcomeFactsFromFailure(lifecycle, failure?.category);
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
