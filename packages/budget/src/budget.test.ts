import { describe, expect, it } from "vitest";
import type { ProviderFamily } from "@claudexor/schema";
import { BudgetLedger, promptFingerprint } from "./ledger.js";
import { observationsFromEvent } from "./observe.js";
import { type RouterCandidate, selectHarness } from "./router.js";

describe("BudgetLedger", () => {
  it("escalates circuit tiers with spend; hard cap denies reservation", () => {
    const led = new BudgetLedger({ maxUsd: 1.0 });
    const r1 = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    expect(r1.granted).toBe(true);
    expect(r1.tier).toBe("ok");
    led.settle(r1.lease?.lease_id ?? "", 0.8);
    expect(led.tier()).toBe("soft");
    const r2 = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    led.settle(r2.lease?.lease_id ?? "", 0.15);
    expect(led.tier()).toBe("downgrade");
    const r3 = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    led.settle(r3.lease?.lease_id ?? "", 0.1);
    expect(led.tier()).toBe("hard");
    expect(led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" }).granted).toBe(false);
  });

  it("settle fails loudly on an unknown lease and never double-counts a re-settle", () => {
    const led = new BudgetLedger({ maxUsd: 1.0 });
    expect(() => led.settle("lease-never-granted", 0.5)).toThrow(/unknown lease/);
    const r = led.reserve({ taskId: "t", intent: "implement", harnessId: "codex" });
    led.settle(r.lease?.lease_id ?? "", 0.4);
    led.settle(r.lease?.lease_id ?? "", 0.4); // duplicate settle: spend add is a no-op
    expect(led.spend()).toBeCloseTo(0.4, 8);
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
    // 0.95 fits under the parent cap (the wave guard denies estimates that
    // would consume headroom to the boundary), and its hold is visible at the
    // parent tier (0.95/1.0 ≥ downgrade threshold).
    const r = child.reserve({ taskId: "t", intent: "implement", harnessId: "codex", estimateUsd: 0.95 });
    expect(r.granted).toBe(true);
    expect(parent.tier()).toBe("downgrade");
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
    const [obs] = observationsFromEvent("codex", {
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
    expect(observationsFromEvent("x", { type: "error", session_id: "s", ts, error: "HTTP 429 Too Many Requests" })).toEqual([]);
    expect(observationsFromEvent("x", { type: "error", session_id: "s", ts, error: "received 429 items" })).toEqual([]);
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
  it("denies a wave slot whose estimate exceeds remaining headroom without poisoning granted work", () => {
    const ledger = new BudgetLedger({ maxUsd: 0.1 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(first.granted).toBe(true);
    // Second slot holds the floor and fits (0.05 < 0.1 remaining).
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.05 });
    expect(second.granted).toBe(true);
    // Third slot would need 0.06 but only 0.05 remains -> typed wave denial.
    const third = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.06 });
    expect(third.granted).toBe(false);
    expect(third.denied).toBe("estimate_headroom");
    // The denial recorded NO hold: the tier is unchanged for granted work.
    expect(ledger.tier()).not.toBe("hard");
  });

  it("denies an estimate that EXACTLY consumes remaining headroom (boundary must not trip the breaker)", () => {
    // The GPT-critic live repro: floor 0.05, cap 0.05 — granting the equality
    // case pushed holds to exactly the hard threshold and cancelled EVERY
    // in-flight candidate with $0 real spend.
    const ledger = new BudgetLedger({ maxUsd: 0.05 });
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(first.granted).toBe(true);
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h", estimateUsd: 0.05 });
    expect(second.granted).toBe(false);
    expect(second.denied).toBe("estimate_headroom");
    // Granted work is unaffected: the tier never went hard on estimates alone.
    expect(ledger.tier()).not.toBe("hard");
  });

  it("keeps hard-cap denials typed as hard_cap", () => {
    const ledger = new BudgetLedger({ maxUsd: 0.01 });
    // Real streamed usage (not an estimate) trips the hard tier...
    const first = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(first.granted).toBe(true);
    ledger.updateHold(first.lease?.lease_id ?? "", 0.01);
    // ...and the NEXT reservation is a hard_cap denial, not a wave denial.
    const second = ledger.reserve({ taskId: "t", intent: "implement", harnessId: "h" });
    expect(second.granted).toBe(false);
    expect(second.denied).toBe("hard_cap");
  });
});

describe("quota observation", () => {
  it("maps a typed HarnessEvent.quota to a native used_percent observation that drives headroom()", async () => {
    const { observationsFromEvent } = await import("./observe.js");
    const { BudgetLedger } = await import("./ledger.js");
    const ts = new Date().toISOString();
    const [obs] = observationsFromEvent("codex", {
      type: "usage",
      session_id: "s",
      ts,
      usage: { input_tokens: 10 },
      quota: { used_percent: 40, resets_at: null },
    } as never);
    expect(obs).toMatchObject({ kind: "used_percent", used_percent: 40, quality: "native" });
    const ledger = new BudgetLedger();
    ledger.observe(obs!);
    expect(ledger.headroom("codex")).toBeCloseTo(0.6, 5);
    expect(ledger.headroom("claude")).toBe(1); // no signal -> honest unknown
  });
});

describe("portfolio metrics", () => {
  it("EMA metrics store: records settled samples and orders cheapest by REAL cost spread", async () => {
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
      const mk = (id: string, family: "openai" | "anthropic") => ({
        harnessId: id,
        providerFamily: family,
        available: true,
        authMode: "local_session" as const,
        costPerCall: metrics[id]!.avg_cost_usd ?? undefined,
        latencyMs: metrics[id]!.avg_duration_ms ?? undefined,
      });
      const ledger = new BudgetLedger();
      // cheapest: the 20x cost spread must pick codex.
      const cheap = selectHarness([mk("codex", "openai"), mk("claude", "anthropic")], { portfolio: "cheapest", ledger });
      expect(cheap?.harnessId).toBe("codex");
      // strongest with a decisive quality prior: claude wins despite cost.
      const strong = selectHarness(
        [
          { ...mk("codex", "openai"), qualityForIntent: 0.5 },
          { ...mk("claude", "anthropic"), qualityForIntent: 0.95 },
        ],
        { portfolio: "strongest", ledger },
      );
      expect(strong?.harnessId).toBe("claude");
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
      recordHarnessMetric(dir, "codex", { costUsd: 0.02, durationMs: 30_000, authMode: "local_session" });
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
    const pick = selectHarness(
      [
        { harnessId: "codex", providerFamily: "openai", available: true },
        { harnessId: "claude", providerFamily: "anthropic", available: true },
      ],
      { portfolio: "cheapest", ledger },
    );
    expect(pick?.harnessId).toBe("claude");
  });
});
