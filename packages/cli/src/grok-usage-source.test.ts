import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  GlobalConfig,
  QuotaSnapshot,
  quotaDemandRequiresAllowance,
  quotaSnapshotAvailability,
  type CredentialProfile,
  type HarnessEvent,
  type UsageAllowance,
} from "@claudexor/schema";
import type { GrokUsageSpend } from "@claudexor/harness-grok";
import { refreshGrokUsageQuota } from "./grok-usage-source.js";
import { dateUsageRefusal } from "./usage-period-refusal.js";

const ALLOWANCE: UsageAllowance = {
  usd: 40,
  period_start: "2026-03-01T00:00:00Z",
  period_days: 30,
};
const PERIOD_END = "2026-03-31T00:00:00.000Z";
const NOW = new Date("2026-03-10T12:00:00Z");
// A profile home must live under the Claudexor-owned root, here a scratch one.
const ROOT = mkdtempSync(join(tmpdir(), "claudexor-grok-source-"));
const HOME = join(ROOT, "profiles", "grok-team");
const previousRoot = process.env.CLAUDEXOR_CONFIG_DIR;
beforeEach(() => {
  process.env.CLAUDEXOR_CONFIG_DIR = ROOT;
});
afterAll(() => {
  if (previousRoot === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = previousRoot;
  rmSync(ROOT, { recursive: true, force: true });
});

function profile(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "team",
    harness_id: "grok",
    display_name: "team",
    credential_kind: "config_dir_login",
    isolation_locator: HOME,
    secret_ref: null,
    enabled: true,
    created_at: null,
    usage_allowance: ALLOWANCE,
    ...overrides,
  };
}

const spent = (usd: number, unreadable = 0): GrokUsageSpend => ({
  usd,
  turns: 3,
  totalTokens: 9000,
  usdByModel: {},
  unreadable,
});

function refresh(
  profiles: CredentialProfile[],
  read: (home: string, period: { start: number; end: number }) => Promise<GrokUsageSpend>,
  now = NOW,
) {
  return refreshGrokUsageQuota({ profiles, policy: { allowances: {} }, read, now: () => now });
}

describe("Grok local usage quota source", () => {
  it("publishes spend against the allowance as one ordinary quota window", async () => {
    const seen: Array<{ home: string; period: { start: number; end: number } }> = [];
    const result = await refresh([profile()], async (home, period) => {
      seen.push({ home, period });
      return spent(10);
    });
    expect(result.absences).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    const snapshot = QuotaSnapshot.parse(result.snapshots[0]);
    expect(snapshot.source).toBe("grok_local_usage");
    expect(snapshot.subject).toMatchObject({ harness: "grok", subject_id: "team" });
    expect(snapshot.constraints).toEqual([
      {
        id: "usage_period",
        label: "Usage allowance",
        used_ratio: 0.25,
        window_seconds: 30 * 86_400,
        resets_at: PERIOD_END,
        cooldown_until: null,
      },
    ]);
    // Only the account's own Grok home is read, for exactly the current period.
    expect(seen[0]!.home.replaceAll("\\", "/")).toMatch(/grok-team\/\.grok$/);
    expect(new Date(seen[0]!.period.start).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(new Date(seen[0]!.period.end).toISOString()).toBe(PERIOD_END);
  });

  it("reports a spent allowance as exhausted until the period resets, then available", async () => {
    const result = await refresh([profile()], async () => spent(55));
    const snapshot = result.snapshots[0]!;
    expect(snapshot.constraints[0]!.used_ratio).toBe(1);
    expect(quotaSnapshotAvailability(snapshot, { now: NOW, model: null })).toMatchObject({
      state: "exhausted",
      resets_at: PERIOD_END,
    });
    const after = new Date(Date.parse(PERIOD_END) + 1000);
    expect(quotaSnapshotAvailability(snapshot, { now: after, model: null }).state).toBe(
      "available",
    );
  });

  it("starts a new period with only that period's spend", async () => {
    const periods: string[] = [];
    const result = await refresh(
      [profile()],
      async (_home, period) => {
        periods.push(new Date(period.start).toISOString());
        return spent(0);
      },
      new Date("2026-03-31T00:00:00Z"),
    );
    expect(periods).toEqual(["2026-03-31T00:00:00.000Z"]);
    expect(result.snapshots[0]!.constraints[0]).toMatchObject({
      used_ratio: 0,
      resets_at: "2026-04-30T00:00:00.000Z",
    });
  });

  it("states an incomplete or failed reading as an absence, never a smaller number", async () => {
    const partial = await refresh([profile()], async () => spent(1, 2));
    expect(partial.snapshots).toEqual([]);
    expect(partial.absences).toMatchObject([
      { subject: { harness: "grok", subject_id: "team" }, reason: "refresh_failed" },
    ]);
    const failed = await refresh([profile()], async () => {
      throw new Error("EACCES");
    });
    expect(failed.snapshots).toEqual([]);
    expect(failed.absences?.[0]?.reason).toBe("refresh_failed");
    const early = await refresh(
      [profile()],
      async () => spent(0),
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(early.snapshots).toEqual([]);
    expect(early.absences).toHaveLength(1);
  });

  it("has no built-in allowance: an account without one is not metered", async () => {
    let reads = 0;
    const result = await refresh(
      [
        profile({ usage_allowance: undefined }),
        profile({ profile_id: "off", enabled: false }),
        profile({ profile_id: "other", harness_id: "codex" }),
      ],
      async () => {
        reads += 1;
        return spent(1);
      },
    );
    expect(reads).toBe(0);
    expect(result).toEqual({ snapshots: [], absences: [] });
    expect(quotaDemandRequiresAllowance("grok")).toBe(true);
    expect(quotaDemandRequiresAllowance("claude")).toBe(false);
  });

  it("falls back to the tier's default allowance", async () => {
    const result = await refreshGrokUsageQuota({
      profiles: [profile({ usage_allowance: undefined, tier: "auxiliary" })],
      policy: { allowances: { auxiliary: { ...ALLOWANCE, usd: 20 } } },
      read: async () => spent(5),
      now: () => NOW,
    });
    expect(result.snapshots[0]!.constraints[0]!.used_ratio).toBe(0.25);
  });
});

describe("usage refusal dated by the allowance period", () => {
  const config = (profiles: CredentialProfile[]) =>
    GlobalConfig.parse({ credential_profiles: profiles });
  const refusal = (extra: Partial<HarnessEvent> = {}): HarnessEvent =>
    ({
      type: "error",
      session_id: "ses_1",
      ts: NOW.toISOString(),
      error: "403: used all available credits or reached its monthly spending limit",
      credential_profile_id: "team",
      rate_limit: { resets_at: null, retry_delay_ms: null, reopening: "unknown" },
      ...extra,
    }) as HarnessEvent;

  it("dates an undated refusal to the end of the account's current period", () => {
    const dated = dateUsageRefusal("grok", refusal(), config([profile()]), NOW.getTime());
    expect(dated.rate_limit).toEqual({
      resets_at: PERIOD_END,
      retry_delay_ms: null,
      constraint_id: "usage_period",
    });
  });

  it("works the same for an account of any harness", () => {
    const codex = profile({ harness_id: "codex", profile_id: "team" });
    const dated = dateUsageRefusal("codex", refusal(), config([codex]), NOW.getTime());
    expect(dated.rate_limit?.resets_at).toBe(PERIOD_END);
  });

  it("leaves the event alone without an allowance, for another account, or when dated", () => {
    const plain = refusal();
    const none = config([profile({ usage_allowance: undefined })]);
    expect(dateUsageRefusal("grok", plain, none, NOW.getTime())).toBe(plain);
    expect(dateUsageRefusal("claude", plain, config([profile()]), NOW.getTime())).toBe(plain);
    const vendorDated = refusal({
      rate_limit: { resets_at: "2026-03-11T00:00:00Z", retry_delay_ms: null },
    });
    expect(dateUsageRefusal("grok", vendorDated, config([profile()]), NOW.getTime())).toBe(
      vendorDated,
    );
    const ordinary = refusal({ rate_limit: { resets_at: null, retry_delay_ms: 30_000 } });
    expect(dateUsageRefusal("grok", ordinary, config([profile()]), NOW.getTime())).toBe(ordinary);
  });
});
