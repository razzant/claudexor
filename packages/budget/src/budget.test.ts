import { describe, expect, it } from "vitest";
import type { ProviderFamily } from "@claudex/schema";
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

  it("excludes a rate-limited harness via observed cooldown", () => {
    const led = new BudgetLedger();
    const obs = observationFromEvent("codex", {
      type: "error",
      session_id: "s",
      ts: new Date().toISOString(),
      error: "rate limited",
      payload: { resets_at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(obs?.kind).toBe("rate_limited");
    led.observe(obs as NonNullable<typeof obs>);
    expect(led.cooldownActive("codex")).toBe(true);
    expect(selectHarness([cand("codex", "openai")], { portfolio: "daily-rich", ledger: led })).toBeNull();
  });
});
