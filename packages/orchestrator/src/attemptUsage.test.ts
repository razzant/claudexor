import { describe, expect, it, vi } from "vitest";
import { processAttemptUsage } from "./attemptUsage.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";

const usageEvent = (estimated: boolean) =>
  ({
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.37, estimated },
  }) as const;

describe("processAttemptUsage", () => {
  it("splits usage by each event route when a retry changes auth", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "vendor_native",
      usage: { cost_usd: 0.75 },
    });
    observeAttemptTelemetry(telemetry, {
      ...usageEvent(false),
      credential_route: "managed_api_key",
      usage: { cost_usd: 0.25 },
    });
    expect(telemetry.authMode).toBe("local_session");
    expect(telemetry.currentAuthMode).toBe("api_key");
    expect(telemetry.usageCost).toEqual({
      cashUsd: 0.25,
      valuationUsd: 0.75,
      unknownUsd: 0,
    });
  });

  it("never trips the cash guard for exact or estimated native subscription valuation", () => {
    for (const estimated of [false, true]) {
      const guard = vi.fn(() => true);
      const cancel = vi.fn();
      const result = processAttemptUsage({
        event: usageEvent(estimated),
        telemetry: {
          usageCost: { cashUsd: 0, valuationUsd: 0.37, unknownUsd: 0 },
        },
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
      telemetry: {
        usageCost: { cashUsd: 0.37, valuationUsd: 0, unknownUsd: 0 },
      },
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
