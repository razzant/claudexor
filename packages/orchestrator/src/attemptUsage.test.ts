import { describe, expect, it, vi } from "vitest";
import { processAttemptUsage } from "./attemptUsage.js";

const usageEvent = (estimated: boolean) =>
  ({
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.37, estimated },
  }) as const;

describe("processAttemptUsage", () => {
  it("never trips the cash guard for exact or estimated native subscription valuation", () => {
    for (const estimated of [false, true]) {
      const guard = vi.fn(() => true);
      const cancel = vi.fn();
      const result = processAttemptUsage({
        event: usageEvent(estimated),
        authMode: "local_session",
        harnessId: "claude",
        attemptId: "a01",
        cost: 0,
        costEstimated: false,
        budgetGuard: guard,
        cancel,
      });
      expect(result).toMatchObject({
        cost: 0.37,
        costEstimated: estimated,
        hardCapReached: false,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    }
  });

  it("trips the guard and cancels metered API usage", () => {
    const cancel = vi.fn();
    const emitted: string[] = [];
    const result = processAttemptUsage({
      event: usageEvent(false),
      authMode: "api_key",
      harnessId: "claude",
      attemptId: "a01",
      cost: 0,
      costEstimated: false,
      budgetGuard: () => true,
      cancel,
      emit: (type) => emitted.push(type),
    });
    expect(result.hardCapReached).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(emitted).toEqual(["budget.observation", "budget.observation"]);
  });
});
