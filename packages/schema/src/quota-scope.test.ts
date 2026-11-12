import { describe, expect, it } from "vitest";
import type { QuotaConstraint, QuotaSnapshot } from "./quota.js";
import { quotaWindowFreshness, withCurrentQuotaScopes } from "./quota-scope.js";

const at = "2026-10-29T10:00:00.000Z";
const T = Date.parse(at);

function snapshot(
  constraints: Array<Partial<QuotaConstraint> & { id: string }>,
  overrides: Partial<QuotaSnapshot> = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "w",
    },
    source: "claude_oauth_usage",
    observed_at: at,
    freshness: "fresh",
    ...overrides,
    constraints: constraints.map((c) => ({
      label: c.id,
      used_ratio: 1,
      window_seconds: 604800,
      resets_at: null,
      cooldown_until: null,
      ...c,
    })),
  };
}

describe("withCurrentQuotaScopes (restore-only compatibility)", () => {
  it("rewrites only the retired Claude alias signature", () => {
    const legacy = snapshot([
      { id: "weekly_scoped:Sonnet", applies_to_models: ["sonnet", "claude-sonnet-5", "best"] },
      // Fallback form the retired producer used for a family outside its hints.
      { id: "weekly_scoped:Future", applies_to_models: ["future", "best"] },
      { id: "five_hour" },
    ]);
    expect(
      withCurrentQuotaScopes(legacy)?.constraints.map((c) => [
        c.id,
        c.applies_to_models,
        c.applies_to_model_prefixes,
      ]),
    ).toEqual([
      ["weekly_scoped:Sonnet", ["sonnet"], ["claude-sonnet-"]],
      ["weekly_scoped:Future", ["future"], ["claude-future-"]],
      ["five_hour", undefined, undefined],
    ]);
  });

  it("leaves current scopes, non-signature lists and other harnesses or sources unchanged", () => {
    const current = snapshot([
      {
        id: "weekly_scoped:Opus",
        applies_to_models: ["opus"],
        applies_to_model_prefixes: ["claude-opus-"],
      },
      // Not the retired signature: no `best`, or ids of two families.
      { id: "x", applies_to_models: ["opus", "claude-opus-5"] },
      { id: "y", applies_to_models: ["opus", "claude-sonnet-5", "best"] },
    ]);
    expect(withCurrentQuotaScopes(current)).toBe(current);
    const cursorBase = snapshot([{ id: "cooldown", applies_to_models: null }], {
      source: "claude_api_retry",
      subject: {
        harness: "cursor",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "c",
      },
    });
    expect(withCurrentQuotaScopes(cursorBase)).toBe(cursorBase);
    const codex = snapshot([{ id: "weekly_scoped:scoped" }], {
      source: "codex_app_server",
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "c",
      },
    });
    expect(withCurrentQuotaScopes(codex)).toBe(codex);
  });

  it("drops a single-window record whose only window had an unknown scope", () => {
    const window = snapshot([{ id: "seven_day_x", applies_to_models: ["x y", "best"] }], {
      source: "claude_rate_limit_event",
    });
    expect(withCurrentQuotaScopes(window)).toBeNull();
  });

  it("keeps an emptied full reading as unknown, never a fresh limit-free one", () => {
    const oauth = snapshot([{ id: "weekly_scoped:scoped" }], { source: "claude_oauth_usage" });
    expect(withCurrentQuotaScopes(oauth)).toEqual({
      ...oauth,
      constraints: [],
      freshness: "unknown",
    });
    // A known window beside it keeps the reading's own freshness.
    const mixed = snapshot([{ id: "five_hour" }, { id: "weekly_scoped:scoped" }], {
      source: "claude_oauth_usage",
    });
    expect(withCurrentQuotaScopes(mixed)).toMatchObject({
      freshness: "fresh",
      constraints: [{ id: "five_hour" }],
    });
  });
});

describe("quotaWindowFreshness", () => {
  const fresh = { freshness: "fresh" as const, observed_at: at };
  it("is fresh through exactly the TTL and stale at its own reset", () => {
    expect(quotaWindowFreshness(fresh, { resets_at: null }, T + 300_000)).toBe("fresh");
    expect(quotaWindowFreshness(fresh, { resets_at: null }, T + 300_001)).toBe("stale");
    const reset = new Date(T + 60_000).toISOString();
    expect(quotaWindowFreshness(fresh, { resets_at: reset }, T + 59_999)).toBe("fresh");
    expect(quotaWindowFreshness(fresh, { resets_at: reset }, T + 60_000)).toBe("stale");
  });
  it("never freshens a stale or unknown label", () => {
    expect(quotaWindowFreshness({ ...fresh, freshness: "stale" }, { resets_at: null }, T)).toBe(
      "stale",
    );
    expect(quotaWindowFreshness({ ...fresh, freshness: "unknown" }, { resets_at: null }, T)).toBe(
      "unknown",
    );
    expect(quotaWindowFreshness({ ...fresh, observed_at: "garbage" }, { resets_at: null }, T)).toBe(
      "stale",
    );
  });
});
