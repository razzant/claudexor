import { describe, expect, it } from "vitest";
import { budgetValuation, foldBudgetEvents } from "./budget-valuation.js";

const budgetValuationFromEvents = (events: Record<string, unknown>[]) =>
  budgetValuation(foldBudgetEvents(events));
const cashKnowledgeFromEvents = (events: Record<string, unknown>[]) =>
  foldBudgetEvents(events).cashKnowledge;

describe("cash certainty projection", () => {
  it("distinguishes an unknown zero from an estimated zero without consulting valuation", () => {
    const event = (cash_knowledge: string) => ({
      type: "budget.cash",
      payload: { cash_spend_usd: 0, estimated: true, valuation_usd: 4, cash_knowledge },
    });
    expect(cashKnowledgeFromEvents([event("estimated")])).toBe("estimated");
    expect(cashKnowledgeFromEvents([event("estimated"), event("unknown")])).toBe("unknown");
    expect(
      cashKnowledgeFromEvents([
        { type: "budget.cash", payload: { cash_spend_usd: 0, estimated: true } },
      ]),
    ).toBeUndefined();
  });
});

// QA-023c / QA-017b: the budget snapshot projected only CASH. A native-
// subscription run settles cash to exactly $0 while its token VALUATION lives on
// budget.cash.valuation_usd — a machine reader saw "$0" and could believe the
// work was free. Valuation must project beside cash: a KNOWN valuation appears,
// an UNKNOWN one stays null (never a fabricated $0).
describe("budgetValuationFromEvents (QA-023c)", () => {
  it("projects a known subscription valuation (last-wins) beside exact $0 cash", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.022058, estimated: true } },
      { type: "budget.cash", payload: { cash_spend_usd: 0, valuation_usd: 0 } },
      { type: "budget.cash", payload: { cash_spend_usd: 0, valuation_usd: 0.022058 } },
    ]);
    expect(v.valuationUsd).toBeCloseTo(0.022058, 6);
    expect(v.valuationKnowledge).toBe("estimated");
  });

  it("preserves exact valuation knowledge independently from cash certainty", () => {
    const v = budgetValuationFromEvents([
      {
        type: "budget.cash",
        payload: {
          cash_spend_usd: 0,
          valuation_usd: 0.37,
          estimated: false,
          valuation_knowledge: "exact",
        },
      },
    ]);
    expect(v).toEqual({ valuationUsd: 0.37, valuationKnowledge: "exact" });
  });

  it("does not turn an explicit unknown ledger valuation into a displayable zero", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.5 } },
      {
        type: "budget.cash",
        payload: {
          cash_spend_usd: 0.25,
          valuation_usd: 0,
          estimated: false,
          valuation_knowledge: "unknown",
        },
      },
    ]);
    expect(v).toEqual({ valuationUsd: null, valuationKnowledge: "unknown" });
  });

  it("leaves valuation UNKNOWN (null) when no usage was ever reported — never a fake $0", () => {
    const v = budgetValuationFromEvents([
      { type: "run.created", payload: {} },
      { type: "harness.completed", payload: { status: "success" } },
    ]);
    expect(v.valuationUsd).toBeNull();
    expect(v.valuationKnowledge).toBe("unknown");
  });

  it.each([
    [false, "exact"],
    [true, "estimated"],
  ] as const)(
    "knows a reported valuation zero (estimated=%s) only once its settlement states it",
    (estimated, knowledge) => {
      const row = {
        type: "budget.observation",
        payload: { kind: "spend", usd: 0, estimated, amount_kind: "valuation" },
      };
      expect(budgetValuationFromEvents([row])).toEqual({
        valuationUsd: null,
        valuationKnowledge: "unknown",
      });
      expect(
        budgetValuationFromEvents([
          row,
          {
            type: "budget.cash",
            payload: {
              cash_spend_usd: 0,
              valuation_usd: 0,
              estimated: false,
              valuation_knowledge: knowledge,
            },
          },
        ]),
      ).toEqual({ valuationUsd: 0, valuationKnowledge: knowledge });
    },
  );

  it.each(["cash", "valuation", "unknown", undefined])(
    "never reads a %s zero spend row as a valuation",
    (amount_kind) => {
      expect(
        budgetValuationFromEvents([
          {
            type: "budget.observation",
            payload: { kind: "spend", usd: 0, ...(amount_kind ? { amount_kind } : {}) },
          },
        ]),
      ).toEqual({ valuationUsd: null, valuationKnowledge: "unknown" });
    },
  );

  it("still reads a positive spend row as the legacy estimated valuation", () => {
    expect(
      budgetValuationFromEvents([
        {
          type: "budget.observation",
          payload: { kind: "spend", usd: 0, amount_kind: "valuation" },
        },
        { type: "budget.observation", payload: { kind: "spend", usd: 0.5, amount_kind: "cash" } },
      ]),
    ).toEqual({ valuationUsd: 0.5, valuationKnowledge: "estimated" });
  });

  it("falls back to summed budget.observation for runs predating budget.cash", () => {
    const v = budgetValuationFromEvents([
      { type: "budget.observation", payload: { kind: "spend", usd: 0.01 } },
      { type: "budget.observation", payload: { kind: "spend", usd: 0.02 } },
    ]);
    expect(v.valuationUsd).toBeCloseTo(0.03, 6);
    expect(v.valuationKnowledge).toBe("estimated");
  });
});
