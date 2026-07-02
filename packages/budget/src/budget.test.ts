import { describe, expect, it } from "vitest";
import type { ProviderFamily } from "@claudexor/schema";
import { BudgetLedger, promptFingerprint } from "./ledger.js";
import { observationFromEvent } from "./observe.js";
import { type RouterCandidate, selectHarness } from "./router.js";

describe("BudgetLedger", () => {
  it("escalates circuit tiers with spend; hard cap denies reservation", () => {
    const led = new BudgetLedger({ maxUsd: 1.0 });
    const r1 = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    expect(r1.granted).toBe(true);
    expect(r1.tier).toBe("ok");
    led.settle(r1.lease?.lease_id ?? "", 0.8);
    expect(led.tier()).toBe("soft");
    led.settle("x", 0.15);
    expect(led.tier()).toBe("downgrade");
    led.settle("y", 0.1);
    expect(led.tier()).toBe("hard");
    expect(led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" }).granted).toBe(false);
  });

  it("rolls child spend up to the parent", () => {
    const parent = new BudgetLedger({ maxUsd: 1.0 });
    const child = parent.child({ maxUsd: 10 });
    const r = child.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    child.settle(r.lease?.lease_id ?? "", 1.0);
    expect(parent.tier()).toBe("hard");
  });

  it("counts in-flight holds against the cap (mid-flight enforcement, #9)", () => {
    const led = new BudgetLedger({ maxUsd: 1.0 });
    const r = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex", estimateUsd: 0.2 });
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
    led.settle(r.lease?.lease_id ?? "", 0.5);
    expect(led.spend()).toBeCloseTo(0.5, 8);
    expect(led.tier()).toBe("ok");
  });

  it("rolls child holds up to the parent and clears them on cancel", () => {
    const parent = new BudgetLedger({ maxUsd: 1.0 });
    const child = parent.child({ maxUsd: 10 });
    const r = child.reserve({ taskId: "t", intent: "implement", harnessId: "codex", estimateUsd: 1.0 });
    expect(parent.tier()).toBe("hard"); // the hold is visible at the parent cap
    child.cancel(r.lease?.lease_id ?? "");
    expect(parent.tier()).toBe("ok");
    expect(parent.spend()).toBe(0);
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

function cand(id: string, fam: ProviderFamily, over: Partial<RouterCandidate> = {}): RouterCandidate {
  return {
    harnessId: id,
    providerFamily: fam,
    available: true,
    authMode: "local_session",
    qualityForIntent: 0.8,
    costPerCall: 0.01,
    latencyMs: 1000,
    ...over,
  };
}

describe("router", () => {
  it("selects the highest-utility available harness", () => {
    const led = new BudgetLedger();
    const best = selectHarness([cand("codex", "openai"), cand("claude", "anthropic", { qualityForIntent: 0.9 })], {
      portfolio: "daily-rich",
      ledger: led,
    });
    expect(best?.harnessId).toBe("claude");
  });

  it("returns null when nothing is available", () => {
    const led = new BudgetLedger();
    expect(selectHarness([cand("x", "openai", { available: false })], { portfolio: "daily-rich", ledger: led })).toBeNull();
  });

  it("subscription-first prefers local_session over api_key", () => {
    const led = new BudgetLedger();
    const best = selectHarness(
      [cand("api", "openai", { authMode: "api_key" }), cand("sub", "anthropic", { authMode: "local_session" })],
      { portfolio: "subscription-first", ledger: led },
    );
    expect(best?.harnessId).toBe("sub");
  });

  it("excludes a rate-limited harness via the typed rate_limit signal", () => {
    const led = new BudgetLedger();
    const obs = observationFromEvent("codex", {
      type: "error",
      session_id: "s",
      ts: new Date().toISOString(),
      error: "rate limited",
      rate_limit: { resets_at: new Date(Date.now() + 3_600_000).toISOString(), retry_delay_ms: null },
    });
    expect(obs?.kind).toBe("rate_limited");
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("codex")).toBe(true);
    expect(selectHarness([cand("codex", "openai")], { portfolio: "daily-rich", ledger: led })).toBeNull();
  });

  it("only the typed rate_limit field trips a cooldown (no regex governance over prose)", () => {
    const ts = new Date().toISOString();
    // Error PROSE alone never trips a cooldown here — detection is the adapter's
    // job and arrives as the typed field; the budget layer just projects it.
    expect(observationFromEvent("x", { type: "error", session_id: "s", ts, error: "HTTP 429 Too Many Requests" })).toBeNull();
    expect(observationFromEvent("x", { type: "error", session_id: "s", ts, error: "received 429 items" })).toBeNull();
    // The typed field drives the observation; a retry_delay_ms becomes the cooldown.
    const obs = observationFromEvent("x", {
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

describe("DD-27 wave guard (estimate holds)", () => {
  it("denies a wave slot whose estimate exceeds remaining headroom without poisoning granted work", () => {
    const ledger = new BudgetLedger({ maxUsd: 0.1 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(first.granted).toBe(true);
    // Second slot holds the floor and fits (0.05 <= 0.1 remaining).
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.05 });
    expect(second.granted).toBe(true);
    // Third slot would need 0.06 but only 0.05 remains -> typed wave denial.
    const third = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.06 });
    expect(third.granted).toBe(false);
    expect(third.denied).toBe("estimate_headroom");
    // The denial recorded NO hold: the tier is unchanged for granted work.
    expect(ledger.tier()).not.toBe("hard");
  });

  it("keeps hard-cap denials typed as hard_cap", () => {
    const ledger = new BudgetLedger({ maxUsd: 0.01 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.01 });
    expect(first.granted).toBe(true);
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(second.granted).toBe(false);
    expect(second.denied).toBe("hard_cap");
  });
});
