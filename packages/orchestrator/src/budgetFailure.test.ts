import { describe, expect, it } from "vitest";
import { type BudgetDenial, classifyBudgetFailure } from "./budgetFailure.js";

const denial = (code: BudgetDenial["code"], harnessId: string | null = "cursor"): BudgetDenial => ({
  code,
  reason: "ledger reason",
  harnessId,
  attemptId: harnessId ? "a01" : null,
});

/** Every budget remediation must name a budget/route control and NEVER auth or
 * setup (the core QA-050 bug: a correct budget refusal recommended
 * authentication). */
const AUTH_WORDS = /auth|authenticat|log ?in|log ?out|sign ?in|setup|credential/i;

describe("classifyBudgetFailure (QA-050 shared budget-denial classifier)", () => {
  it("maps a finite_zero pre-spawn denial to a typed budget failure that names the route and the budget remedy, never auth", () => {
    const m = classifyBudgetFailure({ denial: denial("finite_zero"), terminal: null });
    expect(m.phase).toBe("budget");
    expect(m.category).toBe("budget");
    expect(m.code).toBe("finite_zero");
    expect(m.reason).toBe("budget_exhausted");
    expect(m.harnessId).toBe("cursor");
    expect(m.attemptId).toBe("a01");
    // The refused route is named so the identifiers are not misread as a harness failure.
    expect(m.safeMessage).toContain("cursor");
    expect(m.nextActions.length).toBeGreaterThan(0);
    for (const action of m.nextActions) expect(action).not.toMatch(AUTH_WORDS);
    // Names the actual budget control and warns Exact Retry is doomed.
    expect(m.nextActions.join("\n")).toMatch(/--max-usd|Budget/);
    expect(m.nextActions.join("\n")).toMatch(/Exact Retry/i);
  });

  it("gives each denial code a distinct typed code + non-auth remediation", () => {
    for (const code of [
      "hard_cap",
      "estimate_headroom",
      "unknown_paid_in_flight",
    ] as const) {
      const m = classifyBudgetFailure({ denial: denial(code), terminal: null });
      expect(m.code).toBe(code);
      expect(m.phase).toBe("budget");
      expect(m.reason).toBe("budget_exhausted");
      for (const action of m.nextActions) expect(action).not.toMatch(AUTH_WORDS);
    }
  });

  it("falls back to the settled ledger terminal (overshoot / cost_unverifiable) when there is no captured denial", () => {
    const overshoot = classifyBudgetFailure({ denial: null, terminal: "budget_overshoot" });
    expect(overshoot.code).toBe("budget_overshoot");
    expect(overshoot.reason).toBe("budget_overshoot");
    expect(overshoot.phase).toBe("budget");
    for (const action of overshoot.nextActions) expect(action).not.toMatch(AUTH_WORDS);

    const unverifiable = classifyBudgetFailure({ denial: null, terminal: "cost_unverifiable" });
    expect(unverifiable.code).toBe("cost_unverifiable");
    expect(unverifiable.reason).toBe("cost_unverifiable");

    const exhausted = classifyBudgetFailure({ denial: null, terminal: "budget_exhausted" });
    expect(exhausted.code).toBe("hard_cap");
    expect(exhausted.reason).toBe("budget_exhausted");
  });

  it("keeps a null route when the denial did not name one", () => {
    const m = classifyBudgetFailure({ denial: denial("finite_zero", null), terminal: null });
    expect(m.harnessId).toBeNull();
    expect(m.safeMessage).not.toContain("(null");
  });
});
