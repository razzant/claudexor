import { describe, expect, it } from "vitest";
import { UsageCostTracker, usageAmountKind } from "./usage-evidence.js";
import { BudgetLedger } from "./ledger.js";
import { attemptUsageCostSettlement, reviewUsageCostSettlement } from "./settlements.js";
import type { HarnessEvent, ProcessingCostBasis, ProcessingReceipt } from "@claudexor/schema";

const receipt = (mode: "standard" | "fast"): ProcessingReceipt => ({
  requested: mode,
  submitted: mode,
  submittedNative: mode,
  observed: "unknown",
  observedNative: [],
  reason: null,
  source: "fixture",
});
const basis = (kind: ProcessingCostBasis["kind"]): ProcessingCostBasis => ({
  kind,
  nativeMode: null,
  source: "fixture",
});
function event(
  processing: ProcessingReceipt,
  kind: ProcessingCostBasis["kind"],
  amount?: "cash" | "valuation" | "unknown",
): HarnessEvent {
  return {
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    credential_route: "vendor_native",
    processing,
    processing_cost_basis: basis(kind),
    usage: { cost_usd: 2, ...(amount ? { cost_basis: { kind: amount, source: "fixture" } } : {}) },
  };
}
function observe(tracker: UsageCostTracker, ev: HarnessEvent) {
  tracker.observeEvent("local_session", ev);
  tracker.observeUsage("local_session", ev.usage!.cost_usd!, false, ev);
}

describe("processing-aware usage evidence", () => {
  it("preserves legacy native valuation but never infers premium cash or credit debit from its tariff", () => {
    expect(usageAmountKind("local_session", undefined)).toBe("valuation");
    expect(
      usageAmountKind("local_session", undefined, receipt("fast"), basis("paid_credits")),
    ).toBe("unknown");
    expect(usageAmountKind("api_key", undefined, receipt("fast"), basis("cash"))).toBe("cash");
    expect(
      usageAmountKind(
        "local_session",
        { kind: "valuation", source: "native-list" },
        receipt("fast"),
        basis("paid_credits"),
      ),
    ).toBe("valuation");
  });

  it("treats an omitted native processing control as ordinary included work", () => {
    const omitted: ProcessingReceipt = {
      requested: null,
      submitted: null,
      submittedNative: null,
      observed: "unknown",
      observedNative: [],
      reason: "native_default_unconfirmed",
      source: "fixture",
    };
    expect(usageAmountKind("local_session", undefined, omitted, basis("unknown"))).toBe(
      "valuation",
    );
  });
  it.each(["fast", "mixed"] as const)(
    "does not relabel submitted standard when observed mode is %s",
    (observed) => {
      expect(
        usageAmountKind(
          "local_session",
          undefined,
          {
            ...receipt("standard"),
            observed,
          },
          basis("unknown"),
        ),
      ).toBe("unknown");
    },
  );

  it.each(["valuation", "unknown"] as const)(
    "premium %s amount leaves actual paid consumption unknown at finite settlement",
    (amount) => {
      const tracker = new UsageCostTracker();
      tracker.startAttempt();
      observe(tracker, event(receipt("fast"), "paid_credits", amount));
      tracker.finishAttempt();
      expect(tracker.snapshot().cashKnowledge).toBe("unknown");
      expect(tracker.totals.cashUsd).toBe(0);
      const ledger = new BudgetLedger({ kind: "finite", maxUsd: 3 });
      const lease = ledger.reserve({
        taskId: "t",
        intent: "review",
        harnessId: "claude",
        cost: {
          knowledge: "unknown",
          billing: "metered",
          source: "fixture",
          provenance: ["fixture"],
          estimatedUsd: null,
          processing: basis("paid_credits"),
        },
      }).lease!;
      ledger.settle(
        lease.lease_id,
        reviewUsageCostSettlement(
          tracker.totals.cashUsd,
          tracker.totals.valuationUsd,
          {
            cash: tracker.snapshot().cashKnowledge,
            valuation: tracker.snapshot().valuationKnowledge,
          },
          ["fixture"],
          tracker.totals.unknownUsd,
        ),
      );
      expect(ledger.spend()).toBe(0);
      expect(ledger.terminal()).toBe("cost_unverifiable");
    },
  );

  it("ordinary included billing proves zero cash independently of an unknown scalar amount", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    observe(tracker, event(receipt("standard"), "included", "unknown"));
    tracker.finishAttempt();
    expect(tracker.snapshot()).toEqual({
      cashKnowledge: "exact",
      valuationKnowledge: "unknown",
      allowanceDebitUnobserved: false,
      observedAmounts: { cash: false, valuation: false, unknown: true },
    });
    expect(tracker.totals.unknownUsd).toBe(2);
    expect(tracker.unknownPaidUsd).toBe(0);
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    const lease = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "claude",
      cost: {
        knowledge: "exact",
        billing: "subscription_entitlement",
        source: "fixture",
        provenance: ["fixture"],
        estimatedUsd: null,
      },
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(2, false, "a", "claude", "local_session", {
        ...tracker.totals,
        ...tracker.snapshot(),
      }),
    );
    expect(ledger.spend()).toBe(0);
    expect(ledger.terminal()).toBeNull();
  });

  it("retains an unpriced premium interval across a successful ordinary retry", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("local_session", event(receipt("fast"), "paid_credits"));
    tracker.startAttempt();
    observe(tracker, event(receipt("standard"), "included", "valuation"));
    tracker.finishAttempt();
    expect(tracker.snapshot().cashKnowledge).toBe("unknown");
    expect(tracker.totals.valuationUsd).toBe(2);
  });

  it("does not let an earlier API receipt certify a later premium or mixed interval", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("api_key");
    tracker.observeUsage("api_key", 0.25, false);
    tracker.observeEvent(
      "local_session",
      event({ ...receipt("fast"), observed: "mixed" }, "unknown"),
    );
    tracker.finishAttempt();
    expect(tracker.totals.cashUsd).toBe(0.25);
    expect(tracker.snapshot().cashKnowledge).toBe("unknown");
  });
});

describe("a reported amount is evidence apart from its size (#171)", () => {
  const usage = (cost_usd?: number, estimated?: boolean): HarnessEvent => ({
    type: "usage",
    session_id: "s",
    ts: new Date().toISOString(),
    usage: { ...(cost_usd === undefined ? {} : { cost_usd }), ...(estimated ? { estimated } : {}) },
  });
  function tracked(route: "api_key" | "local_session", ev: HarnessEvent): UsageCostTracker {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent(route, ev);
    if (ev.usage?.cost_usd !== undefined)
      tracker.observeUsage(route, ev.usage.cost_usd, ev.usage.estimated === true, ev);
    tracker.finishAttempt();
    return tracker;
  }
  function settled(tracker: UsageCostTracker) {
    const settlement = attemptUsageCostSettlement(0, false, "a", "h", "api_key", {
      ...tracker.totals,
      ...tracker.snapshot(),
    });
    const ledger = new BudgetLedger();
    const lease = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" }).lease!;
    ledger.settle(lease.lease_id, settlement);
    return { settlement, ledger };
  }

  it("settles a cash zero as present without inventing a valuation", () => {
    const { settlement, ledger } = settled(tracked("api_key", usage(0)));
    expect(settlement.source).toBe("harness-usage-by-route");
    expect(settlement).not.toHaveProperty("valuationKnowledge");
    expect(ledger.cashKnowledge()).toBe("exact");
    expect(ledger.valuationKnowledge()).toBe("unknown");
  });

  it("keeps an estimated cash zero estimated", () => {
    const { settlement, ledger } = settled(tracked("api_key", usage(0, true)));
    expect(settlement).toMatchObject({ source: "harness-usage-by-route", knowledge: "estimated" });
    expect(ledger.cashKnowledge()).toBe("estimated");
    expect(ledger.estimated()).toBe(true);
  });

  it.each([
    [false, "exact"],
    [true, "estimated"],
  ] as const)("reports a zero valuation (estimated=%s) as %s", (estimated, knowledge) => {
    const { settlement, ledger } = settled(tracked("local_session", usage(0, estimated)));
    expect(settlement).toMatchObject({
      source: "harness-usage-by-route",
      valuationUsd: 0,
      valuationKnowledge: knowledge,
      cashKnowledge: "exact",
    });
    expect(ledger.valuation()).toBe(0);
    expect(ledger.valuationKnowledge()).toBe(knowledge);
    expect(ledger.estimated()).toBe(false);
  });

  it("never reads known cash or component knowledge as a receipt", () => {
    // Ordinary included work: known zero controllable cash, nothing reported.
    const included = tracked("local_session", usage());
    expect(included.snapshot()).toMatchObject({
      cashKnowledge: "exact",
      observedAmounts: { cash: false, valuation: false, unknown: false },
    });
    expect(settled(included).settlement.source).toBe("harness-route-usage-missing");
    // A caller-built split that states knowledge but no observation stays missing.
    expect(
      attemptUsageCostSettlement(0, false, "a", "h", "api_key", {
        cashUsd: 0,
        valuationUsd: 0,
        unknownUsd: 0,
        cashKnowledge: "exact",
        valuationKnowledge: "exact",
      }),
    ).toMatchObject({ source: "harness-route-usage-missing" });
    expect(
      attemptUsageCostSettlement(0, false, "a", "h", "api_key", {
        cashUsd: 0,
        valuationUsd: 0,
        unknownUsd: 0,
        cashKnowledge: "exact",
        valuationKnowledge: "exact",
      }),
    ).not.toHaveProperty("valuationUsd");
    expect(
      reviewUsageCostSettlement(0, 0, { cash: "exact", valuation: "exact" }, ["review:panel"]),
    ).toMatchObject({ source: "review-usage-missing" });
  });

  it("does not let a zero receipt certify an earlier unpriced paid interval", () => {
    const tracker = new UsageCostTracker();
    tracker.startAttempt();
    tracker.observeEvent("api_key");
    tracker.startAttempt();
    tracker.observeEvent("api_key");
    tracker.observeUsage("api_key", 0, false);
    tracker.finishAttempt();
    expect(tracker.snapshot()).toMatchObject({
      cashKnowledge: "unknown",
      observedAmounts: { cash: true, valuation: false, unknown: false },
    });
    const { settlement, ledger } = settled(tracker);
    expect(settlement).toMatchObject({
      source: "harness-usage-by-route",
      cashKnowledge: "unknown",
    });
    expect(ledger.cashKnowledge()).toBe("unknown");
  });

  it("settles a panel's observed zero amounts as review usage", () => {
    const ledger = new BudgetLedger();
    const lease = ledger.reserve({ taskId: "t", intent: "review", harnessId: "panel" }).lease!;
    const settlement = reviewUsageCostSettlement(
      0,
      0,
      {
        cash: "exact",
        valuation: "estimated",
        observedAmounts: { cash: true, valuation: true, unknown: false },
      },
      ["review:panel"],
    );
    expect(settlement).toMatchObject({
      source: "review-usage",
      knowledge: "estimated",
      cashKnowledge: "exact",
      valuationKnowledge: "estimated",
      valuationUsd: 0,
    });
    ledger.settle(lease.lease_id, settlement);
    expect(ledger.valuationKnowledge()).toBe("estimated");
    expect(ledger.cashKnowledge()).toBe("exact");
  });
});
