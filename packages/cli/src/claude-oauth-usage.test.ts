import { describe, expect, it } from "vitest";
import {
  claudeOauthKeychainItem,
  parseClaudeOauthCredential,
  parseClaudeOauthUsage,
  refreshClaudeOauthUsageQuota,
} from "./claude-oauth-usage.js";

/** The EXACT response shape of the 2026-07-17 live experiment (max plan). */
const LIVE_USAGE = {
  five_hour: { utilization: 38.0, resets_at: "2026-07-17T07:40:00Z" },
  seven_day: { utilization: 26.0, resets_at: "2026-07-19T20:00:00Z" },
  limits: [
    { kind: "session", percent: 38, severity: "normal", is_active: true },
    { kind: "weekly_all", percent: 26 },
    { kind: "weekly_scoped", percent: 17, scope: { model: { display_name: "Fable" } } },
  ],
  extra_usage: { is_enabled: true, utilization: 98.77 },
  spend: { percent: 99, severity: "critical" },
};

describe("claude oauth/usage quota source (W5.3, INV-062)", () => {
  it("keychain item name follows the live-verified vendor formula", () => {
    // sha256("/Users/anton/.claudexor/v3-experiment/claude-A")[:8] observed
    // LIVE in the macOS keychain after a profile login (2026-07-17).
    expect(claudeOauthKeychainItem("/Users/anton/.claudexor/v3-experiment/claude-A")).toBe(
      "Claude Code-credentials-eb020df8",
    );
  });

  it("parses the live response into subject-scoped proactive constraints", () => {
    const snapshot = parseClaudeOauthUsage(
      LIVE_USAGE,
      "work",
      "max",
      new Date("2026-07-17T07:00:00Z"),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.subject).toMatchObject({
      harness: "claude",
      credential_route: "vendor_native",
      subject_id: "work",
      plan_label: "max",
    });
    expect(snapshot?.source).toBe("claude_oauth_usage");
    const byId = new Map(snapshot!.constraints.map((c) => [c.id, c]));
    expect(byId.get("five_hour")).toMatchObject({
      used_ratio: 0.38,
      resets_at: "2026-07-17T07:40:00Z",
      window_seconds: 5 * 3600,
    });
    expect(byId.get("seven_day")).toMatchObject({ used_ratio: 0.26 });
    expect(byId.get("weekly_scoped:Fable")).toMatchObject({
      used_ratio: 0.17,
      label: "7 day (Fable)",
    });
  });

  it("fails to unknown on junk — no fabricated constraints", () => {
    expect(parseClaudeOauthUsage(null, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({}, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({ five_hour: { utilization: "38" } }, null, null)).toBeNull();
  });

  it("reads both credential shapes and never invents a token", () => {
    expect(
      parseClaudeOauthCredential(JSON.stringify({ accessToken: "tok", subscriptionType: "max" })),
    ).toEqual({ accessToken: "tok", subscriptionType: "max" });
    expect(
      parseClaudeOauthCredential(
        JSON.stringify({ claudeAiOauth: { accessToken: "tok2", subscriptionType: "pro" } }),
      ),
    ).toEqual({ accessToken: "tok2", subscriptionType: "pro" });
    expect(parseClaudeOauthCredential("not json")).toBeNull();
    expect(parseClaudeOauthCredential(JSON.stringify({ refreshToken: "only" }))).toBeNull();
  });

  it("returns [] (never throws) when no subject responds — a source, not a gate (round-21 #4)", async () => {
    // Default user / non-macOS: no credential is readable, so the refresher
    // has nothing. It must return [] like its sibling sources, never throw
    // (a throw only polluted the registry's aggregate failure line).
    await expect(
      refreshClaudeOauthUsageQuota({
        readCredential: async () => null,
        fetchUsage: async () => {
          throw new Error("should not be called");
        },
        now: () => new Date("2026-07-18T00:00:00Z"),
      }),
    ).resolves.toEqual([]);
  });
});
