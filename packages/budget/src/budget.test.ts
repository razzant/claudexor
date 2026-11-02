import { describe, expect, it, vi } from "vitest";
import {
  BudgetLedger,
  promptFingerprint,
  quotaConstraintAppliesToModel,
  routeCostEvidence,
} from "./ledger.js";
import { observationsFromEvent } from "./observe.js";
import {
  attemptUsageCostSettlement,
  isSubscriptionValuation,
  reviewUsageCostSettlement,
} from "./settlements.js";
import {
  RoutingPreflightError,
  type RouterCandidate,
  billingKnowledgeForAuthRoute,
  explainRanking,
  rankHarnesses,
  selectHarness,
} from "./router.js";

describe("BudgetLedger", () => {
  const metered = (estimatedUsd: number | null = null) =>
    routeCostEvidence({
      billing: "metered",
      knowledge: estimatedUsd === null ? "unknown" : "estimated",
      source: "test-pricing",
      provenance: ["fixture:budget"],
      estimatedUsd,
    });
  const exactSettlement = (cashUsd: number) => ({
    knowledge: "exact" as const,
    source: "test-usage",
    provenance: ["fixture:usage"],
    cashUsd,
  });

  it("escalates circuit tiers with spend; hard cap denies reservation", () => {
    const led = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const r1 = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(),
    });
    expect(r1.granted).toBe(true);
    expect(r1.tier).toBe("ok");
    led.settle(r1.lease?.lease_id ?? "", exactSettlement(0.8));
    expect(led.tier()).toBe("soft");
    const r2 = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(),
    });
    led.settle(r2.lease?.lease_id ?? "", exactSettlement(0.15));
    expect(led.tier()).toBe("downgrade");
    const r3 = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(),
    });
    led.settle(r3.lease?.lease_id ?? "", exactSettlement(0.1));
    expect(led.tier()).toBe("hard");
    expect(led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" }).granted).toBe(
      false,
    );
  });

  it("settle fails loudly on an unknown lease and never double-counts a re-settle", () => {
    const led = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    expect(() => led.settle("lease-never-granted", exactSettlement(0.5))).toThrow(/unknown lease/);
    const r = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(),
    });
    led.settle(r.lease?.lease_id ?? "", exactSettlement(0.4));
    led.settle(r.lease?.lease_id ?? "", exactSettlement(0.4));
    expect(led.spend()).toBeCloseTo(0.4, 8);
  });

  it("distinguishes explicit unlimited from finite zero", () => {
    const unlimited = new BudgetLedger({ kind: "unlimited" });
    expect(unlimited.reserve({ taskId: "t", intent: "implement", harnessId: "paid" }).granted).toBe(
      true,
    );

    const zero = new BudgetLedger({ kind: "finite", maxUsd: 0 });
    expect(
      zero.reserve({ taskId: "t", intent: "implement", harnessId: "paid", cost: metered() }),
    ).toMatchObject({
      granted: false,
      denied: "finite_zero",
    });
    const entitled = zero.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "subscription",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "estimated",
        source: "entitlement-receipt",
        provenance: ["receipt:subscription"],
        estimatedUsd: 3,
      }),
    });
    expect(entitled.granted).toBe(true);
    zero.settle(entitled.lease?.lease_id ?? "", {
      knowledge: "estimated",
      source: "token-valuation",
      provenance: ["usage:tokens"],
      cashUsd: 3,
    });
    expect(zero.spend()).toBe(0);
    expect(zero.valuation()).toBe(3);
  });

  it("discloses CUMULATIVE cash after every settle — subscription work discloses 0 (W4.3)", () => {
    // The ledger is the one owner of the cash fact: consumers (run events →
    // UI) render what it discloses and never infer money from route labels.
    const disclosed: Array<{
      cash: number;
      valuation: number;
      cashEstimated: boolean;
      valuationKnowledge: "exact" | "estimated" | "unknown";
    }> = [];
    const led = new BudgetLedger({ kind: "unlimited" }, undefined, {
      onCashSettled: (cash, valuation, cashEstimated, valuationKnowledge) =>
        disclosed.push({ cash, valuation, cashEstimated, valuationKnowledge }),
    });
    const entitled = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "subscription",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "estimated",
        source: "entitlement-receipt",
        provenance: ["receipt:subscription"],
        estimatedUsd: 3,
      }),
    });
    led.settle(entitled.lease!.lease_id, {
      knowledge: "estimated",
      source: "token-valuation",
      provenance: ["usage:tokens"],
      cashUsd: 3,
    });
    // Vendor priced the subscription work at $3 — the CASH fact is still $0.
    expect(disclosed).toEqual([
      { cash: 0, valuation: 3, cashEstimated: false, valuationKnowledge: "estimated" },
    ]);
    expect(led.estimated()).toBe(false);
    expect(led.valuationKnowledge()).toBe("estimated");

    const paid = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "paid",
      cost: metered(0.5),
    });
    led.settle(paid.lease!.lease_id, exactSettlement(0.4));
    // Cumulative, not per-settle: the second disclosure carries the total.
    expect(disclosed).toEqual([
      { cash: 0, valuation: 3, cashEstimated: false, valuationKnowledge: "estimated" },
      { cash: 0.4, valuation: 3, cashEstimated: false, valuationKnowledge: "estimated" },
    ]);
  });

  it("settles all native token costs as valuation while API-key costs remain cash", async () => {
    expect(isSubscriptionValuation("local_session")).toBe(true);
    expect(isSubscriptionValuation("api_key")).toBe(false);
    expect(isSubscriptionValuation(null)).toBe(false);
    const native = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const nativeLease = native.reserve({
      taskId: "native-task",
      attemptId: "native-attempt",
      intent: "implement",
      harnessId: "codex",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "exact",
        source: "native-route",
        provenance: ["route:local_session"],
        estimatedUsd: 0,
      }),
    });
    native.settle(
      nativeLease.lease!.lease_id,
      attemptUsageCostSettlement(0.25, true, "native-attempt", "codex", "local_session"),
    );
    expect(native.spend()).toBe(0);
    expect(native.valuation()).toBe(0.25);
    expect(native.estimated()).toBe(false);
    expect(native.valuationKnowledge()).toBe("estimated");
    expect(native.terminal()).toBeNull();

    const nativeExact = new BudgetLedger({ kind: "unlimited" });
    const nativeExactLease = nativeExact.reserve({
      taskId: "native-exact-task",
      attemptId: "native-exact-attempt",
      intent: "implement",
      harnessId: "claude",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "exact",
        source: "native-route",
        provenance: ["route:local_session"],
        estimatedUsd: 0,
      }),
    });
    nativeExact.settle(
      nativeExactLease.lease!.lease_id,
      attemptUsageCostSettlement(0.37, false, "native-exact-attempt", "claude", "local_session"),
    );
    expect(nativeExact.spend()).toBe(0);
    expect(nativeExact.valuation()).toBe(0.37);
    expect(nativeExact.estimated()).toBe(false);
    expect(nativeExact.valuationKnowledge()).toBe("exact");
    expect(nativeExact.terminal()).toBeNull();

    const api = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const apiLease = api.reserve({
      taskId: "api-task",
      attemptId: "api-attempt",
      intent: "implement",
      harnessId: "codex",
      cost: routeCostEvidence({
        billing: "metered",
        knowledge: "estimated",
        source: "route-preflight",
        provenance: ["route:api_key"],
        estimatedUsd: 0.1,
      }),
    });
    api.settle(
      apiLease.lease!.lease_id,
      attemptUsageCostSettlement(0.25, true, "api-attempt", "codex", "api_key"),
    );
    expect(api.spend()).toBe(0.25);
    expect(api.valuation()).toBe(0);
    expect(api.estimated()).toBe(true);
    expect(api.valuationKnowledge()).toBe("unknown");
    expect(api.terminal()).toBeNull();
  });

  it("settles mixed reviewer routes as separated cash and valuation", async () => {
    const ledger = new BudgetLedger({ kind: "unlimited" });
    const lease = ledger.reserve({
      taskId: "review-task",
      attemptId: "review-panel",
      intent: "review",
      harnessId: "review-panel",
    });
    ledger.settle(
      lease.lease!.lease_id,
      reviewUsageCostSettlement(0.25, 0.75, { cash: "exact", valuation: "estimated" }, [
        "review:panel",
      ]),
    );
    expect(ledger.spend()).toBe(0.25);
    expect(ledger.valuation()).toBe(0.75);
  });

  it("keeps subscription-only review cash exact and API-only valuation unknown", async () => {
    const subscription = new BudgetLedger({ kind: "unlimited" });
    const subscriptionLease = subscription.reserve({
      taskId: "subscription-review",
      intent: "review",
      harnessId: "review-panel",
    }).lease!;
    subscription.settle(
      subscriptionLease.lease_id,
      reviewUsageCostSettlement(0, 0.75, { cash: "exact", valuation: "estimated" }, [
        "review:subscription",
      ]),
    );
    expect(subscription.spend()).toBe(0);
    expect(subscription.estimated()).toBe(false);
    expect(subscription.valuation()).toBe(0.75);
    expect(subscription.valuationKnowledge()).toBe("estimated");

    const api = new BudgetLedger({ kind: "unlimited" });
    const apiLease = api.reserve({
      taskId: "api-review",
      intent: "review",
      harnessId: "review-panel",
    }).lease!;
    api.settle(
      apiLease.lease_id,
      reviewUsageCostSettlement(0.25, 0, { cash: "exact", valuation: "unknown" }, ["review:api"]),
    );
    expect(api.spend()).toBe(0.25);
    expect(api.estimated()).toBe(false);
    expect(api.valuation()).toBe(0);
    expect(api.valuationKnowledge()).toBe("unknown");
  });

  it("fails a finite review closed when a paid route reports no cash usage", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const lease = ledger.reserve({
      taskId: "missing-paid-review-usage",
      intent: "review",
      harnessId: "review-panel",
    }).lease!;
    ledger.settle(
      lease.lease_id,
      reviewUsageCostSettlement(0, 0, { cash: "unknown", valuation: "unknown" }, [
        "review:api-without-usage",
      ]),
    );

    expect(ledger.spend()).toBe(0);
    expect(ledger.estimated()).toBe(true);
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it("keeps mixed-route cash exact when only the subscription valuation is estimated", async () => {
    const ledger = new BudgetLedger({ kind: "unlimited" });
    const lease = ledger.reserve({
      taskId: "mixed-task",
      attemptId: "mixed-attempt",
      intent: "implement",
      harnessId: "claude",
      cost: routeCostEvidence({
        // The attempt started native, then retried through an API key. Actual
        // per-route settlement must override the native reservation for cash.
        billing: "subscription_entitlement",
        knowledge: "estimated",
        source: "route-preflight",
        provenance: ["route:local_session"],
        estimatedUsd: 0,
      }),
    }).lease!;
    ledger.settle(
      lease.lease_id,
      attemptUsageCostSettlement(1, true, "mixed-attempt", "claude", "local_session", {
        cashUsd: 0.25,
        valuationUsd: 0.75,
        unknownUsd: 0,
        cashEstimated: false,
        valuationEstimated: true,
      }),
    );

    expect(ledger.spend()).toBe(0.25);
    expect(ledger.valuation()).toBe(0.75);
    expect(ledger.estimated()).toBe(false);
    expect(ledger.valuationKnowledge()).toBe("estimated");
  });

  it("counts in-flight holds against the cap (mid-flight enforcement, #9)", () => {
    const led = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const r = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(0.2),
    });
    expect(r.granted).toBe(true);
    // Streamed cost raises the hold; the tier sees it BEFORE settlement.
    led.updateHold(r.lease?.lease_id ?? "", 0.95);
    expect(led.tier()).toBe("downgrade");
    led.updateHold(r.lease?.lease_id ?? "", 1.2);
    expect(led.tier()).toBe("hard");
    // updateHold never lowers a hold.
    led.updateHold(r.lease?.lease_id ?? "", 0.1);
    expect(led.tier()).toBe("hard");
    // Settling replaces the hold with the actual spend (no double count).
    led.settle(r.lease?.lease_id ?? "", exactSettlement(0.5));
    expect(led.spend()).toBeCloseTo(0.5, 8);
    expect(led.tier()).toBe("ok");
  });

  it("counts an in-attempt API fallback hold even when the lease began on subscription", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.2 });
    const lease = ledger.reserve({
      taskId: "mixed-hold",
      intent: "implement",
      harnessId: "claude",
      cost: routeCostEvidence({
        billing: "subscription_entitlement",
        knowledge: "exact",
        source: "native-route",
        provenance: ["route:local_session"],
        estimatedUsd: 0,
      }),
    }).lease!;

    // The orchestrator calls updateHold only for streamed API/unknown usage;
    // native valuation never reaches this method.
    ledger.updateHold(lease.lease_id, 0.25);
    expect(ledger.tier()).toBe("hard");
    expect(ledger.remainingUsd()).toBe(0);
  });

  it("permits at most one unknown-cost paid unit in flight under a finite cap", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const first = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "one",
      cost: metered(),
    });
    const second = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "two",
      cost: metered(),
    });
    expect(first.granted).toBe(true);
    expect(second).toMatchObject({ granted: false, denied: "unknown_paid_in_flight" });
    ledger.settle(first.lease?.lease_id ?? "", {
      knowledge: "unknown",
      source: "missing-usage",
      provenance: ["attempt:one"],
    });
    expect(ledger.terminal()).toBe("cost_unverifiable");
  });

  it("shares holds and unknown-paid exclusion across task-scoped child views", async () => {
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const childA = root.scopedToTask("child-a");
    const childB = root.scopedToTask("child-b");
    const [first, second] = await Promise.all([
      Promise.resolve().then(() =>
        childA.reserve({
          taskId: "child-a",
          intent: "implement",
          harnessId: "a",
          cost: metered(0.6),
        }),
      ),
      Promise.resolve().then(() =>
        childB.reserve({
          taskId: "child-b",
          intent: "implement",
          harnessId: "b",
          cost: metered(0.6),
        }),
      ),
    ]);
    expect([first.granted, second.granted].filter(Boolean)).toHaveLength(1);
    expect([first, second].find((result) => !result.granted)).toMatchObject({
      denied: "estimate_headroom",
    });

    const finiteUnknown = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const unknownA = finiteUnknown.scopedToTask("unknown-a").reserve({
      taskId: "unknown-a",
      intent: "implement",
      harnessId: "a",
      cost: metered(),
    });
    const unknownB = finiteUnknown.scopedToTask("unknown-b").reserve({
      taskId: "unknown-b",
      intent: "implement",
      harnessId: "b",
      cost: metered(),
    });
    expect(unknownA.granted).toBe(true);
    expect(unknownB).toMatchObject({ granted: false, denied: "unknown_paid_in_flight" });
  });

  it("reports aggregate root totals and task-local child totals/callbacks", () => {
    const rootEvents: Array<[number, number]> = [];
    const childAEvents: Array<[number, number]> = [];
    const childBEvents: Array<[number, number]> = [];
    const root = new BudgetLedger({ kind: "unlimited" }, undefined, {
      onCashSettled: (cash, valuation) => rootEvents.push([cash, valuation]),
    });
    const childA = root.scopedToTask("child-a", (cash, valuation) =>
      childAEvents.push([cash, valuation]),
    );
    const childB = root.scopedToTask("child-b", (cash, valuation) =>
      childBEvents.push([cash, valuation]),
    );
    const leaseA = childA.reserve({
      taskId: "child-a",
      intent: "implement",
      harnessId: "a",
      cost: metered(0.2),
    });
    const leaseB = childB.reserve({
      taskId: "child-b",
      intent: "implement",
      harnessId: "b",
      cost: metered(0.3),
    });
    childA.settle(leaseA.lease!.lease_id, {
      ...exactSettlement(0.2),
      valuationUsd: 0.4,
    });
    childB.settle(leaseB.lease!.lease_id, {
      ...exactSettlement(0.3),
      valuationUsd: 0.6,
    });
    expect(root.spend()).toBeCloseTo(0.5, 8);
    expect(root.valuation()).toBeCloseTo(1, 8);
    expect(childA.spend()).toBeCloseTo(0.2, 8);
    expect(childA.valuation()).toBeCloseTo(0.4, 8);
    expect(childB.spend()).toBeCloseTo(0.3, 8);
    expect(childB.valuation()).toBeCloseTo(0.6, 8);
    expect(rootEvents).toEqual([
      [0.2, 0.4],
      [0.5, 1],
    ]);
    expect(childAEvents).toEqual([[0.2, 0.4]]);
    expect(childBEvents).toEqual([[0.3, 0.6]]);
  });

  it("keeps non-financial signals local and fences scoped lease mutation", () => {
    const root = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const childA = root.scopedToTask("child-a");
    const childB = root.scopedToTask("child-b");
    const lease = childA.reserve({
      taskId: "child-a",
      intent: "implement",
      harnessId: "a",
      cost: metered(0.2),
    });
    expect(() => childB.cancel(lease.lease!.lease_id)).toThrow(
      /budget task scope child-b cannot act for child-a/,
    );
    expect(() =>
      childA.reserve({ taskId: "child-b", intent: "implement", harnessId: "b" }),
    ).toThrow(/budget task scope child-a cannot act for child-b/);

    const fp = promptFingerprint("same prompt");
    childA.recordPrompt(fp);
    expect(childA.isLoop(fp, 1)).toBe(true);
    expect(childB.isLoop(fp, 1)).toBe(false);
    childA.observe({
      harness_id: "a",
      ts: new Date().toISOString(),
      quality: "native",
      kind: "rate_limited",
    });
    expect(childA.observationsFor("a")).toHaveLength(1);
    expect(childB.observationsFor("a")).toHaveLength(0);

    childA.releaseTask();
    expect(root.remainingUsd()).toBe(1);
    expect(() =>
      childA.reserve({ taskId: "child-a", intent: "implement", harnessId: "a" }),
    ).toThrow(/scope is released/);
  });

  it("records late exact overshoot and blocks the next paid unit", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.1 });
    const lease = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(0.05),
    });
    ledger.settle(lease.lease?.lease_id ?? "", exactSettlement(0.12));
    expect(ledger.terminal()).toBe("budget_overshoot");
    expect(
      ledger.reserve({ taskId: "t", intent: "implement", harnessId: "next", cost: metered() })
        .granted,
    ).toBe(false);
  });

  it("detects prompt loops by fingerprint", () => {
    const led = new BudgetLedger();
    const fp = promptFingerprint("Fix   the bug\n");
    expect(promptFingerprint("fix the bug")).toBe(fp);
    led.recordPrompt(fp);
    led.recordPrompt(fp);
    expect(led.isLoop(fp)).toBe(false);
    led.recordPrompt(fp);
    expect(led.isLoop(fp)).toBe(true);
  });
});

function cand(id: string, over: Partial<RouterCandidate> = {}): RouterCandidate {
  return {
    harnessId: id,
    available: true,
    model: `${id}-model`,
    effort: "high",
    billingKnowledge: "unknown",
    ...over,
  };
}

const routeContext = (ledger: BudgetLedger, goal: "auto" | "quality" | "economy") => ({
  goal,
  paidFallback: "allowed_within_cap" as const,
  intent: "implement" as const,
  qualityTiers: {
    implement: [
      [{ harness: "claude", model: "claude-model", effort: "high" as const }],
      [{ harness: "codex", model: "codex-model", effort: "high" as const }],
    ],
  },
  ledger,
});

describe("router", () => {
  it("quality uses only exact user-declared tiers", () => {
    const led = new BudgetLedger();
    const best = selectHarness([cand("codex"), cand("claude")], routeContext(led, "quality"));
    expect(best?.harnessId).toBe("claude");
    expect(() => selectHarness([cand("other")], routeContext(led, "quality"))).toThrow(
      RoutingPreflightError,
    );
  });

  it("returns null when nothing is available", () => {
    const led = new BudgetLedger();
    expect(selectHarness([cand("x", { available: false })], routeContext(led, "auto"))).toBeNull();
  });

  it("economy minimizes incremental paid spend and never assumes native means free", () => {
    const led = new BudgetLedger();
    const best = selectHarness(
      [
        cand("native", { billingKnowledge: "unknown", incrementalCostUsd: null }),
        cand("sub", { billingKnowledge: "subscription_entitlement", incrementalCostUsd: 0 }),
      ],
      routeContext(led, "economy"),
    );
    expect(best?.harnessId).toBe("sub");
  });

  it("auto spends the route with the larger positive expiring-quota slack", () => {
    const led = new BudgetLedger();
    const reset = new Date(Date.now() + 9_000_000).toISOString();
    for (const [harness_id, used_ratio] of [
      ["codex", 0.1],
      ["claude", 0.45],
    ] as const) {
      led.observe({
        harness_id,
        ts: new Date().toISOString(),
        quality: "native",
        kind: "quota_constraint",
        constraint_id: "five-hour",
        used_ratio,
        window_seconds: 18_000,
        resets_at: reset,
      });
    }
    expect(
      selectHarness([cand("claude"), cand("codex")], routeContext(led, "auto"))?.harnessId,
    ).toBe("codex");
  });

  it("routes from durable quota snapshots without crossing credential identities", () => {
    const led = new BudgetLedger();
    const observedAt = new Date().toISOString();
    const resetsAt = new Date(Date.now() + 9_000_000).toISOString();
    led.observeQuotaSnapshot({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: "Plus",
        subject_id: "native-subject",
      },
      constraints: [
        {
          id: "five-hour",
          label: "5 hour",
          used_ratio: 0.1,
          window_seconds: 18_000,
          resets_at: resetsAt,
          cooldown_until: null,
        },
      ],
      source: "codex_app_server",
      observed_at: observedAt,
      freshness: "fresh",
    });
    led.observeQuotaSnapshot({
      subject: {
        harness: "codex",
        credential_route: "managed_api_key",
        plan_label: null,
        subject_id: "paid-subject",
      },
      constraints: [
        {
          id: "cooldown",
          label: "Cooldown",
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
      source: "codex_rollout",
      observed_at: observedAt,
      freshness: "fresh",
    });

    const native = cand("codex", { credentialRoute: "vendor_native" });
    expect(selectHarness([cand("claude"), native], routeContext(led, "auto"))).toBe(native);
    expect(
      selectHarness(
        [cand("claude"), cand("codex", { credentialRoute: "managed_api_key" })],
        routeContext(led, "auto"),
      )?.harnessId,
    ).toBe("claude");
  });

  it("keeps a fresh saturated quota route unavailable until its reset", () => {
    const led = new BudgetLedger();
    const reset = new Date(Date.now() + 60_000).toISOString();
    led.observeQuotaSnapshot({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: "Plus",
        subject_id: "native-subject",
      },
      constraints: [
        {
          id: "five-hour",
          label: "5 hour",
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: reset,
          cooldown_until: null,
        },
      ],
      source: "codex_app_server",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });

    const codex = cand("codex", { credentialRoute: "vendor_native" });
    expect(selectHarness([codex, cand("claude")], routeContext(led, "auto"))?.harnessId).toBe(
      "claude",
    );
    expect(led.cooldownActive("codex", "vendor_native", undefined, Date.parse(reset) + 1)).toBe(
      false,
    );
  });

  it("applies a saturated model-scoped window only to that model", () => {
    const led = new BudgetLedger();
    const now = Date.now();
    const reset = new Date(now + 60_000).toISOString();
    led.observeQuotaSnapshot({
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: "max",
        subject_id: null,
      },
      constraints: [
        {
          id: "weekly_scoped:Fable",
          label: "7 day (Fable)",
          applies_to_models: ["fable", "claude-fable-5", "best"],
          used_ratio: 1,
          window_seconds: 7 * 24 * 60 * 60,
          resets_at: reset,
          cooldown_until: null,
        },
      ],
      source: "claude_oauth_usage",
      observed_at: new Date(now).toISOString(),
      freshness: "fresh",
    });

    expect(led.cooldownActive("claude", "vendor_native", null, now, "claude-fable-5")).toBe(true);
    expect(led.cooldownActive("claude", "vendor_native", null, now, "best")).toBe(true);
    expect(led.cooldownActive("claude", "vendor_native", null, now, "claude-opus-5")).toBe(false);
    // null is an intentional vendor-native default: the concrete model is not
    // knowable before spawn, so scoped evidence alone cannot refuse it.
    expect(led.cooldownActive("claude", "vendor_native", null, now, null)).toBe(false);
    expect(led.bindingPaceSlack("claude", "vendor_native", null, now, null)).toBeNull();
    // Omitted means the caller supplied no model context and stays conservative.
    expect(led.cooldownActive("claude", "vendor_native", null, now)).toBe(true);
    expect(led.bindingPaceSlack("claude", "vendor_native", null, now, "claude-opus-5")).toBeNull();
    expect(
      led.bindingPaceSlack("claude", "vendor_native", null, now, "claude-fable-5"),
    ).not.toBeNull();

    const opus = cand("claude", {
      model: "claude-opus-5",
      credentialRoute: "vendor_native",
      credentialSubjectId: null,
    });
    const fable = cand("claude", {
      model: "claude-fable-5",
      credentialRoute: "vendor_native",
      credentialSubjectId: null,
    });
    expect(selectHarness([opus], routeContext(led, "auto"))).toBe(opus);
    expect(selectHarness([fable], routeContext(led, "auto"))).toBeNull();
  });

  it("a cooldown is SUBJECT-scoped (round-16 #2): profile A's exhaustion never excludes profile B or the engine default", () => {
    const led = new BudgetLedger();
    const reset = new Date(Date.now() + 60_000).toISOString();
    led.observeQuotaSnapshot({
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: "max",
        subject_id: "a",
      },
      constraints: [
        {
          id: "five_hour",
          label: "5 hour",
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: reset,
          cooldown_until: null,
        },
      ],
      source: "claude_oauth_usage",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });
    // Exactly profile A cools down; profile B and the null default stay
    // eligible; an UNKNOWN subject stays conservatively excluded.
    expect(led.cooldownActive("claude", "vendor_native", "a")).toBe(true);
    expect(led.cooldownActive("claude", "vendor_native", "b")).toBe(false);
    expect(led.cooldownActive("claude", "vendor_native", null)).toBe(false);
    expect(led.cooldownActive("claude", "vendor_native")).toBe(true);
    // The router carries the subject: the same harness+route is selectable as
    // profile B while profile A is spent.
    const asA = cand("claude", { credentialRoute: "vendor_native", credentialSubjectId: "a" });
    const asB = cand("claude", { credentialRoute: "vendor_native", credentialSubjectId: "b" });
    expect(selectHarness([asA], routeContext(led, "auto"))).toBeNull();
    expect(selectHarness([asB], routeContext(led, "auto"))?.harnessId).toBe("claude");
    // Pace slack is subject-scoped the same way.
    expect(led.bindingPaceSlack("claude", "vendor_native", "b")).toBeNull();
    expect(led.bindingPaceSlack("claude", "vendor_native", "a")).not.toBeNull();
  });

  it("LIVE observations are ROUTE-scoped too (round-18 #3): an api_key limit never cools the same subject's vendor-native route", () => {
    const led = new BudgetLedger();
    const [obs] = observationsFromEvent("claude", {
      type: "error",
      session_id: "s",
      ts: new Date().toISOString(),
      error: "rate limited",
      credential_route: "managed_api_key",
      credential_profile_id: "r",
      rate_limit: {
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        retry_delay_ms: null,
      },
    });
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("claude", "managed_api_key", "r")).toBe(true);
    expect(led.cooldownActive("claude", "vendor_native", "r")).toBe(false);
    // Unknown caller route stays conservatively any-route.
    expect(led.cooldownActive("claude", undefined, "r")).toBe(true);
  });

  it("applies a live model-scoped rejection only to matching models", () => {
    const led = new BudgetLedger();
    const [obs] = observationsFromEvent("claude", {
      type: "status",
      session_id: "s",
      ts: new Date().toISOString(),
      credential_route: "vendor_native",
      credential_profile_id: "r",
      rate_limit: {
        constraint_id: "seven_day_opus",
        applies_to_models: ["opus", "claude-opus-5", "best"],
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        retry_delay_ms: null,
      },
    });
    expect(obs).toMatchObject({
      constraint_id: "seven_day_opus",
      applies_to_models: ["opus", "claude-opus-5", "best"],
    });
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("claude", "vendor_native", "r", Date.now(), "claude-opus-5")).toBe(
      true,
    );
    expect(led.cooldownActive("claude", "vendor_native", "r", Date.now(), "claude-fable-5")).toBe(
      false,
    );
    expect(led.cooldownActive("claude", "vendor_native", "r", Date.now(), null)).toBe(false);
    // Missing caller context remains conservative.
    expect(led.cooldownActive("claude", "vendor_native", "r")).toBe(true);
  });

  it("excludes a rate-limited harness via the typed rate_limit signal", () => {
    const led = new BudgetLedger();
    const [obs] = observationsFromEvent("codex", {
      type: "error",
      session_id: "s",
      ts: new Date().toISOString(),
      error: "rate limited",
      rate_limit: {
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        retry_delay_ms: null,
      },
    });
    expect(obs?.kind).toBe("rate_limited");
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("codex")).toBe(true);
    expect(selectHarness([cand("codex")], routeContext(led, "auto"))).toBeNull();
  });

  it("LIVE observations are subject-scoped too (round-17 #2): profile A's rate limit never cools profile B or the default", () => {
    const led = new BudgetLedger();
    const [obs] = observationsFromEvent("claude", {
      type: "error",
      session_id: "s",
      ts: new Date().toISOString(),
      error: "rate limited",
      credential_route: "vendor_native",
      credential_profile_id: "a",
      rate_limit: {
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        retry_delay_ms: null,
      },
    });
    // The observation carries the event's route + subject stamps.
    expect(obs).toMatchObject({ credential_route: "vendor_native", subject_id: "a" });
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("claude", undefined, "a")).toBe(true);
    expect(led.cooldownActive("claude", undefined, "b")).toBe(false);
    expect(led.cooldownActive("claude", undefined, null)).toBe(false);
    // Unknown caller subject stays conservatively any-subject.
    expect(led.cooldownActive("claude")).toBe(true);
    // An unstamped (default-subject) observation cools exactly the default.
    const [defaultObs] = observationsFromEvent("claude", {
      type: "error",
      session_id: "s2",
      ts: new Date().toISOString(),
      error: "rate limited",
      rate_limit: {
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        retry_delay_ms: null,
      },
    });
    led.observe(defaultObs as NonNullable<typeof defaultObs>);
    expect(led.cooldownActive("claude", undefined, null)).toBe(true);
    expect(led.cooldownActive("claude", undefined, "b")).toBe(false);
  });

  it("only the typed rate_limit field trips a cooldown (no regex governance over prose)", () => {
    const ts = new Date().toISOString();
    // Error PROSE alone never trips a cooldown here — detection is the adapter's
    // job and arrives as the typed field; the budget layer just projects it.
    expect(
      observationsFromEvent("x", {
        type: "error",
        session_id: "s",
        ts,
        error: "HTTP 429 Too Many Requests",
      }),
    ).toEqual([]);
    expect(
      observationsFromEvent("x", {
        type: "error",
        session_id: "s",
        ts,
        error: "received 429 items",
      }),
    ).toEqual([]);
    // The typed field drives the observation; a retry_delay_ms becomes the cooldown.
    const [obs] = observationsFromEvent("x", {
      type: "error",
      session_id: "s",
      ts,
      error: "rate limited",
      rate_limit: { resets_at: null, retry_delay_ms: 1000 },
    });
    expect(obs?.kind).toBe("rate_limited");
    expect(obs?.cooldown_until).toBeTruthy();
  });

  it("projects a reported zero as spend and an absent amount as nothing (#171)", () => {
    const ts = new Date().toISOString();
    const usage = (fields: Record<string, unknown>) =>
      observationsFromEvent("x", {
        type: "usage",
        session_id: "s",
        ts,
        usage: fields,
      });
    expect(usage({ input_tokens: 1 })).toEqual([]);
    expect(usage({ cost_usd: 0 })).toMatchObject([{ kind: "spend", usd: 0, quality: "exact" }]);
    expect(usage({ cost_usd: 0, estimated: true })).toMatchObject([
      { kind: "spend", usd: 0, quality: "observed" },
    ]);
    expect(usage({ cost_usd: Number.NaN })).toEqual([]);
    expect(usage({ cost_usd: -1 })).toEqual([]);
    // A spend signal is never a cooldown or a pace.
    const ledger = new BudgetLedger();
    for (const observation of usage({ cost_usd: 0 })) ledger.observe(observation);
    expect(ledger.cooldownActive("x")).toBe(false);
    expect(ledger.bindingPaceSlack("x")).toBeNull();
  });
});

describe("wave guard (estimate holds)", () => {
  const known = routeCostEvidence({
    billing: "metered",
    knowledge: "exact",
    source: "test-pricing",
    provenance: ["fixture:wave"],
  });
  const estimate = (estimatedUsd: number) =>
    routeCostEvidence({
      billing: "metered",
      knowledge: "estimated",
      source: "test-pricing",
      provenance: ["fixture:wave"],
      estimatedUsd,
    });

  it("denies a wave slot whose estimate exceeds remaining headroom without poisoning granted work", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.1 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", cost: known });
    expect(first.granted).toBe(true);
    // Second slot holds the floor and fits (0.05 < 0.1 remaining).
    const second = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "h",
      cost: estimate(0.05),
    });
    expect(second.granted).toBe(true);
    // Third slot would need 0.06 but only 0.05 remains -> typed wave denial.
    const third = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "h",
      cost: estimate(0.06),
    });
    expect(third.granted).toBe(false);
    expect(third.denied).toBe("estimate_headroom");
    // The denial recorded NO hold: the tier is unchanged for granted work.
    expect(ledger.tier()).not.toBe("hard");
  });

  it("denies an estimate that EXACTLY consumes remaining headroom (boundary must not trip the breaker)", () => {
    // The GPT-critic live repro: floor 0.05, cap 0.05 — granting the equality
    // case pushed holds to exactly the hard threshold and cancelled EVERY
    // in-flight candidate with $0 real spend.
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.05 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", cost: known });
    expect(first.granted).toBe(true);
    const second = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "h",
      cost: estimate(0.05),
    });
    expect(second.granted).toBe(false);
    expect(second.denied).toBe("estimate_headroom");
    // Granted work is unaffected: the tier never went hard on estimates alone.
    expect(ledger.tier()).not.toBe("hard");
  });

  it("keeps hard-cap denials typed as hard_cap", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.01 });
    // Real streamed usage (not an estimate) trips the hard tier...
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", cost: known });
    expect(first.granted).toBe(true);
    ledger.updateHold(first.lease?.lease_id ?? "", 0.01);
    // ...and the NEXT reservation is a hard_cap denial, not a wave denial.
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(second.granted).toBe(false);
    expect(second.denied).toBe("hard_cap");
  });
});

describe("quota observation", () => {
  it("keeps every quota window and computes the binding minimum pacing slack", async () => {
    const { observationsFromEvent } = await import("./observe.js");
    const { BudgetLedger } = await import("./ledger.js");
    const ts = new Date().toISOString();
    const obs = observationsFromEvent("codex", {
      type: "usage",
      session_id: "s",
      ts,
      usage: { input_tokens: 10 },
      quota: {
        source: "codex_rollout",
        plan_label: null,
        subject_id: null,
        constraints: [
          {
            id: "five-hour",
            label: "5 hour",
            used_ratio: 0.4,
            window_seconds: 18_000,
            resets_at: new Date(Date.now() + 9_000_000).toISOString(),
            cooldown_until: null,
          },
          {
            id: "weekly",
            label: "weekly",
            used_ratio: 0.2,
            window_seconds: 604_800,
            resets_at: new Date(Date.now() + 453_600_000).toISOString(),
            cooldown_until: null,
          },
        ],
      },
    } as never);
    expect(obs).toHaveLength(2);
    expect(obs[0]).toMatchObject({ kind: "quota_constraint", constraint_id: "five-hour" });
    const ledger = new BudgetLedger();
    for (const item of obs) ledger.observe(item);
    expect(ledger.bindingPaceSlack("codex")).toBeCloseTo(0.05, 2);
    expect(ledger.bindingPaceSlack("claude")).toBeNull();
  });
});

describe("routing telemetry", () => {
  it("keeps EMA metrics as telemetry; economy consumes explicit incremental cost only", async () => {
    const { recordHarnessMetric, loadHarnessMetrics } = await import("./metrics.js");
    const { selectHarness } = await import("./router.js");
    const { BudgetLedger } = await import("./ledger.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "claudexor-metrics-"));
    try {
      recordHarnessMetric(dir, "codex", { costUsd: 0.02, durationMs: 30_000 });
      recordHarnessMetric(dir, "claude", { costUsd: 0.4, durationMs: 60_000 });
      const metrics = loadHarnessMetrics(dir);
      expect(metrics["codex"]!.avg_cost_usd).toBeCloseTo(0.02, 5);
      expect(metrics["claude"]!.samples).toBe(1);
      const mk = (id: string) => ({
        harnessId: id,
        available: true,
        model: `${id}-model`,
        effort: "high" as const,
        billingKnowledge: "metered" as const,
        incrementalCostUsd: metrics[id]!.avg_cost_usd ?? undefined,
      });
      const ledger = new BudgetLedger();
      const cheap = selectHarness([mk("codex"), mk("claude")], routeContext(ledger, "economy"));
      expect(cheap?.harnessId).toBe("codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("last_auth_mode is route evidence: persists, updates without a perf sample, ignores unknown values", async () => {
    const { recordHarnessMetric, loadHarnessMetrics } = await import("./metrics.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "claudexor-metrics-auth-"));
    try {
      recordHarnessMetric(dir, "codex", {
        costUsd: 0.02,
        durationMs: 30_000,
        authMode: "local_session",
      });
      let m = loadHarnessMetrics(dir);
      expect(m["codex"]!.last_auth_mode).toBe("local_session");
      expect(m["codex"]!.samples).toBe(1);
      // Auth-only record (errored attempt disclosing its route): route updates,
      // sample count does NOT — a fast-failing harness earns no latency average.
      recordHarnessMetric(dir, "codex", { authMode: "api_key" });
      m = loadHarnessMetrics(dir);
      expect(m["codex"]!.last_auth_mode).toBe("api_key");
      expect(m["codex"]!.samples).toBe(1);
      // Absent/unknown auth keeps the last disclosed route.
      recordHarnessMetric(dir, "codex", { costUsd: 0.01, durationMs: 10_000 });
      m = loadHarnessMetrics(dir);
      expect(m["codex"]!.last_auth_mode).toBe("api_key");
      expect(m["codex"]!.samples).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // QA-034: a route's typed auth evidence (credential route + verification) is
  // the ONLY source of billing knowledge. A verified native/subscription route
  // yields subscription_entitlement; a metered/API-key route is never presumed
  // free; an unverified or unknown route stays unknown.
  describe("billing evidence from the typed auth route (QA-034)", () => {
    it("a verified vendor-native route proves subscription entitlement", () => {
      expect(billingKnowledgeForAuthRoute({ route: "vendor_native", verification: "passed" })).toBe(
        "subscription_entitlement",
      );
    });

    it("a metered/API-key route is metered and never presumed free", () => {
      expect(
        billingKnowledgeForAuthRoute({ route: "managed_api_key", verification: "passed" }),
      ).toBe("metered");
      expect(
        billingKnowledgeForAuthRoute({ route: "managed_api_key", verification: "not_run" }),
      ).toBe("metered");
    });

    it("an unverified native route or an unknown route stays unknown (never free)", () => {
      expect(
        billingKnowledgeForAuthRoute({ route: "vendor_native", verification: "not_run" }),
      ).toBe("unknown");
      expect(billingKnowledgeForAuthRoute({ route: "vendor_native", verification: "failed" })).toBe(
        "unknown",
      );
      expect(billingKnowledgeForAuthRoute({ route: "local", verification: "passed" })).toBe(
        "unknown",
      );
      expect(billingKnowledgeForAuthRoute({ route: null, verification: "not_run" })).toBe(
        "unknown",
      );
    });
  });

  describe("native auth evidence reaches economy ranking and paid_fallback (QA-034)", () => {
    const nativeVerified = (id: string, over: Partial<RouterCandidate> = {}): RouterCandidate => ({
      harnessId: id,
      available: true,
      model: `${id}-model`,
      effort: "high",
      authRoute: { route: "vendor_native", verification: "passed" },
      ...over,
    });
    const apiKey = (id: string, over: Partial<RouterCandidate> = {}): RouterCandidate => ({
      harnessId: id,
      available: true,
      model: `${id}-model`,
      effort: "high",
      authRoute: { route: "managed_api_key", verification: "passed" },
      incrementalCostUsd: 0.02,
      ...over,
    });

    it("economy ranks a verified native route ahead of a metered API-key route (real tuple, no registry tie)", () => {
      const led = new BudgetLedger();
      const ranked = rankHarnesses(
        [apiKey("codex"), nativeVerified("claude")],
        routeContext(led, "economy"),
      );
      expect(ranked.map((r) => r.harnessId)).toEqual(["claude", "codex"]);
    });

    it("paid_fallback:never keeps verified native routes and drops the pure API-key route", () => {
      const led = new BudgetLedger();
      const ctx = { ...routeContext(led, "economy"), paidFallback: "never" as const };
      const survivors = rankHarnesses(
        [nativeVerified("codex"), nativeVerified("claude"), apiKey("cursor")],
        ctx,
      );
      expect(survivors.map((r) => r.harnessId).sort()).toEqual(["claude", "codex"]);
    });

    it("paid_fallback:never no longer deletes an all-native pool (was 'no harness remains eligible')", () => {
      const led = new BudgetLedger();
      const ctx = { ...routeContext(led, "economy"), paidFallback: "never" as const };
      const survivors = rankHarnesses(
        [nativeVerified("codex"), nativeVerified("claude"), nativeVerified("cursor")],
        ctx,
      );
      expect(survivors.length).toBe(3);
    });

    it("emits a typed ranking rationale, not prose, for the routing evidence", () => {
      const led = new BudgetLedger();
      // All-native/unknown pool with no tiers: the report's exact fixture — the
      // rationale must say the order was declared/unknown-cash, not 'cheapest'.
      const unknownNative = (id: string): RouterCandidate => ({
        harnessId: id,
        available: true,
        model: `${id}-model`,
        effort: "high",
        authRoute: { route: "vendor_native", verification: "not_run" },
      });
      const r = explainRanking([unknownNative("codex"), unknownNative("claude")], {
        ...routeContext(led, "economy"),
        qualityTiers: {},
      });
      expect(r.reason).toBe("all_incremental_cash_unknown");
      expect(r.order).toEqual(["codex", "claude"]);
      expect(r.entries.every((e) => e.billing_knowledge === "unknown")).toBe(true);

      // A verified native route flips the decisive reason to entitlement-first.
      const r2 = explainRanking(
        [
          {
            harnessId: "codex",
            available: true,
            authRoute: { route: "vendor_native", verification: "passed" },
          },
          {
            harnessId: "cursor",
            available: true,
            authRoute: { route: "managed_api_key", verification: "passed" },
            incrementalCostUsd: 0.02,
          },
        ],
        { ...routeContext(led, "economy"), paidFallback: "never", qualityTiers: {} },
      );
      expect(r2.reason).toBe("subscription_entitlement_first");
      expect(r2.order).toEqual(["codex"]);
      expect(r2.dropped).toEqual(["cursor"]);
    });

    it("an unverified native route is NOT entitlement and is dropped by paid_fallback:never", () => {
      const led = new BudgetLedger();
      const ctx = { ...routeContext(led, "economy"), paidFallback: "never" as const };
      const survivors = rankHarnesses(
        [
          nativeVerified("codex"),
          nativeVerified("claude", {
            authRoute: { route: "vendor_native", verification: "not_run" },
          }),
        ],
        ctx,
      );
      expect(survivors.map((r) => r.harnessId)).toEqual(["codex"]);
    });

    // Economy decisive-axis mirroring (round-3): entitlement-first is reported
    // ONLY when the paid/free split actually separated the pool, not whenever
    // ANY route is entitled. When they are ALL entitled the reason must be the
    // axis that truly decided — cost, then tier — mirroring the economy sort.
    it("reports lowest_incremental_cash when two ENTITLED routes are split by cost", () => {
      const led = new BudgetLedger();
      const r = explainRanking(
        [
          nativeVerified("a", { incrementalCostUsd: 0.05 }),
          nativeVerified("b", { incrementalCostUsd: 0.01 }),
        ],
        { ...routeContext(led, "economy"), qualityTiers: {} },
      );
      expect(r.reason).toBe("lowest_incremental_cash");
      expect(r.order).toEqual(["b", "a"]); // cheaper entitled route leads
    });

    it("falls to quality_tier when two ENTITLED equal-cost routes are split by declared tier", () => {
      const led = new BudgetLedger();
      // Both entitled, neither declares an incremental cost (equal +Inf), so the
      // cost axis does not separate them; the declared tier (claude 0, codex 1)
      // does. Entitlement did NOT decide — every route is entitled.
      const r = explainRanking(
        [nativeVerified("codex"), nativeVerified("claude")],
        routeContext(led, "economy"),
      );
      expect(r.reason).toBe("quality_tier");
      expect(r.order).toEqual(["claude", "codex"]);
    });
  });

  // Round-2 #1: the recorded auto rationale must mirror the comparator branch
  // that actually ran, never claim `expiring_quota_slack` unconditionally.
  describe("auto ranking rationale mirrors the comparator branch (round-2 #1)", () => {
    it("reports expiring_quota_slack ONLY when a binding pace slack ordered the pool", () => {
      const led = new BudgetLedger();
      const reset = new Date(Date.now() + 9_000_000).toISOString();
      for (const [harness_id, used_ratio] of [
        ["codex", 0.1],
        ["claude", 0.45],
      ] as const) {
        led.observe({
          harness_id,
          ts: new Date().toISOString(),
          quality: "native",
          kind: "quota_constraint",
          constraint_id: "five-hour",
          used_ratio,
          window_seconds: 18_000,
          resets_at: reset,
        });
      }
      const r = explainRanking([cand("claude"), cand("codex")], routeContext(led, "auto"));
      expect(r.reason).toBe("expiring_quota_slack");
      // codex has the larger positive slack -> it leads.
      expect(r.order).toEqual(["codex", "claude"]);
    });

    it("falls to quality_tier when no quota slack exists but declared tiers separate the pool", () => {
      const led = new BudgetLedger();
      // No quota observed -> bindingPaceSlack is null for both, so the auto sort
      // falls through to the tier comparator (claude tier 0, codex tier 1).
      const r = explainRanking([cand("codex"), cand("claude")], routeContext(led, "auto"));
      expect(r.reason).toBe("quality_tier");
      expect(r.order).toEqual(["claude", "codex"]);
    });

    it("falls to declared_order when neither quota slack nor a tier distinguishes the pool", () => {
      const led = new BudgetLedger();
      // Untiered candidates (not in qualityTiers) and no quota -> nothing decided
      // the order; the reason is honest declared_order, not quota slack.
      const r = explainRanking([cand("alpha"), cand("beta")], {
        ...routeContext(led, "auto"),
        qualityTiers: {},
      });
      expect(r.reason).toBe("declared_order");
      expect(r.order).toEqual(["alpha", "beta"]);
    });

    // Round-4 #3 (third recurrence): non-null but EQUAL slacks. The comparator
    // subtracts equal effective values -> order 0 -> it neither reorders the pool
    // NOR falls through to tiers, so the honest reason is declared_order even
    // though the declared tiers (claude 0, codex 1) would differ. The old
    // `slackDecided = some(non-null)` heuristic falsely claimed expiring_quota_slack.
    it("reports declared_order for EQUAL non-null slacks (does not fall through to tiers)", () => {
      const led = new BudgetLedger();
      const reset = new Date(Date.now() + 9_000_000).toISOString();
      // Identical used_ratio + window + reset for both -> identical binding pace
      // slack, so the slack axis is in force yet separates nothing.
      for (const harness_id of ["codex", "claude"] as const) {
        led.observe({
          harness_id,
          ts: new Date().toISOString(),
          quality: "native",
          kind: "quota_constraint",
          constraint_id: "five-hour",
          used_ratio: 0.3,
          window_seconds: 18_000,
          resets_at: reset,
        });
      }
      const r = explainRanking([cand("claude"), cand("codex")], routeContext(led, "auto"));
      expect(r.reason).toBe("declared_order");
      // Equal slacks: the stable sort preserves the declared input order.
      expect(r.order).toEqual(["claude", "codex"]);
    });

    // The above used to be a coin flip on a busy machine: the ranking pass read
    // Date.now() once per candidate, so a millisecond crossing between the two
    // reads made two IDENTICAL quota states differ by ~5.6e-11 of pace slack,
    // the comparator returned a non-zero order, and the rationale claimed
    // expiring_quota_slack. This pins the clock to advance on EVERY read, which
    // turns that race into a certainty; the pass must still see equal slacks
    // because it evaluates them at one instant.
    it("holds declared_order when the clock ticks between reads (one pinned instant per pass)", () => {
      const led = new BudgetLedger();
      const base = Date.now();
      const reset = new Date(base + 9_000_000).toISOString();
      for (const harness_id of ["codex", "claude"] as const) {
        led.observe({
          harness_id,
          ts: new Date(base).toISOString(),
          quality: "native",
          kind: "quota_constraint",
          constraint_id: "five-hour",
          used_ratio: 0.3,
          window_seconds: 18_000,
          resets_at: reset,
        });
      }
      let tick = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => base + tick++);
      try {
        const r = explainRanking([cand("claude"), cand("codex")], routeContext(led, "auto"));
        expect(r.reason).toBe("declared_order");
        expect(r.order).toEqual(["claude", "codex"]);
        // One pinned instant for the whole pass: the sort and the reason walk
        // may not each pin their own, or they could explain different orders.
        expect(tick).toBe(1);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("quota cooldown integration: an observed rate-limit removes the harness from selection until reset", async () => {
    const { BudgetLedger } = await import("./ledger.js");
    const { selectHarness } = await import("./router.js");
    const ledger = new BudgetLedger();
    ledger.observe({
      harness_id: "codex",
      ts: new Date().toISOString(),
      quality: "observed",
      kind: "rate_limited",
      cooldown_until: new Date(Date.now() + 60_000).toISOString(),
    });
    const pick = selectHarness([cand("codex"), cand("claude")], routeContext(ledger, "economy"));
    expect(pick?.harnessId).toBe("claude");
  });
});

describe("quotaConstraintAppliesToModel", () => {
  const scoped = { applies_to_models: ["gemini-3.7-flash-high"] };

  it("keeps a scoped window off an unspecified model by default", () => {
    // The conservative rule: the concrete model is unknowable before spawn.
    expect(quotaConstraintAppliesToModel(scoped, null)).toBe(false);
    expect(quotaConstraintAppliesToModel(scoped, "claude-opus-4-6-thinking")).toBe(false);
    expect(quotaConstraintAppliesToModel(scoped, "gemini-3.7-flash-high")).toBe(true);
  });

  it("lets a source declare that its scoped window governs the bare route too", () => {
    // Without this, a harness whose windows are ALL model-scoped (agy) could
    // never refuse an exhausted account on a run that names no model.
    const declared = { ...scoped, applies_to_unspecified_model: true };
    expect(quotaConstraintAppliesToModel(declared, null)).toBe(true);
    // It does NOT widen the scope for a DIFFERENT concrete model.
    expect(quotaConstraintAppliesToModel(declared, "claude-opus-4-6-thinking")).toBe(false);
  });

  it("still treats an unscoped window as vendor-wide and undefined as no context", () => {
    expect(quotaConstraintAppliesToModel({}, null)).toBe(true);
    expect(quotaConstraintAppliesToModel(scoped, undefined)).toBe(true);
  });
});

it("quota admission matches declared families without guessing unknown ids", () => {
  const scope = { applies_to_model_prefixes: ["claude-", "gpt-"] };
  expect(quotaConstraintAppliesToModel(scope, "claude-opus-5-5-high")).toBe(true);
  expect(quotaConstraintAppliesToModel(scope, "claude-next-generation")).toBe(true);
  expect(quotaConstraintAppliesToModel(scope, "gpt-next-generation")).toBe(true);
  expect(quotaConstraintAppliesToModel(scope, "gemini-next-generation")).toBe(false);
  expect(quotaConstraintAppliesToModel(scope, "unrecognized-model")).toBe(false);
  expect(quotaConstraintAppliesToModel(scope, null)).toBe(false);
  expect(
    quotaConstraintAppliesToModel({ ...scope, applies_to_unspecified_model: true }, null),
  ).toBe(true);
});
