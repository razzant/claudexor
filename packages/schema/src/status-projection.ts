import { z } from "zod";
import type { RunApplyState } from "./control.js";
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
 * result may be APPLIED is applyEligibility's answer, never the exit code.
 *
 * This is the CONTRACT for callers that only hold a lifecycle string (streamed
 * status polls). It is deliberately unchanged: the D-16 work_state veto is a
 * separate, additive projection (`outcomeExitCode`) that consults the full
 * outcome facts, so a needs_input/incomplete run exits non-zero WITHOUT this
 * function learning about work_state (INV-116 — lifecycle stays succeeded). */
export function processExitCode(lifecycle: string): number {
  return lifecycle === "succeeded" ? 0 : 1;
}

/** D-16: true when a run's work_state VETOES a clean exit — the model attested
 * it needs input or its work is incomplete. Orthogonal to lifecycle (INV-116):
 * the process succeeded, but the WORK did not, so applyability and the CLI exit
 * must reflect that. `unverified`/`completed`/absent never veto. */
export function workStateVetoes(facts: RunOutcomeFacts | null | undefined): boolean {
  const state = facts?.work_state?.state;
  return state === "needs_input" || state === "incomplete";
}

/**
 * D-16 outcome-aware CLI exit projection (BESIDE processExitCode, not a change
 * to it). The exit follows the OUTCOME, not the bare lifecycle: a succeeded
 * lifecycle whose work_state vetoes (needs_input/incomplete) exits non-zero,
 * so a "clean process, unfinished work" run cannot read as success at the shell.
 * Every other case defers to processExitCode(lifecycle). */
export function outcomeExitCode(facts: RunOutcomeFacts | null | undefined): number {
  if (!facts) return 1; // not terminal / unknown — never a clean 0
  if (facts.lifecycle === "succeeded" && workStateVetoes(facts)) return 1;
  return processExitCode(facts.lifecycle);
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
  // D-16 work_state veto (INV-116): the process succeeded but the model attested
  // the WORK is unfinished — surfaced ABOVE review/checks so a needs_input run
  // never reads as "Done · not verified". Locators (when named) ride the label.
  if (facts.work_state?.state === "needs_input") return needsInputLabel(facts);
  if (facts.work_state?.state === "incomplete") return "Incomplete";
  if (facts.review === "blocked" || facts.checks === "failed") return "Needs review";
  if (facts.review === "not_run" || facts.checks === "not_configured") {
    return "Done · not verified";
  }
  return "Done";
}

/** "Needs input" with up to two named locators appended for honest disclosure
 * (INV-141 English-only). Unnameable inputs collapse to the bare label. */
function needsInputLabel(facts: RunOutcomeFacts): string {
  const locators = (facts.work_state?.required_inputs ?? [])
    .map((r) => r.locator)
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .slice(0, 2);
  return locators.length > 0 ? `Needs input: ${locators.join(", ")}` : "Needs input";
}

/**
 * THE single owner of the server-owned OUTCOME BANNER (D18): the one honest
 * headline a surface shows above any model prose, so free-text from the harness
 * can never outrank the arbitrated truth. It folds the terminal outcome quality
 * (runOutcomeLabel) together with the delivery/apply state (RunApplyState) into
 * one line — e.g. "Candidate ready — NOT APPLIED", "Applied", "Needs review".
 *
 * The delivery suffix ("— NOT APPLIED") is only appended when there is actually
 * something to apply (`hasApplyableChange` — an unapplied patch candidate);
 * answer/plan/report runs carry no apply affordance, so their banner is the
 * outcome quality alone. Null while the run is not terminal (no honest headline
 * yet). Every surface — CLI print, control-api ControlRunDetail, macOS Outcome
 * tab — renders THIS, never its own.
 */
export function outcomeBanner(
  facts: RunOutcomeFacts | null,
  delivery: { applyState: RunApplyState; hasApplyableChange: boolean },
): string | null {
  if (!facts) return null; // not terminal — no honest headline yet
  if (facts.lifecycle !== "succeeded") return runOutcomeLabel(facts);
  switch (delivery.applyState) {
    case "applied":
      return "Applied";
    case "applied_review_blocked":
      return "Applied · review blocked";
    case "reverted":
      return "Reverted — changes rolled back";
    case "not_applied":
      break;
  }
  // D-16 work_state veto wins the banner over review/checks/apply quality: an
  // unfinished-work run is never presented as an applyable candidate.
  const vetoLabel =
    facts.work_state?.state === "needs_input"
      ? needsInputLabel(facts)
      : facts.work_state?.state === "incomplete"
        ? "Incomplete"
        : null;
  if (vetoLabel) return delivery.hasApplyableChange ? `${vetoLabel} — NOT APPLIED` : vetoLabel;
  const needsReview = facts.review === "blocked" || facts.checks === "failed";
  const unverified = facts.review === "not_run" || facts.checks === "not_configured";
  // Nothing to apply (answer / plan / report / no changes): the quality alone.
  if (!delivery.hasApplyableChange) {
    if (needsReview) return "Needs review";
    if (unverified) return "Done · not verified";
    return "Done";
  }
  // A patch candidate exists but has NOT been applied — always disclose that.
  if (needsReview) return "Needs review — NOT APPLIED";
  if (unverified) return "Candidate ready · not verified — NOT APPLIED";
  return "Candidate ready — NOT APPLIED";
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
    (facts.review === "blocked" || facts.checks === "failed" || workStateVetoes(facts)) &&
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
    ...(partial.work_state ? { work_state: partial.work_state } : {}),
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
