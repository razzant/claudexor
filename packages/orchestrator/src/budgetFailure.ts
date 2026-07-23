/**
 * ONE engine-owned budget-denial classifier (QA-050). Before this, every mode
 * pipeline (ask / agent / deep-scan / plan / council) collapsed the budget
 * ledger's TYPED denial into a boolean and then re-invented its own phase,
 * category, terminal reason, and next-actions — several of them wrongly
 * emitting a harness auth/setup template for a correct budget refusal.
 *
 * The budget ledger (`packages/budget`) already produces the typed denial
 * (`ReserveResult.denied`) and terminal (`BudgetLedger.terminal()`). This
 * module is the single place that maps that typed truth onto the user-facing
 * `RunFailure` (phase, category, machine `code`, safe copy, and remediation).
 * Authentication/setup guidance NEVER appears here — a budget refusal is
 * corrected by changing the budget or the route, not by re-authenticating.
 */
import type { RunFailureCode } from "@claudexor/schema";
import type { BudgetTerminal } from "@claudexor/budget";

/** The typed lease-denial the ledger produces, captured at the denial site with
 * the route/slot it refused so the terminal can name them instead of null. */
export interface BudgetDenial {
  /** `ReserveResult.denied` — the ledger's typed reason. */
  code: "hard_cap" | "estimate_headroom" | "finite_zero" | "unknown_paid_in_flight";
  /** The ledger's human reason string (already safe; carried for the summary). */
  reason: string;
  /** The route (harness) that was refused BEFORE it could start. */
  harnessId: string | null;
  /** The attempt slot the refused lease belonged to. */
  attemptId: string | null;
}

/** The `writeFailure` argument object for a budget mapping — one builder so the
 * five mode terminals do not each re-spell the phase/category/code/route/actions
 * mapping inline (keeps the orchestrator god-file from absorbing it). */
export function budgetFailureRecord(
  mapping: BudgetFailureMapping,
  opts: { eventRefs?: string[]; runDir?: string } = {},
): {
  phase: string;
  category: string;
  code: RunFailureCode;
  harnessId: string | null;
  attemptId: string | null;
  safeMessage: string;
  nextActions: string[];
  eventRefs?: string[];
  runDir?: string;
} {
  return {
    phase: mapping.phase,
    category: mapping.category,
    code: mapping.code,
    harnessId: mapping.harnessId,
    attemptId: mapping.attemptId,
    safeMessage: mapping.safeMessage,
    nextActions: mapping.nextActions,
    ...(opts.eventRefs ? { eventRefs: opts.eventRefs } : {}),
    ...(opts.runDir ? { runDir: opts.runDir } : {}),
  };
}

/** What the shared mapper produces: a fully-typed budget `RunFailure` shape plus
 * the terminal run reason, ready for `writeFailure` and the terminal event. */
export interface BudgetFailureMapping {
  phase: "budget";
  category: "budget";
  code: RunFailureCode;
  /** The typed run outcome reason (a `RunReason` value). */
  reason: "budget_exhausted" | "budget_overshoot" | "cost_unverifiable";
  harnessId: string | null;
  attemptId: string | null;
  safeMessage: string;
  nextActions: string[];
}

/** Remediation copy per typed denial/terminal. Names the budget setting or the
 * route evidence to change; never auth/setup. `--max-usd` is the CLI control and
 * "Budget" is the composer control (both surfaced without inventing a dollar
 * amount), and Exact Retry is explicitly demoted because it replays the
 * immutable cap. */
function budgetNextActions(code: RunFailureCode): string[] {
  switch (code) {
    case "finite_zero":
      return [
        "Raise or remove the per-run budget cap (--max-usd, or the composer Budget control)",
        "Or select a route whose billing evidence is preflight-proven zero or subscription-entitled",
        "Do not use Exact Retry unchanged: it preserves the $0 cap and will be refused again",
      ];
    case "hard_cap":
      return [
        "Raise the per-run budget cap (--max-usd, or the composer Budget control), or start a narrower/lower-cost run",
        "Inspect settled spend and headroom in the run report",
        "Exact Retry preserves the same cap; change the budget before retrying",
      ];
    case "estimate_headroom":
      return [
        "Raise the budget above the quoted estimate (--max-usd, or the composer Budget control)",
        "Or use a cheaper model/route or reduce the requested width",
        "Exact Retry preserves the same cap; change the budget before retrying",
      ];
    case "unknown_paid_in_flight":
      return [
        "Wait for the in-flight paid unit to settle, or use a route with preflight-proven cost",
        "Or raise the budget so a bounded estimate can reserve concurrently",
      ];
    case "budget_overshoot":
      return [
        "Inspect the settled spend in the run report",
        "Raise the next run's budget cap (--max-usd) or reduce its scope/cost",
      ];
    case "cost_unverifiable":
      return [
        "Choose a route with verifiable cost evidence",
        "Or relax the finite budget cap explicitly (--max-usd) to admit unverifiable-cost work",
      ];
  }
}

const DENIAL_MESSAGE: Record<BudgetDenial["code"], string> = {
  finite_zero:
    "the run did not start: its explicit maximum cash budget is $0 and the selected route was not preflight-proven free",
  hard_cap: "the run stopped: the paid budget cap was reached before this work could start",
  estimate_headroom:
    "the run stopped: the estimated cost of this work exceeds the remaining budget headroom",
  unknown_paid_in_flight:
    "the run did not start this route: one unknown-cost paid unit is already in flight under the finite cap",
};

const TERMINAL_MESSAGE: Record<Exclude<BudgetTerminal, null>, string> = {
  budget_exhausted: "the run stopped: the paid budget was exhausted",
  budget_overshoot: "the run stopped: settled spend exceeded the paid budget cap",
  cost_unverifiable:
    "the run stopped: a route's incremental cost could not be verified under the finite cap",
};

/**
 * Classify a budget failure into the shared typed `RunFailure` shape. Prefer the
 * captured pre-spawn DENIAL (it carries the refused route/slot and the precise
 * ledger sub-code); otherwise fall back to the settled ledger TERMINAL. The
 * caller passes whichever it has — a pre-spawn refusal has a denial, a mid-flight
 * overshoot has only a terminal.
 */
export function classifyBudgetFailure(input: {
  denial: BudgetDenial | null;
  terminal: BudgetTerminal;
}): BudgetFailureMapping {
  const { denial, terminal } = input;
  if (denial) {
    // A pre-spawn denial: finite_zero/hard_cap/estimate_headroom/unknown_paid_in_flight
    // all terminate the run as budget_exhausted (nothing was overspent — the
    // gate refused before spend). budget_overshoot/cost_unverifiable are
    // settlement facts and only reach here via the terminal branch below.
    return {
      phase: "budget",
      category: "budget",
      code: denial.code,
      reason: "budget_exhausted",
      harnessId: denial.harnessId,
      attemptId: denial.attemptId,
      safeMessage:
        denial.harnessId !== null
          ? `${DENIAL_MESSAGE[denial.code]} (${denial.harnessId} was selected but did not start)`
          : DENIAL_MESSAGE[denial.code],
      nextActions: budgetNextActions(denial.code),
    };
  }
  const t: Exclude<BudgetTerminal, null> = terminal ?? "budget_exhausted";
  const code: RunFailureCode =
    t === "budget_overshoot"
      ? "budget_overshoot"
      : t === "cost_unverifiable"
        ? "cost_unverifiable"
        : "hard_cap";
  return {
    phase: "budget",
    category: "budget",
    code,
    reason: t,
    harnessId: null,
    attemptId: null,
    safeMessage: TERMINAL_MESSAGE[t],
    nextActions: budgetNextActions(code),
  };
}
