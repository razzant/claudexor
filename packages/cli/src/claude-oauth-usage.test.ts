import type { ClaudeOauthCredential } from "./claude-oauth-credential.js";
import {
  claudeOauthKeychainItem,
  parseClaudeOauthCredential,
  readClaudeOauthCredential,
} from "./claude-oauth-credential.js";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED } from "@claudexor/harness-claude";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  forgetClaudeOauthRejections,
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

const oauthCredential = (
  overrides: Partial<ClaudeOauthCredential> = {},
): ClaudeOauthCredential => ({
  accessToken: "tok",
  subscriptionType: "max",
  expiresAtMs: null,
  hasRefreshToken: false,
  ...overrides,
});

describe("claude oauth/usage quota source (W5.3, INV-146)", () => {
  // The source remembers proven vendor rejections per token in process
  // memory (#263); every test starts with an empty memory.
  beforeEach(() => forgetClaudeOauthRejections());

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
      applies_to_models: ["fable"],
      applies_to_model_prefixes: ["claude-fable-"],
    });
  });

  it.each([undefined, "", "   "])(
    "keeps an unknown weekly model scope diagnostic, never account-wide (display_name=%j)",
    (displayName) => {
      const unknown: unknown[] = [];
      const snapshot = parseClaudeOauthUsage(
        {
          five_hour: { utilization: 10 },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 100,
              scope: {
                model: { ...(displayName === undefined ? {} : { display_name: displayName }) },
              },
            },
          ],
        },
        null,
        "max",
        new Date(),
        (window) => unknown.push(window),
      );
      expect(snapshot?.constraints.map((item) => item.id)).toEqual(["five_hour"]);
      expect(unknown).toEqual([{ id: "weekly_scoped:scoped", used_ratio: 1, resets_at: null }]);
    },
  );

  it("fails to unknown on junk — no fabricated constraints", () => {
    expect(parseClaudeOauthUsage(null, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({}, null, null)).toBeNull();
    expect(parseClaudeOauthUsage({ five_hour: { utilization: "38" } }, null, null)).toBeNull();
  });

  it("reads both credential shapes and retains only non-secret refresh metadata", () => {
    expect(
      parseClaudeOauthCredential(
        JSON.stringify({
          accessToken: "tok",
          subscriptionType: "max",
          expiresAt: 1_787_011_200_000,
          refreshToken: "refresh-secret",
        }),
      ),
    ).toEqual({
      accessToken: "tok",
      subscriptionType: "max",
      expiresAtMs: 1_787_011_200_000,
      hasRefreshToken: true,
    });
    expect(
      parseClaudeOauthCredential(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "tok2",
            subscriptionType: "pro",
            expiresAt: 1_787_011_300_000,
            refreshToken: "wrapped-refresh-secret",
          },
        }),
      ),
    ).toEqual({
      accessToken: "tok2",
      subscriptionType: "pro",
      expiresAtMs: 1_787_011_300_000,
      hasRefreshToken: true,
    });
    expect(
      JSON.stringify(
        parseClaudeOauthCredential(
          JSON.stringify({ accessToken: "tok", refreshToken: "refresh-secret" }),
        ),
      ),
    ).not.toContain("refresh-secret");
    expect(parseClaudeOauthCredential("not json")).toBeNull();
    expect(parseClaudeOauthCredential(JSON.stringify({ refreshToken: "only" }))).toBeNull();
  });

  it("claims a typed not_logged_in absence (never throws) when no subject responds", async () => {
    // Default user / non-macOS: no credential is readable, so the refresher
    // produces no snapshot — but the absence is STATED, not silent emptiness
    // (release cut V11a). It never throws (a throw only polluted the registry's
    // aggregate failure line).
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.subject.harness).toBe("claude");
    expect(nativeAbsence?.reason).toBe("not_logged_in");
    expect(result.absences?.every((a) => a.reason === "not_logged_in")).toBe(true);
  });

  it.each([true, false])(
    "keeps an unknown-scope window's identity, usage and reset in the receipt (known window=%s)",
    async (known) => {
      const receipts: Array<{ stage: string; outcome: string; reason?: string }> = [];
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async () => oauthCredential(),
        fetchUsage: async () => ({
          ...(known ? { five_hour: { utilization: 10 } } : {}),
          limits: [
            {
              kind: "weekly_scoped",
              percent: 95,
              resets_at: "2026-07-20T00:00:00Z",
              scope: { model: { display_name: "Opus 4.6" } },
            },
          ],
        }),
        now: () => new Date("2026-07-18T00:00:00Z"),
        diagnostic: (record) => receipts.push(record),
      });
      const receipt = receipts.find((r) => r.stage === "usage_http" && r.outcome !== "started");
      expect(receipt?.reason).toBe(
        `${known ? "windows_observed" : "no_parseable_windows"}; unknown_scope=weekly_scoped:Opus 4.6 used=95% resets=2026-07-20T00:00:00Z`,
      );
      // Never an account-wide window, and never a fresh limit-free reading.
      const windows = result.snapshots.flatMap((row) => row.constraints.map((c) => c.id));
      expect(windows).toEqual(known ? ["five_hour"] : []);
      if (!known)
        expect(result.absences?.find((a) => a.subject.subject_id === null)).toMatchObject({
          reason: "refresh_failed",
          detail: expect.stringContaining("unknown model scope"),
        });
    },
  );

  it("claims a refresh_failed absence when the usage endpoint refuses", async () => {
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => oauthCredential(),
      fetchUsage: async () => {
        throw new Error("oauth/usage responded 500");
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("500");
  });

  it.each([401, 403])(
    "claims auth_revoked when the vendor rejects a known-fresh credential (%i)",
    async (status) => {
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async () =>
          oauthCredential({
            expiresAtMs: Date.parse("2026-07-18T01:00:00Z"),
            hasRefreshToken: true,
          }),
        fetchUsage: async () => {
          throw Object.assign(new Error(`oauth/usage responded ${status}`), {
            quotaAbsenceReason: "auth_revoked" as const,
          });
        },
        now: () => new Date("2026-07-18T00:00:00Z"),
      });
      expect(result.snapshots).toEqual([]);
      const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
      expect(nativeAbsence?.reason).toBe("auth_revoked");
      expect(nativeAbsence?.detail).toContain(String(status));
    },
  );

  it.each([401, 403])(
    "fails a rejected refreshable credential with unknown expiry to refresh_failed (%i)",
    async (status) => {
      let fetches = 0;
      let refreshes = 0;
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async () =>
          oauthCredential({
            expiresAtMs: null,
            hasRefreshToken: true,
          }),
        refreshCredential: async () => {
          refreshes += 1;
          throw new Error("unknown expiry must not invoke the vendor refresh wake");
        },
        fetchUsage: async () => {
          fetches += 1;
          throw Object.assign(new Error(`oauth/usage responded ${status}`), {
            quotaAbsenceReason: "auth_revoked" as const,
          });
        },
        now: () => new Date("2026-07-18T00:00:00Z"),
      });
      expect(fetches).toBe(1);
      expect(refreshes).toBe(0);
      const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
      expect(nativeAbsence).toMatchObject({ reason: "refresh_failed" });
      expect(nativeAbsence?.detail).toContain("freshness is unknown");
      expect(nativeAbsence?.detail).not.toContain(String(status));
    },
  );

  it("automatically refreshes an expired credential before reading quota", async () => {
    let fetches = 0;
    let refreshes = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          accessToken: "access-secret-needle",
          expiresAtMs: Date.parse("2026-07-17T23:59:59Z"),
          hasRefreshToken: true,
        }),
      refreshCredential: async () => {
        refreshes += 1;
        return oauthCredential({
          accessToken: "fresh-token",
          expiresAtMs: Date.parse("2026-07-18T08:00:00Z"),
          hasRefreshToken: true,
        });
      },
      fetchUsage: async (accessToken) => {
        fetches += 1;
        expect(accessToken).toBe("fresh-token");
        return LIVE_USAGE;
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(refreshes).toBe(1);
    expect(fetches).toBe(1);
    expect(result.snapshots).toHaveLength(1);
    expect(result.absences ?? []).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("access-secret-needle");
  });

  it("keeps quota unknown when automatic refresh fails, without exposing the access token", async () => {
    let fetches = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          accessToken: "access-secret-needle",
          expiresAtMs: Date.parse("2026-07-17T23:59:59Z"),
          hasRefreshToken: true,
        }),
      refreshCredential: async () => {
        throw new Error(
          "Claude Code's automatic OAuth refresh did not publish a fresh access token",
        );
      },
      fetchUsage: async () => {
        fetches += 1;
        return LIVE_USAGE;
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(fetches).toBe(0);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence).toMatchObject({ reason: "refresh_failed" });
    expect(nativeAbsence?.detail).toContain("automatic OAuth refresh");
    expect(nativeAbsence?.detail).not.toContain("access-secret-needle");
  });

  it("refreshes proactively inside Claude Code's five-minute window", async () => {
    let refreshes = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          expiresAtMs: Date.parse("2026-07-18T00:04:00Z"),
          hasRefreshToken: true,
        }),
      refreshCredential: async () => {
        refreshes += 1;
        return oauthCredential({ expiresAtMs: Date.parse("2026-07-18T08:00:00Z") });
      },
      fetchUsage: async () => LIVE_USAGE,
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(refreshes).toBe(1);
    expect(result.snapshots).toHaveLength(1);
  });

  it("falls back to a still-valid near-expiry token when the proactive wake fails", async () => {
    let fetches = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          accessToken: "still-valid",
          expiresAtMs: Date.parse("2026-07-18T00:04:00Z"),
          hasRefreshToken: true,
        }),
      refreshCredential: async () => {
        throw new Error("vendor helper exited early");
      },
      fetchUsage: async (accessToken) => {
        fetches += 1;
        expect(accessToken).toBe("still-valid");
        return LIVE_USAGE;
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(fetches).toBe(1);
    expect(result.snapshots).toHaveLength(1);
    expect(result.absences ?? []).toEqual([]);
  });

  it.each([401, 403])(
    "keeps a token that expires during a failed proactive refresh out of auth_revoked (%i)",
    async (status) => {
      let fetches = 0;
      const times = ["2026-07-18T00:00:00Z", "2026-07-18T00:00:00Z", "2026-07-18T00:05:00Z"];
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async () =>
          oauthCredential({
            accessToken: "access-secret-needle",
            expiresAtMs: Date.parse("2026-07-18T00:04:00Z"),
            hasRefreshToken: true,
          }),
        refreshCredential: async () => {
          throw new Error("vendor helper exited early");
        },
        fetchUsage: async () => {
          fetches += 1;
          throw Object.assign(new Error(`oauth/usage responded ${status}`), {
            quotaAbsenceReason: "auth_revoked" as const,
          });
        },
        now: () => new Date(times.shift() ?? "2026-07-18T00:05:00Z"),
      });
      expect(fetches).toBe(1);
      const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
      expect(nativeAbsence).toMatchObject({ reason: "refresh_failed" });
      expect(nativeAbsence?.detail).toContain("freshness is unknown");
      expect(nativeAbsence?.detail).not.toContain(String(status));
      expect(nativeAbsence?.detail).not.toContain("access-secret-needle");
    },
  );

  it("never falls back while refresh-helper termination remains unconfirmed", async () => {
    let fetches = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          expiresAtMs: Date.parse("2026-07-18T00:04:00Z"),
          hasRefreshToken: true,
        }),
      refreshCredential: async () => {
        throw Object.assign(new Error("vendor helper termination could not be confirmed"), {
          code: CLAUDE_AUTH_REFRESH_TERMINATION_UNCONFIRMED,
        });
      },
      fetchUsage: async () => {
        fetches += 1;
        return LIVE_USAGE;
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(fetches).toBe(0);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence).toMatchObject({ reason: "refresh_failed" });
    expect(nativeAbsence?.detail).toContain("termination could not be confirmed");
  });

  it("retains the real-response auth verdict for an expired token without a refresh token", async () => {
    let fetches = 0;
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () =>
        oauthCredential({
          expiresAtMs: Date.parse("2026-07-17T23:59:59Z"),
          hasRefreshToken: false,
        }),
      fetchUsage: async () => {
        fetches += 1;
        throw Object.assign(new Error("oauth/usage responded 401"), {
          quotaAbsenceReason: "auth_revoked" as const,
        });
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(fetches).toBe(1);
    expect(result.absences?.find((a) => a.subject.subject_id === null)?.reason).toBe(
      "auth_revoked",
    );
  });

  it("claims a typed rate_limited absence carrying the vendor Retry-After floor on a 429", async () => {
    // A 429 throttles the POLL, not the plan (owner decision 7=A): the reason
    // stays distinct from refresh_failed so the pacer can honor the vendor
    // floor, and the absence carries retry_after_ms only when the header came.
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => oauthCredential(),
      fetchUsage: async () => {
        throw Object.assign(new Error("oauth/usage responded 429"), {
          quotaAbsenceReason: "rate_limited" as const,
          retryAfterMs: 90_000,
        });
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("rate_limited");
    expect(nativeAbsence?.retry_after_ms).toBe(90_000);
  });

  it("a 429 without Retry-After stays rate_limited with no fabricated floor", async () => {
    // Anthropic does not always send Retry-After; the absence then simply
    // omits retry_after_ms (absence of the floor is stated, never invented).
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => oauthCredential(),
      fetchUsage: async () => {
        throw Object.assign(new Error("oauth/usage responded 429"), {
          quotaAbsenceReason: "rate_limited" as const,
          retryAfterMs: null,
        });
      },
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("rate_limited");
    expect(nativeAbsence).not.toHaveProperty("retry_after_ms");
  });

  it("parses RFC 9110 Retry-After forms: delta-seconds, HTTP-date, junk, absent", async () => {
    const { parseRetryAfterHeaderMs } = await import("./claude-oauth-fetch.js");
    const now = Date.parse("2026-07-18T00:00:00Z");
    expect(parseRetryAfterHeaderMs("60", now)).toBe(60_000);
    expect(parseRetryAfterHeaderMs(" 5 ", now)).toBe(5_000);
    expect(parseRetryAfterHeaderMs("Sat, 18 Jul 2026 00:02:00 GMT", now)).toBe(120_000);
    // A past HTTP-date clamps to zero rather than going negative.
    expect(parseRetryAfterHeaderMs("Fri, 17 Jul 2026 23:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterHeaderMs("soon", now)).toBeNull();
    expect(parseRetryAfterHeaderMs(null, now)).toBeNull();
  });

  it("clamps oversized or overflowing Retry-After at the parser (observation kept, never schema-invalid)", async () => {
    // An unrepresentable number reaching the schema would invalidate the whole
    // typed rate_limited observation and drop the refresher's batch — the
    // floor would never arm exactly when the vendor asked for the longest
    // pause. The parser owns the bound: 7 days.
    const { parseRetryAfterHeaderMs } = await import("./claude-oauth-fetch.js");
    const now = Date.parse("2026-07-18T00:00:00Z");
    const sevenDaysMs = 7 * 24 * 60 * 60_000;
    // Delta-seconds far past the ceiling (finite but enormous).
    expect(parseRetryAfterHeaderMs("999999999", now)).toBe(sevenDaysMs);
    // Delta-seconds that overflow to a non-finite product.
    expect(parseRetryAfterHeaderMs("9".repeat(400), now)).toBe(sevenDaysMs);
    // Far-future HTTP-date.
    expect(parseRetryAfterHeaderMs("Fri, 01 Jan 9999 00:00:00 GMT", now)).toBe(sevenDaysMs);
    // A valid long floor above the OLD 24h cap is honored in full.
    expect(parseRetryAfterHeaderMs(String(3 * 24 * 60 * 60), now)).toBe(3 * 24 * 60 * 60_000);
    // Everything the schema sees stays a safe non-negative integer.
    expect(Number.isSafeInteger(parseRetryAfterHeaderMs("9".repeat(400), now))).toBe(true);
  });

  it("a post-migration refresh cycle produces no null subject and never double-probes the migrated store", async () => {
    // The retired engine-default subject must not resurrect on refresh: a
    // migrated harness's former default store IS its auto-registered row, so
    // exactly ONE candidate (the row) probes that store.
    const { mkdirSync, writeFileSync: writeSync } = await import("node:fs");
    const dir = (await import("node:fs")).mkdtempSync(join(tmpdir(), "claudexor-oauth-mig-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { accountsMigrationFilePath } = await import("./accounts-unified-migration.js");
      const { defaultNativeClaudeConfigDir } = await import("@claudexor/harness-claude");
      const { updateGlobalConfig } = await import("@claudexor/config");
      const nativeDir = defaultNativeClaudeConfigDir();
      mkdirSync(nativeDir, { recursive: true });
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      writeSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          claude: {
            phase: "completed",
            row_id: "claude-default",
            legacy_aliases: [null],
            locator: nativeDir,
            backup_ref: null,
          },
        }),
      );
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [
          {
            profile_id: "claude-default",
            harness_id: "claude",
            display_name: "migrated",
            credential_kind: "config_dir_login",
            isolation_locator: nativeDir,
            secret_ref: null,
            enabled: true,
            created_at: null,
          },
        ],
      }));
      const probedDirs: string[] = [];
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async (configDir) => {
          probedDirs.push(configDir);
          return oauthCredential();
        },
        fetchUsage: async () => LIVE_USAGE,
        now: () => new Date("2026-08-18T00:00:00Z"),
      });
      // One probe of the migrated store — the row's, never a null duplicate.
      const { canonicalProfileConfigDir } = await import("@claudexor/harness-claude");
      expect(probedDirs).toEqual([canonicalProfileConfigDir(nativeDir)]);
      expect(result.snapshots.map((s) => s.subject.subject_id)).toEqual(["claude-default"]);
      expect(result.snapshots.some((s) => s.subject.subject_id === null)).toBe(false);
      expect(result.absences ?? []).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-present a token that already returned429 through another row in the same cycle", async () => {
    // These rows present the same token, so one refusal paces every alias.
    // The alias was not itself probed: retain the distinct skip reason.
    const { mkdirSync, writeFileSync: writeSync, mkdtempSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "claudexor-oauth-429-"));
    const prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    try {
      const { accountsMigrationFilePath } = await import("./accounts-unified-migration.js");
      const { updateGlobalConfig } = await import("@claudexor/config");
      mkdirSync(join(accountsMigrationFilePath(), ".."), { recursive: true });
      // Mark claude migrated so no null-subject candidate precedes the rows.
      writeSync(
        accountsMigrationFilePath(),
        JSON.stringify({
          claude: {
            phase: "completed",
            row_id: "acc-a",
            legacy_aliases: [null],
            locator: join(dir, "claude-a"),
            backup_ref: null,
          },
        }),
      );
      const rowOf = (id: string, locator: string) => ({
        profile_id: id,
        harness_id: "claude",
        display_name: id,
        credential_kind: "config_dir_login" as const,
        isolation_locator: locator,
        secret_ref: null,
        enabled: true,
        created_at: null,
      });
      updateGlobalConfig((config) => ({
        ...config,
        credential_profiles: [
          rowOf("acc-a", join(dir, "claude-a")),
          rowOf("acc-b", join(dir, "claude-b")),
          rowOf("acc-c", join(dir, "claude-c")),
        ],
      }));
      let fetches = 0;
      const result = await refreshClaudeOauthUsageQuota({
        readCredential: async () => oauthCredential(),
        fetchUsage: async () => {
          fetches += 1;
          throw Object.assign(new Error("oauth/usage responded 429"), {
            quotaAbsenceReason: "rate_limited" as const,
            retryAfterMs: 45_000,
          });
        },
        now: () => new Date("2026-08-28T00:00:00Z"),
      });
      expect(fetches).toBe(1);
      expect(
        result.absences?.map((absence) => [absence.subject.subject_id, absence.reason]),
      ).toEqual([
        ["acc-a", "rate_limited"],
        ["acc-b", "probe_skipped_rate_limited"],
        ["acc-c", "probe_skipped_rate_limited"],
      ]);
      expect(result.absences?.[0]?.retry_after_ms).toBe(45_000);
      expect(result.absences?.slice(1).every((a) => a.retry_after_ms === undefined)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
      else process.env.CLAUDEXOR_CONFIG_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims a refresh_failed absence when an HTTP-200 body carries no parseable quota windows (BACKLOG Q-a)", async () => {
    // An endpoint that answers 200 but with a body that maps to zero quota
    // windows must yield a typed absence, not silent emptiness — the registry
    // needs the observation to back off instead of re-polling forever.
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => oauthCredential(),
      fetchUsage: async () => ({ unrelated: "payload", limits: [] }),
      now: () => new Date("2026-07-18T00:00:00Z"),
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("parseable quota windows");
  });
});

describe("claude credential-file store off macOS (Linux quota parity)", () => {
  // W-h: reap the temp config dirs this suite creates instead of leaking them.
  const __reapDirs: string[] = [];
  const configDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudexor-cred-"));
    __reapDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of __reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  // Redaction bait is assembled at runtime so no token-like literal ever
  // lands in the source tree (secret-scan CI step, INV-146).
  const bait = ["sk", "ant", "oat01", "b".repeat(24)].join("-");

  it("reads both vendor credential shapes from .credentials.json", async () => {
    const flat = await configDir();
    await writeFile(
      join(flat, ".credentials.json"),
      JSON.stringify({ accessToken: bait, subscriptionType: "max" }),
    );
    await expect(readClaudeOauthCredential(flat, "linux")).resolves.toEqual({
      accessToken: bait,
      subscriptionType: "max",
      expiresAtMs: null,
      hasRefreshToken: false,
    });

    const wrapped = await configDir();
    await writeFile(
      join(wrapped, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: bait,
          subscriptionType: "pro",
          expiresAt: 1_787_011_300_000,
          refreshToken: "refresh-secret",
        },
      }),
    );
    await expect(readClaudeOauthCredential(wrapped, "linux")).resolves.toEqual({
      accessToken: bait,
      subscriptionType: "pro",
      expiresAtMs: 1_787_011_300_000,
      hasRefreshToken: true,
    });
  });

  it("a missing credential file is the honest logged-out null, not an error", async () => {
    await expect(readClaudeOauthCredential(await configDir(), "linux")).resolves.toBeNull();
  });

  it("darwin stays keychain-only: a present credential file is never read there", async () => {
    // Owner lock Q2=a. A fresh temp dir can have no keychain item (its name
    // hashes the path), and off macOS the `security` binary does not exist —
    // so on EVERY platform a darwin-gated read must ignore the file → null.
    const dir = await configDir();
    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({ accessToken: bait, subscriptionType: "max" }),
    );
    await expect(readClaudeOauthCredential(dir, "darwin")).resolves.toBeNull();
  });

  it("an unparseable credential file throws a tagged fault with no file bytes", async () => {
    const dir = await configDir();
    await writeFile(join(dir, ".credentials.json"), `{"refreshToken":"${bait}"`);
    const failure = await readClaudeOauthCredential(dir, "linux").then(
      () => null,
      (error: unknown) => error as Error & { quotaAbsenceReason?: string },
    );
    expect(failure).not.toBeNull();
    expect(failure?.quotaAbsenceReason).toBe("refresh_failed");
    expect(failure?.message).not.toContain(bait);
    expect(failure?.message).not.toContain("refreshToken");
  });

  it("an unreadable credential file throws a tagged fault naming only the error class", async () => {
    const dir = await configDir();
    await mkdir(join(dir, ".credentials.json"));
    const failure = await readClaudeOauthCredential(dir, "linux").then(
      () => null,
      (error: unknown) => error as Error & { quotaAbsenceReason?: string },
    );
    expect(failure?.quotaAbsenceReason).toBe("refresh_failed");
    expect(failure?.message).toContain("EISDIR");
  });

  it("refresher states the file-store detail off macOS and keychain detail on it", async () => {
    const linux = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "linux",
    });
    const linuxAbsence = linux.absences?.find((a) => a.subject.subject_id === null);
    expect(linuxAbsence?.reason).toBe("not_logged_in");
    expect(linuxAbsence?.detail).toContain("credential file");
    expect(linuxAbsence?.detail).not.toContain("keychain");

    const darwin = await refreshClaudeOauthUsageQuota({
      readCredential: async () => null,
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "darwin",
    });
    const darwinAbsence = darwin.absences?.find((a) => a.subject.subject_id === null);
    expect(darwinAbsence?.reason).toBe("not_logged_in");
    expect(darwinAbsence?.detail).toContain("keychain");
  });

  it("refresher converts a tagged store fault into a refresh_failed absence, never a throw", async () => {
    const result = await refreshClaudeOauthUsageQuota({
      readCredential: async () => {
        throw Object.assign(new Error("credential file unreadable (EACCES)"), {
          quotaAbsenceReason: "refresh_failed" as const,
        });
      },
      fetchUsage: async () => {
        throw new Error("should not be called");
      },
      now: () => new Date("2026-07-21T00:00:00Z"),
      platform: "linux",
    });
    expect(result.snapshots).toEqual([]);
    const nativeAbsence = result.absences?.find((a) => a.subject.subject_id === null);
    expect(nativeAbsence?.reason).toBe("refresh_failed");
    expect(nativeAbsence?.detail).toContain("EACCES");
  });
});

describe("remembered vendor rejections (#263: a dead token is not re-presented on background cycles)", () => {
  // Expiry a day out: no test instant below falls inside Claude Code's
  // five-minute refresh window, so the vendor refresh wake is never reached.
  const fresh = () =>
    oauthCredential({ expiresAtMs: Date.parse("2026-07-19T00:00:00Z"), hasRefreshToken: true });
  const revoke = (fetches: { n: number }) => async () => {
    fetches.n += 1;
    throw Object.assign(new Error("oauth/usage responded 401"), {
      quotaAbsenceReason: "auth_revoked" as const,
    });
  };
  const t0 = Date.parse("2026-07-18T00:00:00Z");

  beforeEach(() => forgetClaudeOauthRejections());
  afterEach(() => forgetClaudeOauthRejections());

  it("re-states the typed absence without HTTP until the token changes", async () => {
    const fetches = { n: 0 };
    const first = await refreshClaudeOauthUsageQuota(
      { readCredential: async () => fresh(), fetchUsage: revoke(fetches), now: () => new Date(t0) },
      { foreground: false },
    );
    expect(first.absences?.[0]).toMatchObject({ reason: "auth_revoked" });
    expect(fetches.n).toBe(1);

    const second = await refreshClaudeOauthUsageQuota(
      {
        readCredential: async () => fresh(),
        fetchUsage: revoke(fetches),
        now: () => new Date(t0 + 5 * 60_000),
      },
      { foreground: false },
    );
    expect(fetches.n).toBe(1);
    expect(second.snapshots).toEqual([]);
    expect(second.absences?.[0]).toMatchObject({ reason: "auth_revoked" });
    expect(second.absences?.[0]?.detail).toContain("not re-asked");
    expect(second.absences?.[0]?.detail).toContain("2026-07-18T00:00:00.000Z");
    // The re-stated row carries the vendor's real rejection instant, not this
    // cycle's clock: downstream "revoked at" stays honest and the projection
    // signature does not churn every cycle.
    expect(second.absences?.[0]?.observed_at).toBe("2026-07-18T00:00:00.000Z");

    // A re-login anywhere changes the token bytes: the new token is asked.
    const relogged = await refreshClaudeOauthUsageQuota(
      {
        readCredential: async () => ({ ...fresh(), accessToken: "tok-new" }),
        fetchUsage: async () => LIVE_USAGE,
        now: () => new Date(t0 + 10 * 60_000),
      },
      { foreground: false },
    );
    expect(relogged.snapshots).toHaveLength(1);
    expect(relogged.absences ?? []).toEqual([]);
  });

  it("an explicit foreground refresh always asks the vendor, and a success clears the memory", async () => {
    const fetches = { n: 0 };
    const deps = { readCredential: async () => fresh(), now: () => new Date(t0) };
    await refreshClaudeOauthUsageQuota(
      { ...deps, fetchUsage: revoke(fetches) },
      { foreground: false },
    );
    expect(fetches.n).toBe(1);
    const foreground = await refreshClaudeOauthUsageQuota(
      {
        ...deps,
        fetchUsage: async () => {
          fetches.n += 1;
          return LIVE_USAGE;
        },
      },
      { foreground: true },
    );
    expect(fetches.n).toBe(2);
    expect(foreground.snapshots).toHaveLength(1);
    // The token works again: the next background cycle asks normally.
    await refreshClaudeOauthUsageQuota(
      { ...deps, fetchUsage: revoke(fetches) },
      { foreground: false },
    );
    expect(fetches.n).toBe(3);
  });

  it("re-asks after the safety TTL and after a daemon-side credential change", async () => {
    const fetches = { n: 0 };
    const deps = { readCredential: async () => fresh(), fetchUsage: revoke(fetches) };
    await refreshClaudeOauthUsageQuota({ ...deps, now: () => new Date(t0) }, { foreground: false });
    await refreshClaudeOauthUsageQuota(
      { ...deps, now: () => new Date(t0 + 6 * 60 * 60_000 - 1) },
      { foreground: false },
    );
    expect(fetches.n).toBe(1);
    await refreshClaudeOauthUsageQuota(
      { ...deps, now: () => new Date(t0 + 6 * 60 * 60_000) },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
    forgetClaudeOauthRejections();
    await refreshClaudeOauthUsageQuota(
      { ...deps, now: () => new Date(t0 + 6 * 60 * 60_000 + 60_000) },
      { foreground: false },
    );
    expect(fetches.n).toBe(3);
  });

  it("a cycle that started before a credential change cannot restore a cleared rejection", async () => {
    // The mutation hook clears the memory while a poll is still waiting on the
    // vendor; the obsolete 401 must not be remembered (the same fence the
    // registry's credential generation gives its own writes).
    const fetches = { n: 0 };
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const inFlight = refreshClaudeOauthUsageQuota(
      {
        readCredential: async () => fresh(),
        fetchUsage: async () => {
          fetches.n += 1;
          started();
          await gate;
          throw Object.assign(new Error("oauth/usage responded 401"), {
            quotaAbsenceReason: "auth_revoked" as const,
          });
        },
        now: () => new Date(t0),
      },
      { foreground: false },
    );
    await fetchStarted;
    forgetClaudeOauthRejections();
    release();
    expect((await inFlight).absences?.[0]).toMatchObject({ reason: "auth_revoked" });
    // The next background cycle asks the vendor again instead of trusting the
    // stale verdict.
    await refreshClaudeOauthUsageQuota(
      {
        readCredential: async () => fresh(),
        fetchUsage: revoke(fetches),
        now: () => new Date(t0 + 60_000),
      },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
  });

  it("re-verifies at most one expired remembered token per cycle, oldest first", async () => {
    const fetches = { n: 0 };
    const deps = { fetchUsage: revoke(fetches) };
    // Token A rejected at t0; the profile then rotates to token B, rejected a
    // minute later (A's hash is now orphaned — never presented again).
    await refreshClaudeOauthUsageQuota(
      { ...deps, readCredential: async () => fresh(), now: () => new Date(t0) },
      { foreground: false },
    );
    await refreshClaudeOauthUsageQuota(
      {
        ...deps,
        readCredential: async () => ({ ...fresh(), accessToken: "tok-rotated" }),
        now: () => new Date(t0 + 60_000),
      },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
    // Both memories are past the TTL: the cycle releases only the OLDEST
    // (orphaned A) — B is still re-stated without HTTP, no burst.
    const restated = await refreshClaudeOauthUsageQuota(
      {
        ...deps,
        readCredential: async () => ({ ...fresh(), accessToken: "tok-rotated" }),
        now: () => new Date(t0 + 6 * 60 * 60_000 + 60_000),
      },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
    expect(restated.absences?.[0]).toMatchObject({ reason: "auth_revoked" });
    // The next cycle releases B: one re-verification per cycle.
    await refreshClaudeOauthUsageQuota(
      {
        ...deps,
        readCredential: async () => ({ ...fresh(), accessToken: "tok-rotated" }),
        now: () => new Date(t0 + 6 * 60 * 60_000 + 120_000),
      },
      { foreground: false },
    );
    expect(fetches.n).toBe(3);
  });

  it("treats a wall-clock step backwards as an expired memory, never as a longer one", async () => {
    const fetches = { n: 0 };
    const deps = { readCredential: async () => fresh(), fetchUsage: revoke(fetches) };
    await refreshClaudeOauthUsageQuota({ ...deps, now: () => new Date(t0) }, { foreground: false });
    await refreshClaudeOauthUsageQuota(
      { ...deps, now: () => new Date(t0 - 7 * 60 * 60_000) },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
  });

  it("does not remember an unproven rejection; a legacy call without a cycle kind is a background poll", async () => {
    const fetches = { n: 0 };
    // Unknown expiry + refresh token: the rejection is refresh_failed, not a
    // verdict about the token — it stays re-presented after the vendor refresh.
    const unproven = {
      readCredential: async () => oauthCredential({ expiresAtMs: null, hasRefreshToken: true }),
    };
    await refreshClaudeOauthUsageQuota(
      { ...unproven, fetchUsage: revoke(fetches), now: () => new Date(t0) },
      { foreground: false },
    );
    await refreshClaudeOauthUsageQuota(
      { ...unproven, fetchUsage: revoke(fetches), now: () => new Date(t0 + 60_000) },
      { foreground: false },
    );
    expect(fetches.n).toBe(2);
    // A caller that does not say which kind of cycle it is (legacy embedders)
    // is treated as a background poll: a proven rejection is remembered.
    const proven = { readCredential: async () => fresh(), fetchUsage: revoke(fetches) };
    await refreshClaudeOauthUsageQuota({ ...proven, now: () => new Date(t0) });
    await refreshClaudeOauthUsageQuota({ ...proven, now: () => new Date(t0 + 60_000) });
    expect(fetches.n).toBe(3);
  });
});
