import { z } from "zod";
import type { RunOutcomeFacts, RunReason } from "./decision.js";

/**
 * THE single status-projection owner (v3 axes, D8/D18): every surface — CLI,
 * control-api, MCP, ACP, macOS — projects run state through these helpers.
 * Nobody re-derives labels, exit codes, stop reasons, terminal sets, or
 * needs-decision from raw fields (INV-134: one presentational owner per
 * fact; codex plan-review finding 7).
 */

/** Job/run lifecycle: how far the PROCESS got. Outcome quality lives on the
 * independent axes in RunOutcomeFacts — "blocked" is not a lifecycle. */
export const RunLifecycle = z
  .enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"])
  .describe(
    "Run lifecycle: queued, running, then exactly one of succeeded / failed / cancelled / interrupted. Outcome quality (checks, review, delivery) is orthogonal.",
  );
export type RunLifecycle = z.infer<typeof RunLifecycle>;

export const TERMINAL_LIFECYCLES: ReadonlySet<RunLifecycle> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const);

export function isTerminalLifecycle(state: string): boolean {
  return TERMINAL_LIFECYCLES.has(state as RunLifecycle);
}

/** Process exit policy: the LIFECYCLE is the exit code. A finished run with
 * open review findings exits 0 — "Done · needs review" is done; whether the
 * result may be APPLIED is applyEligibility's answer, never the exit code. */
export function processExitCode(lifecycle: string): number {
  return lifecycle === "succeeded" ? 0 : 1;
}

/** The D8 user-facing label for a terminal run (English-only, INV-141). */
export function runOutcomeLabel(facts: RunOutcomeFacts): string {
  switch (facts.lifecycle) {
    case "failed":
      return facts.reason ? `Failed (${facts.reason.replaceAll("_", " ")})` : "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "succeeded":
      break;
    default:
      return "Working";
  }
  if (facts.review === "blocked" || facts.checks === "failed") return "Needs review";
  if (facts.review === "not_run" || facts.checks === "not_configured") {
    return "Done · not verified";
  }
  return "Done";
}

/**
 * THE single owner of the continuity disclosure line (INV-137). Every surface
 * — CLI print, macOS turn card, ACP — renders continuity through this helper
 * so the phrasing never diverges. Returns null for the cases with nothing to
 * disclose (a fresh first turn, or a plain in-lane native resume that carried
 * no packet); a lane switch or a hydrated gap always yields a visible line.
 */
export function continuityLabel(disclosure: {
  kind: "native_resume" | "packet" | "fresh";
  packetTurns?: number;
  summarized?: boolean;
  laneSwitchedFrom?: { harness: string; profileId?: string | null } | null;
}): string | null {
  if (disclosure.kind !== "packet") return null;
  const turns = disclosure.packetTurns ?? 0;
  const noun = turns === 1 ? "turn" : "turns";
  let line = `continued with thread context · ${turns} ${noun}`;
  if (disclosure.summarized) line += " (older turns condensed)";
  if (disclosure.laneSwitchedFrom)
    line += ` · switched from ${disclosure.laneSwitchedFrom.harness}`;
  return line;
}

/** True when a terminal run is waiting on a human decision: finished work
 * whose review blocked or checks failed, with no valid operator decision
 * recorded yet. The ONE producer of the needs-me/inbox signal. */
export function needsDecision(facts: RunOutcomeFacts, hasValidOperatorDecision: boolean): boolean {
  return (
    facts.lifecycle === "succeeded" &&
    (facts.review === "blocked" || facts.checks === "failed") &&
    !hasValidOperatorDecision
  );
}

/** ACP stop-reason projection (3-bucket collapse, unchanged semantics). */
export function acpStopReason(lifecycle: string): "cancelled" | "refusal" | "end_turn" {
  if (lifecycle === "cancelled") return "cancelled";
  if (lifecycle === "failed" || lifecycle === "interrupted") return "refusal";
  return "end_turn";
}

/** Build a full RunOutcomeFacts from a lifecycle + optional partial axes,
 * filling the honest defaults (no_changes-neutral, checks not_configured,
 * review not_run, reason null). The ONE constructor used by terminal writers
 * that don't already hold a facts record (executor-forced terminals, budget
 * stops, failure-only terminals). */
export function makeOutcomeFacts(
  lifecycle: RunOutcomeFacts["lifecycle"],
  partial: Partial<Omit<RunOutcomeFacts, "lifecycle">> = {},
): RunOutcomeFacts {
  return {
    lifecycle,
    noChanges: partial.noChanges ?? false,
    checks: partial.checks ?? "not_configured",
    review: partial.review ?? "not_run",
    reason: partial.reason ?? null,
  };
}

/** Coarse RunReason for a run that has NO decision.facts to project (a
 * pre-arbitration failure: plan/readonly/enqueue/harness crash). Keyed on the
 * typed failure category + lifecycle so a surface still shows an honest reason.
 * Runs WITH a decision project decision.facts directly; this is the fallback. */
export function reasonFromFailureCategory(
  lifecycle: RunOutcomeFacts["lifecycle"],
  category: string | null | undefined,
): RunReason | null {
  if (lifecycle === "cancelled") return "user_cancelled";
  if (lifecycle === "interrupted") return "crash_interrupted";
  if (lifecycle !== "failed") return null;
  switch (category) {
    case "budget":
      return "budget_exhausted";
    case "cancelled":
      return "user_cancelled";
    default:
      return "harness_failed";
  }
}

/** Derive RunOutcomeFacts for a decision-less terminal from its typed failure
 * category + lifecycle. summarizeRun uses this ONLY when decision.facts is
 * absent; it lives next to the projection owner so no surface re-derives. */
export function outcomeFactsFromFailure(
  lifecycle: RunOutcomeFacts["lifecycle"],
  category: string | null | undefined,
): RunOutcomeFacts {
  return makeOutcomeFacts(lifecycle, { reason: reasonFromFailureCategory(lifecycle, category) });
}
