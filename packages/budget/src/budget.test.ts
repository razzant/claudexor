import { describe, expect, it } from "vitest";
import { BudgetLedger, promptFingerprint, routeCostEvidence } from "./ledger.js";
import { observationsFromEvent } from "./observe.js";
import { RoutingPreflightError, type RouterCandidate, selectHarness } from "./router.js";

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
    const disclosed: Array<{ cash: number; valuation: number }> = [];
    const led = new BudgetLedger({ kind: "unlimited" }, undefined, {
      onCashSettled: (cash, valuation) => disclosed.push({ cash, valuation }),
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
    expect(disclosed).toEqual([{ cash: 0, valuation: 3 }]);

    const paid = led.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "paid",
      cost: metered(0.5),
    });
    led.settle(paid.lease!.lease_id, exactSettlement(0.4));
    // Cumulative, not per-settle: the second disclosure carries the total.
    expect(disclosed).toEqual([
      { cash: 0, valuation: 3 },
      { cash: 0.4, valuation: 3 },
    ]);
  });

  it("settles all native token costs as valuation while API-key costs remain cash", async () => {
    const { attemptUsageCostSettlement } = await import("./ledger.js");
    const native = new BudgetLedger({ kind: "finite", maxUsd: 1 });
    const nativeLease = native.reserve({
      taskId: "native-task",
      attemptId: "native-attempt",
      intent: "implement",
      harnessId: "codex",
    });
    native.settle(
      nativeLease.lease!.lease_id,
      attemptUsageCostSettlement(0.25, true, "native-attempt", "codex", "local_session"),
    );
    expect(native.spend()).toBe(0);
    expect(native.valuation()).toBe(0.25);
    expect(native.terminal()).toBe("cost_unverifiable");

    const nativeExact = new BudgetLedger({ kind: "unlimited" });
    const nativeExactLease = nativeExact.reserve({
      taskId: "native-exact-task",
      attemptId: "native-exact-attempt",
      intent: "implement",
      harnessId: "claude",
    });
    nativeExact.settle(
      nativeExactLease.lease!.lease_id,
      attemptUsageCostSettlement(0.37, false, "native-exact-attempt", "claude", "local_session"),
    );
    expect(nativeExact.spend()).toBe(0);
    expect(nativeExact.valuation()).toBe(0.37);

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
    expect(api.terminal()).toBeNull();
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

  it("records late exact overshoot and blocks the next paid unit", () => {
    const ledger = new BudgetLedger({ kind: "finite", maxUsd: 0.1 });
    const lease = ledger.reserve({
      taskId: "t",
      intent: "implement",
      harnessId: "codex",
      cost: metered(0.05),
    });
    ledger.settle(lease.lease?.lease_id ?? "", exactSettlement(0.12));
    expect(ledger.terminal()).toBe("exhausted_overshoot");
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
