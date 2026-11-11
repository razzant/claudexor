import { describe, expect, it } from "vitest";
import { DecisionRecord, makeOutcomeFacts } from "@claudexor/schema";
import { inspectBudgetLine } from "./run-detail-projections.js";

const line = (budget_summary: Record<string, unknown>) =>
  inspectBudgetLine(
    DecisionRecord.parse({ winner: "a01", facts: makeOutcomeFacts("succeeded"), budget_summary })
      .budget_summary,
  );

describe("inspect budget line", () => {
  it("never prints an unobserved subscription debit as spend=0", () => {
    // The decision shape the producer writes for Codex subscription work
    // (decisionBudget.test.ts, codex-exact-retry-processing.integration.test.ts).
    expect(
      line({ spend_usd: null, cash_usd: null, controllable_cash_usd: 0, estimated: true }),
    ).toBe("budget: spend=unknown controllable=0");
    expect(
      line({ spend_usd: null, cash_usd: null, controllable_cash_usd: 0.25, estimated: true }),
    ).toBe("budget: spend=unknown controllable=0.25");
  });

  it("keeps known, estimated, wholly unknown and legacy decisions unchanged", () => {
    expect(
      line({ spend_usd: 0.25, cash_usd: 0.25, controllable_cash_usd: 0.25, estimated: false }),
    ).toBe("budget: spend=0.25");
    expect(line({ spend_usd: 0.25, cash_usd: 0.25, estimated: true })).toBe(
      "budget: spend=0.25 estimated",
    );
    expect(
      line({ spend_usd: null, cash_usd: null, controllable_cash_usd: null, estimated: true }),
    ).toBe("budget: spend=unknown estimated");
    expect(line({ spend_usd: 0, cash_usd: 0, estimated: false })).toBe("budget: spend=0");
  });
});
