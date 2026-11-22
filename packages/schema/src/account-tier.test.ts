import { describe, expect, it } from "vitest";
import {
  ComplexityRouteTable,
  ControlRunStartRequest,
  ControlThreadTurnRequest,
  CredentialProfile,
  GlobalConfig,
  UsageAllowance,
  usagePeriodAt,
  validateSurfaceRunControls,
} from "./index.js";

describe("usage allowance period", () => {
  const allowance = { period_start: "2026-03-01T00:00:00Z", period_days: 30 };
  const START = Date.parse(allowance.period_start);
  const DAY = 86_400_000;

  it("has no period before its start", () => {
    expect(usagePeriodAt(allowance, START - 1)).toBeNull();
  });

  it("starts a period at its first instant and ends it at the next one's start", () => {
    expect(usagePeriodAt(allowance, START)).toEqual({ start: START, end: START + 30 * DAY });
    expect(usagePeriodAt(allowance, START + 30 * DAY - 1)).toEqual({
      start: START,
      end: START + 30 * DAY,
    });
    expect(usagePeriodAt(allowance, START + 30 * DAY)).toEqual({
      start: START + 30 * DAY,
      end: START + 60 * DAY,
    });
  });

  it("repeats every period_days from the configured start", () => {
    const later = usagePeriodAt(allowance, START + 100 * DAY)!;
    expect(new Date(later.start).toISOString()).toBe("2026-05-30T00:00:00.000Z");
    expect(later.end - later.start).toBe(30 * DAY);
  });

  it("requires a positive allowance, a dated start and a positive length", () => {
    const base = { usd: 10, ...allowance };
    expect(UsageAllowance.safeParse(base).success).toBe(true);
    expect(UsageAllowance.safeParse({ ...base, usd: 0 }).success).toBe(false);
    expect(UsageAllowance.safeParse({ ...base, period_days: 0 }).success).toBe(false);
    expect(UsageAllowance.safeParse({ ...base, period_start: "March" }).success).toBe(false);
    expect(UsageAllowance.safeParse({ period_start: base.period_start }).success).toBe(false);
  });
});

describe("account tier configuration", () => {
  const row = {
    profile_id: "a",
    harness_id: "claude",
    display_name: "a",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test/profiles/claude-a",
  };

  it("leaves a row untiered and unmetered unless it says otherwise", () => {
    const parsed = CredentialProfile.parse(row);
    expect(parsed.tier).toBeUndefined();
    expect(parsed.usage_allowance).toBeUndefined();
    expect(CredentialProfile.parse({ ...row, tier: "auxiliary" }).tier).toBe("auxiliary");
    expect(CredentialProfile.safeParse({ ...row, tier: "secondary" }).success).toBe(false);
  });

  it("ships no table, no allowance and the documented reserve defaults", () => {
    const routing = GlobalConfig.parse({}).routing;
    expect(routing.complexity_routes).toEqual({});
    expect(routing.account_tiers).toEqual({
      primary_reserve: {
        weekly_used_ratio: 0.85,
        short_window_used_ratio: 0.9,
        short_window_max_seconds: 86_400,
      },
      allowances: {},
    });
  });

  it("accepts an ordered candidate list per level and refuses an unknown level", () => {
    const table = ComplexityRouteTable.parse({
      easy: [
        { harness: "claude", model: "m1" },
        { harness: "grok", model: "m2", effort: "medium" },
      ],
    });
    expect(table.easy?.map((route) => route.harness)).toEqual(["claude", "grok"]);
    expect(ComplexityRouteTable.safeParse({ trivial: [] }).success).toBe(false);
    expect(ComplexityRouteTable.safeParse({ easy: [] }).success).toBe(false);
    expect(
      ComplexityRouteTable.safeParse({ easy: [{ harness: "claude", model: "m", extra: 1 }] })
        .success,
    ).toBe(false);
  });
});

describe("complexity as a run control", () => {
  it("is accepted on a one-shot run start and validated at the surfaces", () => {
    expect(ControlRunStartRequest.parse({ prompt: "x", complexity: "hard" }).complexity).toBe(
      "hard",
    );
    expect(ControlRunStartRequest.safeParse({ prompt: "x", complexity: "huge" }).success).toBe(
      false,
    );
    expect(validateSurfaceRunControls({ complexity: "medium" })).toBeNull();
    expect(validateSurfaceRunControls({ complexity: "huge" })).toBe(
      "complexity must be easy, medium, or hard",
    );
  });

  it("is not a thread-turn control: a turn keeps its thread's pool and account", () => {
    expect("complexity" in ControlThreadTurnRequest.shape).toBe(false);
  });
});
