/**
 * The account-resolution owner's ladder predicate (INV-135 unified account
 * model): the legacy default-subject ladder serves ONLY harnesses with no
 * REGISTERED subscription rows. A harness whose rows are all DISABLED must
 * refuse typed (or take the disclosed paid route) — never silently spawn back
 * into the same account through the default store the owner just toggled off.
 */
import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import { resolveAccountForRun, type AccountResolutionContext } from "./account-resolution.js";

function profileRow(overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: "claude-default",
    harness_id: "claude",
    display_name: "claude default login",
    credential_kind: "config_dir_login",
    isolation_locator: "/tmp/claudexor-test/native/claude/default",
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<AccountResolutionContext> = {}): AccountResolutionContext & {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  apiKeyRouteNoted: () => boolean;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let noted = false;
  return {
    harnessId: "claude",
    registry: [],
    policy: { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 },
    snapshots: [],
    quota: { snapshots: [], absences: [] },
    unusable: [],
    probe: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "test probe",
      last_verified_at: null,
    }),
    pinnedProfile: null,
    boundProfileId: null,
    threadId: null,
    model: null,
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "subscription",
    notePoolApiKeyRoute: () => {
      noted = true;
    },
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
    events,
    apiKeyRouteNoted: () => noted,
  };
}

describe("resolveAccountForRun ladder predicate (Enabled-toggle bypass fix)", () => {
  it("fails loud on a pre-existing ambiguous profile set before any readiness probe", async () => {
    let probes = 0;
    const context = ctx({
      harnessId: "agy",
      registry: [
        profileRow({ profile_id: "a", harness_id: "agy" }),
        profileRow({ profile_id: "b", harness_id: "agy" }),
      ],
      profileCardinality: {
        harnessId: "agy",
        platform: "win32",
        policy: {
          identity_scope: "os_user",
          max_enabled_profiles: 1,
          cleanup_owner: "vendor",
        },
        enabledProfileCount: 2,
        ambiguous: true,
      },
      probe: async (profile) => {
        probes += 1;
        return {
          profile_id: profile.profile_id,
          harness_id: profile.harness_id,
          availability: "available",
          verification: "passed",
          verification_source: "vendor",
          detail: "must not run",
          last_verified_at: null,
        };
      },
    });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      status: 409,
      code: "credential_profile_ambiguous",
      requiredActions: ["disable_extra_profiles"],
    });
    expect(probes).toBe(0);
  });

  it("all-rows-disabled refuses typed under subscription — never the legacy ladder", async () => {
    const context = ctx({ registry: [profileRow({ enabled: false })] });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
    });
    expect(context.events.map((event) => event.type)).toContain("route.account.pool_exhausted");
    expect(context.apiKeyRouteNoted()).toBe(false);
  });

  it("all-rows-disabled refuses typed under AUTO too — the paid route is never a silent fallback (Q3=A)", async () => {
    const context = ctx({
      registry: [profileRow({ enabled: false })],
      authPreference: "auto",
    });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
    });
    expect(context.apiKeyRouteNoted()).toBe(false);
    const exhausted = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(exhausted?.payload["fallback"]).toBeNull();
  });

  it("the EXPLICIT api_key preference opts the exhausted pool onto the DISCLOSED paid route", async () => {
    const context = ctx({
      registry: [profileRow({ enabled: false })],
      authPreference: "api_key",
    });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    expect(context.apiKeyRouteNoted()).toBe(true);
    const exhausted = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(exhausted?.payload["fallback"]).toBe("api_key_route");
  });

  it("a harness with NO registered rows keeps the legacy default-subject ladder", async () => {
    const context = ctx({ registry: [] });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    // The ladder path: no pool event, no paid-route note — the default
    // subject serves (unmigrated store).
    expect(context.apiKeyRouteNoted()).toBe(false);
    expect(context.events.map((event) => event.type)).not.toContain("route.account.pool_exhausted");
  });

  it("an api_key row alone does not evict the ladder (the pool holds subscription rows only)", async () => {
    const context = ctx({
      registry: [
        profileRow({ profile_id: "paid", credential_kind: "api_key", secret_ref: "openai:paid" }),
      ],
    });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    expect(context.events.map((event) => event.type)).not.toContain("route.account.pool_exhausted");
  });
});

describe("explicit api_key preference (Q3=A paid election)", () => {
  it("takes the PAID route over a HEALTHY pool of ready rows — never spends subscription quota", async () => {
    const context = ctx({
      registry: [profileRow({ profile_id: "a" }), profileRow({ profile_id: "b" })],
      authPreference: "api_key",
    });
    await expect(resolveAccountForRun(context)).resolves.toBeNull();
    expect(context.apiKeyRouteNoted()).toBe(true);
    expect(context.events.map((event) => event.type)).not.toContain("route.account.pool_selected");
    const disclosed = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(disclosed?.payload["fallback"]).toBe("api_key_route");
  });

  it("an explicit PIN outranks the api_key preference — the pin routes (strict pin doctrine)", async () => {
    const pinned = profileRow({ profile_id: "a" });
    const context = ctx({
      registry: [pinned, profileRow({ profile_id: "b" })],
      pinnedProfile: pinned,
      authPreference: "api_key",
    });
    await expect(resolveAccountForRun(context)).resolves.toBe(pinned);
    expect(context.apiKeyRouteNoted()).toBe(false);
    expect(context.events).toHaveLength(0);
  });

  it("keeps a bound config-dir route during the adapter's bounded stale grace", async () => {
    const bound = profileRow({ profile_id: "bound" });
    const context = ctx({
      registry: [bound, profileRow({ profile_id: "other" })],
      boundProfileId: "bound",
      probe: async (profile) => ({
        profile_id: profile.profile_id,
        harness_id: profile.harness_id,
        availability: "unknown" as const,
        verification: "not_run" as const,
        verification_source: "local_store" as const,
        stale: true,
        stale_age_ms: 42,
        detail: "auth-status probe is stale",
        last_verified_at: null,
      }),
    });
    await expect(resolveAccountForRun(context)).resolves.toBe(bound);
    expect(context.events).toHaveLength(0);
  });

  it("refuses a stale explicit pin when its credential is live-condemned", async () => {
    const pinned = profileRow({ profile_id: "pinned" });
    let probes = 0;
    const context = ctx({
      registry: [pinned],
      pinnedProfile: pinned,
      probe: async (profile) => {
        probes += 1;
        return {
          profile_id: profile.profile_id,
          harness_id: profile.harness_id,
          availability: "unknown" as const,
          verification: "not_run" as const,
          verification_source: "local_store" as const,
          stale: true,
          stale_age_ms: 42,
          detail: "auth-status probe is stale",
          last_verified_at: null,
        };
      },
      unusable: [
        {
          harness_id: "claude",
          profile_id: "pinned",
          model: null,
          code: "auth_revoked",
          source: "vendor_poller",
          detail: "vendor rejected this profile",
          observed_at: "2026-01-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ],
    });
    await expect(resolveAccountForRun(context)).rejects.toThrow(
      /credential is unusable \(auth_revoked;/,
    );
    expect(probes).toBe(0);
  });
});

describe("bound-row A7 unusable ledger (thread stickiness)", () => {
  it("a condemned bound row re-pools with the DISCLOSED lane switch — never re-discovered by spending an attempt", async () => {
    const context = ctx({
      registry: [profileRow({ profile_id: "a" }), profileRow({ profile_id: "b" })],
      boundProfileId: "a",
      unusable: [
        {
          harness_id: "claude",
          profile_id: "a",
          model: null,
          code: "auth_revoked",
          source: "vendor_poller",
          detail: "the vendor rejected this profile's credential",
          observed_at: "2026-01-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ],
    });
    await expect(resolveAccountForRun(context)).resolves.toMatchObject({ profile_id: "b" });
    const laneSwitch = context.events.find((event) => event.type === "route.account.lane_switch");
    expect(laneSwitch?.payload).toMatchObject({ from_profile_id: "a", to_profile_id: "b" });
    expect(String(laneSwitch?.payload["reason"])).toMatch(/unusable \(auth_revoked\)/);
  });
});
