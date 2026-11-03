import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import { canonicalProfileConfigDir } from "@claudexor/harness-claude";
import { refreshClaudeOauthUsageQuota, forgetClaudeOauthRejections } from "./claude-oauth-usage.js";
import { accountManagementTarget } from "./account-management.js";
import { refreshCodexQuota } from "./codex-quota-source.js";

const roots: string[] = [];
afterEach(() => {
  forgetClaudeOauthRejections();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function fixture(harness = "claude") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "account-source-test-")));
  roots.push(root);
  process.env.CLAUDEXOR_CONFIG_DIR = root;
  const profiles = [`${harness}-default`, "disabled", "sibling"].map((id) => ({
    profile_id: id,
    harness_id: harness,
    display_name: id,
    credential_kind: "config_dir_login" as const,
    isolation_locator: join(root, "profiles", id),
    secret_ref: null,
    enabled: id !== "disabled",
    created_at: null,
  }));
  for (const row of profiles) mkdirSync(row.isolation_locator, { recursive: true });
  updateGlobalConfig((config) => ({ ...config, credential_profiles: profiles }));
  return { root, profiles };
}
const at = new Date("2026-10-09T12:00:00Z");
const usage = {
  five_hour: { utilization: 25, resets_at: "2026-10-09T17:00:00Z" },
  extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 1000, decimal_places: 2 },
  cedar_ember: { eligible: true, grants: [] },
};
describe("exact native resource source coverage", () => {
  it.each(["claude-default", "disabled"])(
    "refreshes only %s, including a disabled portable account",
    async (id) => {
      const { profiles } = fixture();
      const target = { harness: "claude", profile_id: id };
      const readCredential = vi.fn(async (_configDir: string) => ({
        accessToken: "fixture-only",
        subscriptionType: "max",
        expiresAtMs: null,
        hasRefreshToken: false,
      }));
      const fetchUsage = vi.fn(async () => usage);
      const fetchRefill = vi.fn(async (_configDir: string) => ({
        juniper_tide: {
          eligible: false,
          available: false,
          arm: "control",
          ineligible_reason: "surface",
        },
      }));
      const fetchPrepaid = vi.fn(async () => {
        throw Object.assign(new Error("fixture 403"), { status: 403 });
      });
      const result = await refreshClaudeOauthUsageQuota(
        {
          readCredential,
          fetchUsage,
          fetchRefill,
          fetchPrepaid,
          readOrganization: async () => ({
            organizationUuid: "org-fixture",
            accountUuid: "user-fixture",
          }),
          now: () => at,
        },
        { foreground: true, target },
      );
      expect(accountManagementTarget(target).profile.profile_id).toBe(id);
      expect(readCredential.mock.calls[0]?.[0]).toBe(
        canonicalProfileConfigDir(profiles.find((p) => p.profile_id === id)!.isolation_locator),
      );
      expect(readCredential).toHaveBeenCalledOnce();
      expect(fetchUsage).toHaveBeenCalledOnce();
      expect(fetchRefill).toHaveBeenCalledOnce();
      expect(fetchPrepaid).toHaveBeenCalledOnce();
      expect(result.snapshots.map((s) => s.subject.subject_id)).toEqual([id]);
      expect(result.absences).toEqual([]);
      expect(result.resources?.[0]).toMatchObject({
        balances: { value: null, last_error: "balance_read_unavailable" },
        spending: { freshness: "fresh" },
        resets: {
          value: [
            { id: "claude_granted" },
            {
              id: "claude_session_refill",
              reason: "This reset is unavailable on this client surface",
            },
          ],
        },
      });
    },
  );
  it("uses the existing background usage read without extra prepaid or refill fan-out", async () => {
    fixture();
    const readCredential = vi.fn(async (_configDir: string) => ({
      accessToken: "fixture",
      subscriptionType: null,
      expiresAtMs: null,
      hasRefreshToken: false,
    }));
    const fetchRefill = vi.fn();
    const fetchPrepaid = vi.fn();
    const result = await refreshClaudeOauthUsageQuota(
      { readCredential, fetchUsage: async () => usage, fetchRefill, fetchPrepaid, now: () => at },
      { foreground: false, target: { harness: "claude", profile_id: "claude-default" } },
    );
    expect(fetchRefill).not.toHaveBeenCalled();
    expect(fetchPrepaid).not.toHaveBeenCalled();
    expect(result.resources?.[0]).not.toHaveProperty("balances");
  });
  it("marks a failed main usage read unavailable without making old facets current", async () => {
    fixture();
    const result = await refreshClaudeOauthUsageQuota(
      { readCredential: async () => null, fetchUsage: vi.fn(), now: () => at },
      { foreground: true, target: { harness: "claude", profile_id: "disabled" } },
    );
    expect(result.resources?.[0]).toMatchObject({
      target: { profile_id: "disabled" },
      resets: { value: null, freshness: "unknown", last_error: "not_logged_in" },
    });
  });
  it.each(["codex-default", "disabled"])(
    "addresses Codex %s without inspecting another native store",
    async (id) => {
      fixture("codex");
      const target = { harness: "codex", profile_id: id };
      const spawn = vi.fn();
      const result = await refreshCodexQuota({ spawn, cycle: { foreground: true, target } });
      expect(accountManagementTarget(target).profile.profile_id).toBe(id);
      expect(result.absences?.map((a) => a.subject.subject_id)).toEqual([id]);
      expect(spawn).not.toHaveBeenCalled();
      expect(result.resources?.[0]?.balances?.last_error).toBe("not_logged_in");
    },
  );
});
