/**
 * The account-resolution owner's ladder predicate (INV-135 unified account
 * model): the legacy default-subject ladder serves ONLY harnesses with no
 * REGISTERED subscription rows. A harness whose rows are all DISABLED must
 * refuse typed (or take the disclosed paid route) — never silently spawn back
 * into the same account through the default store the owner just toggled off.
 */
import { describe, expect, it } from "vitest";
import {
  REOPENING_UNKNOWN_COOLDOWN_ID,
  type CredentialProfile,
  type QuotaConstraint,
  type QuotaSnapshot,
} from "@claudexor/schema";
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

describe("resolveAccountForRun pool terminal evidence (#558)", () => {
  const LATER = "2099-06-01T00:00:00.000Z";
  const FUTURE = "2099-01-01T00:05:00.000Z";
  const quotaRead = (
    source: QuotaSnapshot["source"],
    constraint: Partial<QuotaConstraint> & { id: string },
  ): QuotaSnapshot => ({
    subject: {
      harness: "codex",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "a",
    },
    constraints: [
      {
        label: constraint.id,
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: null,
        ...constraint,
      },
    ],
    source,
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  });
  const reserve = (resets_at: string | null) =>
    quotaRead("codex_app_server", { id: "primary", used_ratio: 0.95, resets_at });
  const refusal = quotaRead("codex_rollout", {
    id: REOPENING_UNKNOWN_COOLDOWN_ID,
    cooldown_until: FUTURE,
  });
  const pool = (snapshots: QuotaSnapshot[]) =>
    ctx({
      harnessId: "codex",
      registry: [profileRow({ profile_id: "a", harness_id: "codex" })],
      snapshots,
      quota: { snapshots, absences: [] },
    });

  it("a reserve breach never hides a row's own usage refusal: the pool stays undated and claims no quota", async () => {
    const context = pool([reserve(LATER), refusal]);
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      resetsAt: null,
      problem: { context: { poolCauses: ["unavailable"], resetsAt: null } },
    });
    const exhausted = context.events.find((event) => event.type === "route.account.pool_exhausted");
    expect(exhausted?.payload["resets_at"]).toBeNull();
  });

  it("controls: dated windows keep the pool's existing reset and quota claim", async () => {
    await expect(resolveAccountForRun(pool([reserve(LATER)]))).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      resetsAt: LATER,
      problem: { context: { poolCauses: ["quota"], resetsAt: LATER } },
    });
    // A dated block stays behind an undated breach, as before: no date is promoted.
    const dated = quotaRead("codex_rollout", { id: "cooldown", cooldown_until: FUTURE });
    await expect(resolveAccountForRun(pool([reserve(null), dated]))).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      resetsAt: null,
      problem: { context: { poolCauses: ["quota"] } },
    });
  });
});

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
  it("excludes a model-incompatible binding before probing it again", async () => {
    const probes: string[] = [];
    const context = ctx({
      registry: [profileRow({ profile_id: "a" }), profileRow({ profile_id: "b" })],
      boundProfileId: "a",
      excludedProfileIds: new Set(["a"]),
      probe: async (profile) => {
        probes.push(profile.profile_id);
        return {
          profile_id: profile.profile_id,
          harness_id: profile.harness_id,
          availability: "available",
          verification: "passed",
          verification_source: "local_store",
          detail: "test profile ready",
          last_verified_at: null,
        };
      },
    });
    await expect(resolveAccountForRun(context)).resolves.toMatchObject({ profile_id: "b" });
    expect(probes).toEqual(["b"]);
    expect(
      context.events.find((event) => event.type === "route.account.lane_switch")?.payload,
    ).toMatchObject({
      from_profile_id: "a",
      to_profile_id: "b",
      reason: "the bound account does not support the requested model",
    });
  });

  it("never turns an explicit pin into Auto through unpinned exclusions", async () => {
    const pinned = profileRow({ profile_id: "a" });
    const context = ctx({
      registry: [pinned, profileRow({ profile_id: "b" })],
      pinnedProfile: pinned,
      boundProfileId: "a",
      excludedProfileIds: new Set(["a"]),
    });
    await expect(resolveAccountForRun(context)).resolves.toBe(pinned);
    expect(context.events).toEqual([]);
  });

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

describe("model-substitution observations (model operations only)", () => {
  const substitutions = [
    {
      harness_id: "claude",
      profile_id: "a",
      requested_model: "model-a",
      served_model: "model-b",
      observed_at: "2026-09-20T10:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  ];
  const registry = [profileRow({ profile_id: "a" }), profileRow({ profile_id: "b" })];

  it("moves the unbound pool choice to an unmarked sibling and changes nothing without them", async () => {
    const plain = ctx({ registry, model: "model-a" });
    await expect(resolveAccountForRun(plain)).resolves.toMatchObject({ profile_id: "a" });
    const marked = ctx({ registry, model: "model-a", substitutions });
    await expect(resolveAccountForRun(marked)).resolves.toMatchObject({ profile_id: "b" });
    const otherModel = ctx({ registry, model: "model-z", substitutions });
    await expect(resolveAccountForRun(otherModel)).resolves.toMatchObject({ profile_id: "a" });
  });

  it("still selects a marked account when it is the only one, or every account is marked", async () => {
    const solo = ctx({ registry: [registry[0]!], model: "model-a", substitutions });
    await expect(resolveAccountForRun(solo)).resolves.toMatchObject({ profile_id: "a" });
    const all = ctx({
      registry,
      model: "model-a",
      substitutions: [
        ...substitutions,
        { ...substitutions[0]!, profile_id: "b", observed_at: "2026-09-20T09:00:00.000Z" },
      ],
    });
    await expect(resolveAccountForRun(all)).resolves.toMatchObject({ profile_id: "b" });
    expect(all.events.map((event) => event.type)).toEqual(["route.account.pool_selected"]);
  });

  it("never moves an explicit pin or a usable bound account", async () => {
    const pinned = ctx({ registry, pinnedProfile: registry[0]!, model: "model-a", substitutions });
    await expect(resolveAccountForRun(pinned)).resolves.toBe(registry[0]);
    expect(pinned.events).toEqual([]);
    const bound = ctx({ registry, boundProfileId: "a", model: "model-a", substitutions });
    await expect(resolveAccountForRun(bound)).resolves.toBe(registry[0]);
    expect(bound.events).toEqual([]);
  });
});
