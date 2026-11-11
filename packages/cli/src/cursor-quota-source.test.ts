import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialProfile } from "@claudexor/schema";
import { refreshCursorQuota } from "./cursor-quota-source.js";
import { parseCursorResources } from "./cursor-quota-parse.js";
import { CursorDashboardError } from "@claudexor/harness-cursor";
import { mergeResources } from "../../daemon/src/quota-resources.js";
import type { QuotaRefreshDiagnostic } from "./quota-refresh-diagnostics.js";
const team = JSON.parse(
  readFileSync(new URL("./test-support/cursor-usage-team.json", import.meta.url), "utf8"),
);
const personal = JSON.parse(
  readFileSync(new URL("./test-support/cursor-usage-personal.json", import.meta.url), "utf8"),
);
const at = new Date("2026-10-15T13:04:58Z");
const profile = (id: string, enabled = true) =>
  CredentialProfile.parse({
    profile_id: id,
    display_name: id,
    harness_id: "cursor",
    credential_kind: "config_dir_login",
    isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", id),
    enabled,
  });
describe("Cursor dashboard resource-only refresh", () => {
  it("labels remaining separately from spending, including zero, unknown and team scope", () => {
    const out = parseCursorResources(team.data, "fixture", at);
    expect(out.balances!.value!.map((r) => r.label)).toEqual([
      "Personal included remaining",
      "Personal on-demand remaining",
      "Team pool on-demand remaining",
    ]);
    expect(out.spending!.value!.slice(0, 3).map((r) => r.label)).toEqual([
      "Personal included usage",
      "Personal on-demand spending",
      "Team pool on-demand spending",
    ]);
    expect(out.balances!.value!.map((r) => r.amount)).toEqual([
      "0",
      null,
      String(team.data.teamUsage.onDemand.remaining),
    ]);
  });
  it("anchors a slow 429 Retry-After floor to the response, not request start", async () => {
    let clock = at.getTime();
    const noteRateLimited = vi.fn();
    const result = await refreshCursorQuota(
      {
        profiles: [profile("slow")],
        now: () => new Date(clock),
        request: async () => {
          clock += 7000;
          throw new CursorDashboardError("http_refused", 429, 30000);
        },
      },
      {
        foreground: false,
        pacing: { noteRateLimited, cooldownUntil: () => null, bindCredentials: () => {} },
      },
    );
    expect(noteRateLimited).toHaveBeenCalledWith(
      expect.objectContaining({ subject_id: "slow" }),
      at.getTime() + 7000,
      30000,
    );
    expect(result.resources![0]!.balances!.last_attempt_at).toBe(new Date(clock).toISOString());
  });
  it("reports bounded usage_http start/success/failure without provider bodies or changing results", async () => {
    const diagnostics: QuotaRefreshDiagnostic[] = [];
    const diagnostic = (record: QuotaRefreshDiagnostic) => diagnostics.push(record);
    const good = await refreshCursorQuota({
      profiles: [profile("a")],
      request: async () => team.data,
      now: () => at,
      diagnostic,
    });
    const bad = await refreshCursorQuota({
      profiles: [profile("a")],
      request: async () => {
        throw new CursorDashboardError("http_refused", 429, 30000);
      },
      now: () => at,
      diagnostic,
    });
    expect(good.resources![0]!.balances!.value).not.toBeNull();
    expect(bad.resources![0]!.balances!.last_error).toBe("cursor_dashboard_http_refused_429");
    expect(diagnostics.map((d) => [d.source, d.stage, d.outcome])).toEqual([
      ["cursor_dashboard", "usage_http", "started"],
      ["cursor_dashboard", "usage_http", "succeeded"],
      ["cursor_dashboard", "usage_http", "started"],
      ["cursor_dashboard", "usage_http", "failed"],
    ]);
    expect(diagnostics[0]!.operationId).toBe(diagnostics[1]!.operationId);
    expect(diagnostics[2]!.operationId).toBe(diagnostics[3]!.operationId);
    expect(diagnostics[3]).toMatchObject({
      profileId: "a",
      foreground: false,
      reason: "cursor_dashboard_http_refused_429",
      httpStatus: 429,
      retryAfterMs: 30000,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /Cookie|accessToken|individualUsage|isolation_locator/,
    );
    await expect(
      refreshCursorQuota({
        profiles: [profile("a")],
        request: async () => team.data,
        diagnostic: () => {
          throw new Error("sink failed");
        },
      }),
    ).resolves.toMatchObject({ snapshots: [] });
  });
  it.each(["oops", -1, Number.NaN, Number.POSITIVE_INFINITY, { value: 1 }])(
    "malformed present amount does not replace known values with fresh null (%j)",
    (invalid) => {
      const raw = structuredClone(team.data);
      raw.individualUsage.plan.used = invalid;
      const prior = mergeResources(undefined, parseCursorResources(team.data, "fixture", at));
      const update = parseCursorResources(raw, "fixture", new Date(at.getTime() + 1000));
      expect(update.balances!.last_error).toBe("invalid_dashboard_amount");
      const after = mergeResources(prior, update);
      expect(after.spending.value).toEqual(prior.spending.value);
      expect(after.spending.observed_at).toBe(prior.spending.observed_at);
      expect(after.spending.freshness).toBe("stale");
    },
  );
  it.each(["not a date", {}, 42])(
    "malformed present billing period stays a failed observation (%j)",
    (invalid) => {
      const raw = structuredClone(team.data);
      raw.billingCycleEnd = invalid;
      const update = parseCursorResources(raw, "fixture", at);
      expect(update.spending!.value).toBeNull();
      expect(update.spending!.last_error).toBe("invalid_dashboard_period");
    },
  );
  it("preserves included/on-demand, shared/personal, bonus, units and period without producing quota", async () => {
    const result = await refreshCursorQuota({
      profiles: [profile("team"), profile("personal")],
      request: async (p) => (p.profile_id === "team" ? team.data : personal.data),
      now: () => at,
    });
    expect(result.snapshots).toEqual([]);
    const [t, p] = result.resources!;
    expect(t!.balances!.value!.find((row) => row.id === "cursor_personal_included")).toMatchObject({
      amount: "0",
      scope: "personal",
      usage_kind: "included",
      fee_included: null,
    });
    expect(t!.balances!.value!.find((row) => row.scope === "team")).toMatchObject({
      amount: "65433",
      scope: "team",
      usage_kind: "on_demand",
      currency: "USD",
      unit: "minor",
      decimal_places: 2,
    });
    expect(t!.spending!.value!.find((row) => row.usage_kind === "bonus")).toMatchObject({
      used: "125",
      limit: null,
      period: { starts_at: "2026-10-01T00:00:00.000Z", ends_at: "2026-11-01T00:00:00.000Z" },
    });
    expect(p!.spending!.value!.find((row) => row.usage_kind === "on_demand")).toMatchObject({
      enabled: false,
      used: "0",
      limit: null,
    });
    expect(p!.balances!.value!.some((row) => row.scope === "team")).toBe(false);
  });
  it.each([{}, null, [], { individualUsage: {} }, { error: "not_authenticated" }])(
    "unknown 200 payload stays unknown and retains last-good (%j)",
    (raw) => {
      const old = mergeResources(undefined, parseCursorResources(team.data, "fixture", at));
      const update = parseCursorResources(raw, "fixture", new Date(at.getTime() + 1000));
      expect(update.balances!.value).toBeNull();
      const merged = mergeResources(old, update);
      expect(merged.balances.value).toEqual(old.balances.value);
      expect(merged.balances.observed_at).toEqual(old.balances.observed_at);
      expect(merged.balances.freshness).toBe("stale");
    },
  );
  it("obeys target, enabled, due and poll pacing without touching another account", async () => {
    const request = vi.fn(async (_profile: CredentialProfile) => personal.data);
    const profiles = [
      profile("a"),
      profile("b", false),
      CredentialProfile.parse({
        profile_id: "foreign",
        display_name: "foreign",
        harness_id: "codex",
        credential_kind: "config_dir_login",
        isolation_locator: "/isolated/foreign",
      }),
    ];
    await refreshCursorQuota(
      { profiles, request },
      { foreground: false, shouldRefresh: () => false },
    );
    expect(request).not.toHaveBeenCalled();
    await refreshCursorQuota(
      { profiles, request },
      { foreground: true, target: { harness: "cursor", profile_id: "b" } },
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({ profile_id: "b" });
    request.mockClear();
    await refreshCursorQuota({ profiles, request });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({ profile_id: "a" });
  });
  it("keeps safe failure cause, preserves last good and reports poll429 only to pacing", async () => {
    const noteRateLimited = vi.fn();
    const old = mergeResources(undefined, parseCursorResources(team.data, "a", at));
    const result = await refreshCursorQuota(
      {
        profiles: [profile("a")],
        request: async () => {
          throw new CursorDashboardError("http_refused", 429, 30000);
        },
        now: () => new Date(at.getTime() + 1000),
      },
      {
        foreground: false,
        pacing: { noteRateLimited, cooldownUntil: () => null, bindCredentials: () => {} },
      },
    );
    expect(result.snapshots).toEqual([]);
    expect(result.absences).toBeUndefined();
    expect(noteRateLimited).toHaveBeenCalledWith(
      expect.objectContaining({ subject_id: "a" }),
      at.getTime() + 1000,
      30000,
    );
    const merged = mergeResources(old, result.resources![0]!);
    expect(merged.balances.value).toEqual(old.balances.value);
    expect(merged.balances.last_error).toBe("cursor_dashboard_http_refused_429");
  });
});
