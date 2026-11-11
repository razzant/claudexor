import { describe, expect, it } from "vitest";
import { ReviewerSpendAccumulator } from "./reviewerSpendAccumulator.js";
import type { ReviewerOutput } from "./reviewRuntimeTypes.js";

const output = (allowanceDebitUnobserved?: boolean): ReviewerOutput => ({
  text: "",
  observedSource: "stream_event",
  costUsd: 0,
  costEstimated: false,
  cashUsd: 0,
  valuationUsd: 0,
  unknownUsd: 0,
  cashKnowledge: "exact",
  valuationKnowledge: "unknown",
  ...(allowanceDebitUnobserved === undefined ? {} : { allowanceDebitUnobserved }),
});

describe("reviewer panel spend keeps observed zero amounts (#171)", () => {
  const observed = (cash: boolean, valuation: boolean) => ({ cash, valuation, unknown: false });

  it("takes valuation knowledge only from reviewers that reported a valuation", () => {
    const panel = new ReviewerSpendAccumulator(2);
    panel.record(0, {
      ...output(),
      valuationKnowledge: "estimated",
      observedAmounts: observed(false, true),
    });
    // An API reviewer's valuation is unknown because it never had one.
    panel.record(1, { ...output(), observedAmounts: observed(true, false) });
    expect(panel.summary()).toMatchObject({
      reviewValuationUsd: 0,
      reviewValuationKnowledge: "estimated",
      reviewObservedAmounts: { cash: true, valuation: true, unknown: false },
    });
  });

  it("keeps a failed reviewer's reported zero", () => {
    const panel = new ReviewerSpendAccumulator(1);
    panel.recordPartial(0, {
      partialCostUsd: 0,
      partialCashKnowledge: "exact",
      partialValuationKnowledge: "exact",
      partialObservedAmounts: observed(false, true),
    });
    expect(panel.summary()).toMatchObject({
      reviewValuationKnowledge: "exact",
      reviewObservedAmounts: { cash: false, valuation: true, unknown: false },
    });
  });

  it("states nothing observed for a panel without reported amounts", () => {
    const panel = new ReviewerSpendAccumulator(1);
    panel.record(0, output());
    expect(panel.summary()).toMatchObject({
      reviewValuationKnowledge: "unknown",
      reviewObservedAmounts: { cash: false, valuation: false, unknown: false },
    });
  });
});

describe("reviewer panel spend keeps an unobserved allowance debit", () => {
  it("reports the panel debit unobserved when any finished or partial slot says so", () => {
    const finished = new ReviewerSpendAccumulator(2);
    finished.record(0, output());
    finished.record(1, output(true));
    expect(finished.summary()).toMatchObject({
      reviewCashKnowledge: "exact",
      reviewAllowanceDebitUnobserved: true,
    });
    const partial = new ReviewerSpendAccumulator(2);
    partial.record(0, output(false));
    partial.recordPartial(1, {
      partialCashKnowledge: "exact",
      partialAllowanceDebitUnobserved: true,
    });
    expect(partial.summary().reviewAllowanceDebitUnobserved).toBe(true);
    const ordinary = new ReviewerSpendAccumulator(1);
    ordinary.record(0, output());
    expect(ordinary.summary().reviewAllowanceDebitUnobserved).toBe(false);
  });
});
