import { describe, expect, it, vi } from "vitest";
import type {
  CostEvidence,
  HarnessEvent,
  PaidBudget,
  ProcessingCostBasis,
  ProcessingReceipt,
} from "@claudexor/schema";
import { BudgetLedger } from "./ledger.js";
import { attemptUsageCostSettlement, reviewUsageCostSettlement } from "./settlements.js";
import { UsageCostTracker } from "./usage-evidence.js";

const receipt = (mode: "standard" | "fast", native = mode === "fast" ? "priority" : "default") =>
  ({
    requested: mode,
    submitted: mode,
    submittedNative: native,
    observed: "unknown",
    observedNative: [],
    reason: null,
    source: "codex.service_tier",
  }) satisfies ProcessingReceipt;
const allowance = (kind: ProcessingCostBasis["kind"] = "included"): ProcessingCostBasis => ({
  nativeMode: "priority",
  kind,
  source: "codex_subscription_service_allowance",
  debit: "unobserved",
});
const entitlement: CostEvidence = {
  knowledge: "exact",
  billing: "subscription_entitlement",
  source: "fixture",
  provenance: ["fixture"],
  estimatedUsd: null,
};
const metered: CostEvidence = { ...entitlement, knowledge: "unknown", billing: "metered" };

function event(
  processing: ProcessingReceipt,
  basis: ProcessingCostBasis | undefined,
  usage?: HarnessEvent["usage"],
): HarnessEvent {
  return {
    type: usage ? "usage" : "message",
    session_id: "s",
    ts: new Date().toISOString(),
    credential_route: "vendor_native",
    processing,
    ...(basis ? { processing_cost_basis: basis } : {}),
    ...(usage ? { usage } : {}),
  };
}

function observeNative(tracker: UsageCostTracker, ev: HarnessEvent) {
  tracker.observeEvent("local_session", ev);
  if (ev.usage?.cost_usd !== undefined)
    tracker.observeUsage("local_session", ev.usage.cost_usd, false, ev);
}

function settleOnce(budget: PaidBudget, tracker: UsageCostTracker, cost = entitlement) {
  const onCashSettled = vi.fn();
  const ledger = new BudgetLedger(budget, undefined, { onCashSettled });
  const lease = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "codex", cost });
  expect(lease.granted).toBe(true);
  ledger.settle(
    lease.lease!.lease_id,
    attemptUsageCostSettlement(0, false, "a01", "codex", "local_session", {
      ...tracker.totals,
      ...tracker.snapshot(),
    }),
  );
  return { ledger, onCashSettled };
}

describe("included allowance whose route reports no debit", () => {
  it.each([
    { budget: { kind: "finite", maxUsd: 0 } as const, mode: "standard" as const },
    { budget: { kind: "finite", maxUsd: 0 } as const, mode: "fast" as const },
    { budget: { kind: "finite", maxUsd: 5 } as const, mode: "fast" as const },
    { budget: { kind: "unlimited" } as const, mode: "standard" as const },
  ])(
    "completes $mode under $budget.kind cap $budget.maxUsd with reported cash unknown",
    ({ budget, mode }) => {
      for (const usage of [
        undefined,
        { input_tokens: 100, output_tokens: 10 },
        { cost_usd: 0.02, cost_basis: { kind: "valuation" as const, source: "fixture.list" } },
      ]) {
        const tracker = new UsageCostTracker();
        tracker.startAttempt();
        observeNative(tracker, event(receipt(mode), allowance(), usage));
        tracker.finishAttempt();
        expect(tracker.snapshot()).toMatchObject({
          cashKnowledge: "exact",
          allowanceDebitUnobserved: true,
        });
        const { ledger, onCashSettled } = settleOnce(budget, tracker);
        expect(ledger.terminal()).toBeNull();
        expect(ledger.spend()).toBe(0);
        expect(ledger.cashKnowledge()).toBe("unknown");
        expect(ledger.estimated()).toBe(true);
        // Reported total unknown; cap-governed cash exact.
        expect(onCashSettled).toHaveBeenLastCalledWith(
          0,
          usage?.cost_usd ?? 0,
          true,
          expect.any(String),
          "unknown",
          "exact",
        );
      }
    },
  );

  it.each([0, 0.02])("treats an actual %s cash receipt as an observed debit", (usd) => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    observeNative(
      tracker,
      event(receipt("fast"), allowance(), {
        cost_usd: usd,
        cost_basis: { kind: "cash", source: "fixture.debit" },
      }),
    );
    tracker.finishAttempt();
    expect(tracker.snapshot()).toMatchObject({
      cashKnowledge: "exact",
      allowanceDebitUnobserved: false,
    });
    const { ledger, onCashSettled } = settleOnce({ kind: "unlimited" }, tracker);
    expect(ledger.spend()).toBe(usd);
    expect(ledger.cashKnowledge()).toBe("exact");
    expect(onCashSettled).toHaveBeenLastCalledWith(usd, 0, false, "unknown", "exact", "exact");
  });

  it("keeps an earlier paid interval without a receipt unverifiable under a finite cap", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("api_key", {});
    observeNative(tracker, event(receipt("standard"), allowance()));
    tracker.finishAttempt();
    expect(tracker.snapshot()).toMatchObject({
      cashKnowledge: "unknown",
      allowanceDebitUnobserved: true,
    });
    const { ledger } = settleOnce({ kind: "finite", maxUsd: 5 }, tracker);
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it.each(["unknown", "paid_credits", "valuation"] as const)(
    "does not whitelist a %s premium basis that also reports no debit",
    (kind) => {
      const tracker = new UsageCostTracker();
      tracker.startAttempt();
      observeNative(tracker, event(receipt("fast", "ultrafast"), allowance(kind)));
      tracker.finishAttempt();
      expect(tracker.snapshot()).toMatchObject({
        cashKnowledge: "unknown",
        allowanceDebitUnobserved: false,
      });
      expect(settleOnce({ kind: "finite", maxUsd: 5 }, tracker).ledger.terminal()).toBe(
        "cost_unverifiable",
      );
    },
  );

  it("keeps an included route without the debit fact on the exact-zero convention", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    observeNative(tracker, event(receipt("standard"), { ...allowance(), debit: undefined }));
    tracker.finishAttempt();
    expect(tracker.snapshot()).toMatchObject({
      cashKnowledge: "exact",
      allowanceDebitUnobserved: false,
    });
    expect(settleOnce({ kind: "finite", maxUsd: 0 }, tracker).ledger.cashKnowledge()).toBe("exact");
  });

  it("keeps an unrouted interval and unknown API cash unverifiable", () => {
    const unrouted = new UsageCostTracker();
    unrouted.startAttempt();
    unrouted.observeEvent(null, event(receipt("standard"), allowance()));
    unrouted.finishAttempt();
    expect(unrouted.snapshot().cashKnowledge).toBe("unknown");
    const api = new UsageCostTracker();
    api.startAttempt();
    api.observeEvent("api_key", {
      processing_cost_basis: { ...allowance("cash"), debit: undefined },
    });
    api.finishAttempt();
    expect(api.snapshot().cashKnowledge).toBe("unknown");
    for (const tracker of [unrouted, api])
      expect(settleOnce({ kind: "finite", maxUsd: 5 }, tracker, metered).ledger.terminal()).toBe(
        "cost_unverifiable",
      );
  });

  it("still enforces known API cash beside an unobserved allowance in the same family", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const native = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: entitlement,
    }).lease!;
    ledger.settle(native.lease_id, {
      knowledge: "exact",
      cashKnowledge: "exact",
      cashUsd: 0,
      allowanceDebitUnobserved: true,
      source: "fixture",
      provenance: ["fixture"],
    });
    expect(ledger.remainingUsd()).toBe(1);
    const paid = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "api",
      cost: { ...metered, knowledge: "estimated", estimatedUsd: 0.1 },
    }).lease!;
    ledger.settle(paid.lease_id, {
      knowledge: "exact",
      cashKnowledge: "exact",
      cashUsd: 1.5,
      source: "fixture",
      provenance: ["fixture"],
    });
    expect(ledger.cashKnowledge()).toBe("unknown");
    expect(ledger.terminal()).toBe("budget_overshoot");
  });

  it("reports a reviewer allowance as unknown without failing the finite cap", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const lease = ledger.reserve({
      taskId: "t",
      intent: "review",
      harnessId: "review-panel",
      cost: entitlement,
    }).lease!;
    ledger.settle(
      lease.lease_id,
      reviewUsageCostSettlement(
        0,
        0,
        { cash: "exact", valuation: "unknown", allowanceDebitUnobserved: true },
        ["review:panel"],
      ),
    );
    expect(ledger.terminal()).toBeNull();
    expect(ledger.cashKnowledge()).toBe("unknown");
  });
});
