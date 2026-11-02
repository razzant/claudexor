import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, updateGlobalConfig } from "@claudexor/config";
import { noProjectRepoRoot } from "@claudexor/util";
import {
  ControlQuotaResponse,
  ControlCredentialProfilesResponse,
  ControlCredentialProfilesSnapshotResponse,
  ControlCredentialProfileUpdateResponse,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { QuotaRegistry, createAccountEvidence } from "@claudexor/daemon";
import { memoryEventLedger } from "./test-support/memory-event-ledger.js";
import { controlServices } from "./control-services.js";
import { bustGlobalCredentialStatusCaches } from "./credential-status-invalidation.js";
import { registerConfigDirProfile } from "./profile-registration.js";
import { invalidateStatusProjections } from "./status-projection-cache.js";

// One evidence graph for this file, injected the way the daemon injects its store's graph.
const accounts = createAccountEvidence();
const credentialUnusableLedger = accounts.unusable;
const preProgressRefusalLedger = accounts.refusals;
const modelSubstitutionLedger = accounts.substitutions;

const gatewayMock = vi.hoisted(() => ({
  statuses: [] as unknown[],
  calls: [] as Array<{ fresh?: boolean }>,
  accountIdentities: {} as Record<string, { email?: string; plan?: string } | null>,
  profileIdentities: {} as Record<string, { email?: string; plan?: string } | null>,
  profileProbeCalls: [] as string[],
  profileReadiness: {
    availability: "unknown",
    verification: "not_run",
  } as {
    availability: "available" | "unavailable" | "unknown";
    verification: "passed" | "failed" | "not_run";
  },
  profileReadinessById: {} as Record<
    string,
    {
      availability: "available" | "unavailable" | "unknown";
      verification: "passed" | "failed" | "not_run";
      stale?: boolean;
      stale_basis?: "last_positive_after_timeout";
    }
  >,
}));
const noteCredentialChange = vi.fn();

vi.mock("./registry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./registry.js")>();
  return {
    ...original,
    // Catalog projection does not test native model discovery. PATH alone is
    // insufficient: the harness resolver also checks managed install roots.
    harnessModelTruth: async (
      harnessId: string,
    ): ReturnType<typeof original.harnessModelTruth> => ({
      response: {
        harnessId,
        models: [],
        source: "none",
        verifiedAgainst: null,
      },
      absence: "authoritative",
    }),
    buildRegistry: (options?: Parameters<typeof original.buildRegistry>[0]) => {
      const registry = original.buildRegistry(options);
      for (const [id, adapter] of registry) {
        if (!adapter.probeCredentialProfile && !adapter.probeCredentialAccount) continue;
        const statusFor = (profile: { profile_id: string; harness_id: string }) => {
          const readiness =
            gatewayMock.profileReadinessById[profile.profile_id] ?? gatewayMock.profileReadiness;
          return {
            profile_id: profile.profile_id,
            harness_id: profile.harness_id,
            availability: readiness.availability,
            verification: readiness.verification,
            ...("stale" in readiness ? { stale: readiness.stale } : {}),
            ...("stale_basis" in readiness ? { stale_basis: readiness.stale_basis } : {}),
            verification_source: "local_store" as const,
            detail: "live profile probe disabled in projection unit test",
            last_verified_at: null,
          };
        };
        registry.set(id, {
          ...adapter,
          ...(adapter.probeCredentialProfile
            ? {
                probeCredentialProfile: async (profile) => {
                  gatewayMock.profileProbeCalls.push(profile.profile_id);
                  return statusFor(profile);
                },
              }
            : {}),
          ...(adapter.probeCredentialAccount
            ? {
                probeCredentialAccount: async (profile) => {
                  gatewayMock.profileProbeCalls.push(profile.profile_id);
                  return {
                    status: statusFor(profile),
                    identity: gatewayMock.profileIdentities[profile.profile_id] ?? null,
                  };
                },
              }
            : {}),
        });
      }
      return registry;
    },
    buildGateway: () => ({
      statusAll: async (input: { fresh?: boolean }) => {
        gatewayMock.calls.push(input);
        return gatewayMock.statuses;
      },
      statusAllForAccounts: async (input: { fresh?: boolean }) => {
        gatewayMock.calls.push(input);
        return gatewayMock.statuses.map((status) => ({
          status,
          identity: gatewayMock.accountIdentities[(status as { id: string }).id] ?? null,
        }));
      },
    }),
  };
});

vi.mock("@claudexor/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@claudexor/workspace")>();
  return {
    ...original,
    probeGitCapability: async () => ({
      status: "missing",
      version: null,
      detail: "No executable named git was found on PATH.",
      remediation: "Install Git and make it available on PATH, then retry.",
    }),
  };
});

// PATCH /credential-profiles/:harness/:id (the Enabled toggle of the accounts
// symmetry, INV-135) + the per-harness accounts-authority projection served on
// the listing so no surface re-derives Active/native truth.

function quotaSnapshot(subjectId: string | null, usedRatio: number): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage",
    // Fresh at the routing decision, which judges each window's age (#457).
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  };
}

function services(
  options: {
    refreshedQuota?: ControlQuotaResponse;
    refreshError?: Error;
    quotaEventCursor?: string;
    readQuota?: ControlQuotaResponse;
    /** A real registry instead of the stub (its own read/admission projections). */
    registry?: QuotaRegistry;
  } = {},
) {
  const threads = {
    invalidateCredentialProfile: () => ({ clearedThreads: 0, invalidatedSessions: 0 }),
    listThreads: () => [] as unknown[],
  };
  const emptyQuota = ControlQuotaResponse.parse({
    snapshots: [],
    absences: [],
    refreshed_at: null,
  });
  const refreshQuota = async () => {
    if (options.refreshError) throw options.refreshError;
    return (
      options.refreshedQuota ?? {
        ...emptyQuota,
        refreshed_at: "2026-07-28T00:00:00Z",
      }
    );
  };
  const quota = {
    removeSubject: () => 0,
    noteCredentialChange,
    read: () => options.readQuota ?? emptyQuota,
    // Fixture snapshots are current, so the admission read is the same rows.
    readAdmission: () => ({ snapshots: (options.readQuota ?? emptyQuota).snapshots }),
    refresh: refreshQuota,
    refreshWithCursor: async () => {
      const response = await refreshQuota();
      return {
        response,
        admission: { snapshots: response.snapshots },
        quotaEventCursor: options.quotaEventCursor ?? "quota-fence-default",
      };
    },
  };
  return controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    threads as never,
    { current: () => ({ list: () => [] }) } as never,
    undefined as never,
    undefined as never,
    undefined as never,
    (() => options.registry ?? quota) as never,
    accounts,
    () => [],
  );
}

describe("updateCredentialProfile (INV-135 Enabled toggle) + accounts projection", () => {
  let dir: string;
  let prev: string | undefined;
  let prevPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-profile-update-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    prevPath = process.env.PATH;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    // These are projection tests, not live harness integration tests. Keep
    // them hermetic even when the developer machine has vendor CLIs installed.
    process.env.PATH = dir;
    gatewayMock.calls = [];
    gatewayMock.accountIdentities = {};
    gatewayMock.profileIdentities = {};
    gatewayMock.profileProbeCalls = [];
    noteCredentialChange.mockClear();
    gatewayMock.profileReadiness = { availability: "unknown", verification: "not_run" };
    gatewayMock.profileReadinessById = {};
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    credentialUnusableLedger.noteCredentialChange();
    vi.useRealTimers();
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recomposes new refusals and expiry over cached probes while retaining account identity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T09:00:00Z"));
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "a" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "b" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    writeFileSync(
      join(profile.isolation_locator!, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "a@example.test", organizationType: "claude_max" },
      }),
    );
    const svc = services();
    const initial = await svc.credentialProfiles();
    expect(initial.accountPools.find((row) => row.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "a",
    });
    const probeCount = gatewayMock.profileProbeCalls.length;
    const sweepCount = gatewayMock.calls.length;
    credentialUnusableLedger.record({
      harness_id: "claude",
      profile_id: "a",
      model: null,
      credential_route: "vendor_native",
      code: "auth_revoked",
      source: "attempt_stream",
      detail: "The provider rejected this credential",
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 2_000).toISOString(),
    });
    const refused = await svc.credentialProfiles();
    expect(refused.profiles.find((row) => row.profile.profile_id === "a")).toMatchObject({
      status: { availability: "available", verification: "failed", verification_source: "vendor" },
      identity: { email: "a@example.test" },
    });
    expect(refused.accountPools.find((row) => row.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "b",
    });
    vi.setSystemTime(new Date(Date.now() + 3_000));
    const expired = await svc.credentialProfiles();
    expect(
      expired.profiles.find((row) => row.profile.profile_id === "a")?.status.verification,
    ).toBe("passed");
    expect(expired.accountPools.find((row) => row.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "a",
    });
    expect(gatewayMock.profileProbeCalls).toHaveLength(probeCount);
    expect(gatewayMock.calls).toHaveLength(sweepCount);
  });

  it("applies a model refusal to next_up for that model without condemning the account row", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "a" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "b" });
    updateGlobalConfig((cfg) => {
      cfg.harnesses.claude = { ...cfg.harnesses.claude!, default_model: "model-a" };
      return cfg;
    });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    credentialUnusableLedger.record({
      harness_id: "claude",
      profile_id: "a",
      model: "model-a",
      credential_route: "vendor_native",
      code: "capability_refused",
      source: "attempt_stream",
      detail: "The provider refused this model",
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await services().credentialProfiles();
    expect(result.profiles.find((row) => row.profile.profile_id === "a")?.status.verification).toBe(
      "passed",
    );
    expect(result.accountPools.find((row) => row.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "b",
    });
  });

  it("uses newer served evidence without rewriting a poller refusal or leaking internal proof on the wire", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    const quota = ControlQuotaResponse.parse({
      snapshots: [],
      refreshed_at: null,
      absences: [
        {
          subject: { harness: "claude", credential_route: "vendor_native", subject_id: "work" },
          reason: "auth_revoked",
          detail: "Earlier usage endpoint rejection",
          observed_at: new Date(Date.now() - 10_000).toISOString(),
        },
      ],
    });
    const svc = services({ readQuota: quota, refreshedQuota: quota });
    expect((await svc.credentialProfiles()).profiles[0]?.status.verification).toBe("failed");
    const before = gatewayMock.profileProbeCalls.length;
    const binding = credentialUnusableLedger.bind({
      harnessId: "claude",
      profileId: "work",
      route: "vendor_native",
      requestedModel: "test-model",
    });
    credentialUnusableLedger.honorBound(binding, "test-model");
    const healed = await svc.credentialProfiles();
    expect(healed.profiles[0]?.status.verification).toBe("passed");
    expect(gatewayMock.profileProbeCalls).toHaveLength(before);
    const snapshot = await svc.credentialProfiles({ snapshot: true });
    expect(snapshot).toHaveProperty("quota.absences.0.reason", "auth_revoked");
    expect(JSON.stringify(snapshot)).not.toContain('"honored"');
    expect(snapshot.profiles[0]?.status.verification).toBe("passed");
  });

  it("flips the profile's durable enabled flag and returns the receipt", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    const off = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false }),
    );
    expect(off.profile.enabled).toBe(false);
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles[0]?.enabled).toBe(false);
    const on = ControlCredentialProfileUpdateResponse.parse(
      await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: true }),
    );
    expect(on.profile.enabled).toBe(true);
    expect(noteCredentialChange).toHaveBeenCalledTimes(2);
  });

  it("emits an own setupLogin property from both current capability producers", async () => {
    const previousCodexBin = process.env.CLAUDEXOR_CODEX_BIN;
    process.env.CLAUDEXOR_CODEX_BIN = process.execPath;
    gatewayMock.statuses[0] = {
      ...(gatewayMock.statuses[0] as Record<string, unknown>),
      id: "codex",
    };
    try {
      const svc = services();
      const harnesses = await svc.harnesses({ fresh: true });
      expect(harnesses.harnesses).toHaveLength(1);
      expect(Object.hasOwn(harnesses.harnesses[0]!, "setupLogin")).toBe(true);
      expect(harnesses.harnesses[0]!.setupLogin).toEqual({ mode: "in_app" });

      const catalog = await svc.agentCapabilities();
      expect(catalog.harnesses).toHaveLength(1);
      expect(Object.hasOwn(catalog.harnesses[0]!, "setupLogin")).toBe(true);
      expect(catalog.harnesses[0]!.setupLogin).toEqual({ mode: "in_app" });
    } finally {
      if (previousCodexBin === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
      else process.env.CLAUDEXOR_CODEX_BIN = previousCodexBin;
    }
  });

  it("projects the manifest's live_input channel as the catalog row's liveInput (none when absent)", async () => {
    const svc = services();
    // The stubbed status carries no manifest: the row degrades to `none`.
    const absent = await svc.agentCapabilities();
    expect(absent.harnesses[0]).toMatchObject({ id: "claude", liveInput: "none" });

    gatewayMock.statuses[0] = {
      ...(gatewayMock.statuses[0] as Record<string, unknown>),
      id: "codex",
      manifest: {
        display_name: "Codex",
        provider_family: "openai",
        capability_profile: {
          live_input: "mid_turn",
          access_control: { readonly_mechanism: "none", write_mechanism: "none" },
          attachment_inputs: [],
          mcp_injection: false,
          mcp_injection_requires_full_access: false,
        },
        capabilities: { web_policy: "none", effort_levels: [], processing_preferences: [] },
        access_profiles_supported: [],
      },
    };
    // The catalog is a status projection: a later sweep (window expiry or a
    // credential mutation) is what observes the changed doctor answer.
    invalidateStatusProjections();
    const declared = await svc.agentCapabilities();
    expect(declared.harnesses).toHaveLength(1);
    expect(declared.harnesses[0]).toMatchObject({ id: "codex", liveInput: "mid_turn" });
    expect(Object.hasOwn(declared.harnesses[0]!, "liveInput")).toBe(true);
  });

  it("mirrors native_credentials_enabled for ANY row at the harness default store — migration record or not", async () => {
    // A bootstrap row (ensureBootstrapProfile) sits at the exact default
    // native dir BEFORE any migration record exists. Disabling it must update
    // the deprecated downgrade-window mirror too, or the legacy
    // default-subject ladder (and a downgraded 3.5.0 engine) would silently
    // route back into the same account's store.
    const { ensureBootstrapProfile } = await import("./profile-registration.js");
    const { readAccountsMigrationFile } = await import("./accounts-unified-migration.js");
    const row = ensureBootstrapProfile("codex");
    expect(readAccountsMigrationFile()["codex"]).toBeUndefined();
    const svc = services();
    await svc.updateCredentialProfile({
      harnessId: "codex",
      profileId: row.profile_id,
      enabled: false,
    });
    const cfg = loadConfig(noProjectRepoRoot()).global;
    expect(cfg.harnesses["codex"]?.native_credentials_enabled).toBe(false);
    expect(cfg.credential_profiles.find((p) => p.profile_id === row.profile_id)?.enabled).toBe(
      false,
    );
    // An ordinary profiles-tree row never touches the mirror.
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false });
    expect(
      loadConfig(noProjectRepoRoot()).global.harnesses["claude"]?.native_credentials_enabled,
    ).not.toBe(false);
  });

  it("re-arms quota polling after profile creation and quota-relevant settings", async () => {
    const svc = services();
    await svc.createCredentialProfile({ harnessId: "claude", profileId: "new-account" });
    expect(noteCredentialChange).toHaveBeenCalledOnce();

    await svc.updateSettings({
      harnesses: { claude: { nativeCredentialsEnabled: false } },
    });
    expect(noteCredentialChange).toHaveBeenCalledTimes(2);

    // All settings mutations ride the same cache-bust/reset owner; use a
    // harness-independent field so this projection test never needs a vendor CLI.
    await svc.updateSettings({ interactionTimeoutMs: 60_000 });
    expect(noteCredentialChange).toHaveBeenCalledTimes(3);
  });

  it("reserves the profile id 'default' at registration (laneProfileSegment(null) collision)", async () => {
    // laneProfileSegment(null) and a literal "default" row id collide on the
    // <harness>-default lane segment that migration/deletion act on — a row
    // named "default" could have its lanes renamed or purged as legacy state.
    expect(() => registerConfigDirProfile({ harnessId: "claude", profileId: "default" })).toThrow(
      /reserved for the engine's unpinned lane/,
    );
    await expect(
      services().createCredentialProfile({ harnessId: "claude", profileId: "default" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(loadConfig(noProjectRepoRoot()).global.credential_profiles).toHaveLength(0);
  });

  it("refuses an unknown id with a typed 404 and a missing enabled with a 400", async () => {
    const svc = services();
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "ghost", enabled: true }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.updateCredentialProfile({ harnessId: "claude", profileId: "work" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("projects the pool verdict per harness: ready row selected, disabled row none, legacy carrier empty (unified model)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();

    // Row registered but not yet ready (probe unknown) → nothing routable and
    // no API-key route → none. The legacy harnessAccounts carrier stays
    // PRESENT and EMPTY for strict old clients.
    const base = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(base.harnessAccounts).toEqual([]);
    const claudeBase = base.accountPools.find((pool) => pool.harness_id === "claude");
    expect(claudeBase?.next_up.kind).toBe("none");
    // #363: an unready row is named with what its probe observed, never
    // reported as "not signed in" (unknown is not a logout).
    const baseReason = claudeBase?.next_up.kind === "none" ? claudeBase.next_up.reason : "";
    expect(baseReason).toBe(
      "no enabled account is ready (work: live profile probe disabled in projection unit test)",
    );
    expect(baseReason).not.toMatch(/signed in|log ?in/i);

    // A ready enabled row IS the unpinned route (unified model: unpinned
    // routing = quota-aware pool; there is no separate native default).
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({ ...config })); // bump the projection cache version
    const ready = ControlCredentialProfilesSnapshotResponse.parse(
      await svc.credentialProfiles({ snapshot: true }),
    );
    expect(ready.accountPools.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "work",
    });

    // Disabling the row (the only routing control) empties the pool → none.
    await svc.updateCredentialProfile({ harnessId: "claude", profileId: "work", enabled: false });
    const none = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    expect(none.accountPools.find((pool) => pool.harness_id === "claude")?.next_up.kind).toBe(
      "none",
    );
  });

  it("next_up admits a last positive after a timeout like pool routing, never the generic stale grace (#363)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "a-lkg" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "b-last-positive" });
    gatewayMock.profileReadinessById = {
      "a-lkg": { availability: "unknown", verification: "not_run", stale: true },
      "b-last-positive": {
        availability: "unknown",
        verification: "not_run",
        stale: true,
        stale_basis: "last_positive_after_timeout",
      },
    };
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.accountPools.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "b-last-positive",
    });
    // The row itself still reads stale unknown, never a verified login.
    expect(
      listing.profiles.find((entry) => entry.profile.profile_id === "b-last-positive")?.status,
    ).toMatchObject({ availability: "unknown", verification: "not_run", stale: true });
  });

  it("readiness-probes disabled profile-isolated rows without making them routable", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "enabled" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "disabled" });
    updateGlobalConfig((config) => ({
      ...config,
      credential_profiles: config.credential_profiles.map((profile) =>
        profile.profile_id === "disabled" ? { ...profile, enabled: false } : profile,
      ),
    }));
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.profiles).toHaveLength(2);
    expect(gatewayMock.profileProbeCalls).toContain("enabled");
    expect(gatewayMock.profileProbeCalls).toContain("disabled");
    expect(
      listing.profiles.find((entry) => entry.profile.profile_id === "disabled")?.status,
    ).toMatchObject({ availability: "available", verification: "passed" });
    expect(listing.accountPools.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "enabled",
    });
  });

  it("projects none when no account row exists, regardless of default-store doctor truth", async () => {
    gatewayMock.statuses = [
      {
        id: "claude",
        status: "unavailable",
        authSources: [
          { source: "native_session", availability: "unknown", verification: "not_run" },
        ],
        enabledIntents: [],
        routableIntents: [],
      },
    ];
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.harnessAccounts).toEqual([]);
    const claude = listing.accountPools.find((value) => value.harness_id === "claude");
    expect(claude?.next_up).toMatchObject({
      kind: "none",
      reason: expect.stringContaining("no enabled account is signed in"),
    });
  });

  it("returns one opt-in snapshot whose rows and pool verdict share one fresh doctor read", async () => {
    gatewayMock.calls = [];
    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services().credentialProfiles({ snapshot: true }),
    );
    expect(gatewayMock.calls).toEqual([{ cwd: noProjectRepoRoot(), fresh: true }]);
    expect(snapshot.harnesses.map((status) => status.id)).toEqual(["claude"]);
    expect(snapshot.harnessAccounts).toEqual([]);
    expect(
      snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up,
    ).toMatchObject({ kind: "none" });
    expect(snapshot.git.status).toBe("missing");
    expect(snapshot.quota.refreshed_at).toBe("2026-07-28T00:00:00Z");
    const { quotaEventCursor, ...unfenced } = snapshot;
    expect(quotaEventCursor).toBe("quota-fence-default");
    expect(() => ControlCredentialProfilesSnapshotResponse.parse(unfenced)).toThrow();
    // Old-wire bodies without accountPools still parse (additive default []).
    expect(ControlCredentialProfilesResponse.parse({ profiles: [], harnessAccounts: [] })).toEqual({
      profiles: [],
      harnessAccounts: [],
      accountPools: [],
    });
  });

  it("projects the API-key ROUTE for an empty pool ONLY under the EXPLICIT api_key preference (Q3=A)", async () => {
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "unavailable", verification: "failed" },
          { source: "api_key_env", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    // Under the default `auto` preference the paid route is never a silent
    // next_up: the pool verdict stays an honest `none`.
    const autoListing = ControlCredentialProfilesResponse.parse(
      await services().credentialProfiles(),
    );
    expect(
      autoListing.accountPools.find((value) => value.harness_id === "claude")?.next_up,
    ).toMatchObject({ kind: "none" });
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: { ...(config.harnesses.claude ?? {}), auth_preference: "api_key" },
      },
    }));
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    const claude = listing.accountPools.find((value) => value.harness_id === "claude");
    expect(claude?.next_up).toEqual({ kind: "api_key_route" });
  });

  it("derives next_up and returns quota from one refreshed snapshot epoch", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: ["work"],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot(null, 0.95), quotaSnapshot("work", 0.1)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });
    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota, quotaEventCursor: "quota-fence-exact" }).credentialProfiles({
        snapshot: true,
      }),
    );
    expect(snapshot.quota.snapshots).toEqual(
      refreshedQuota.snapshots.map((quota) => ({
        ...quota,
        snapshot_id: `claude\0vendor_native\0${quota.subject.subject_id ?? ""}\0claude_oauth_usage`,
        availability: {
          state: "available",
          blocking_constraints: [],
          resets_at: null,
          model_scoped_exhaustions: [],
        },
      })),
    );
    expect(snapshot.quota.absences).toEqual(refreshedQuota.absences);
    expect(snapshot.quota.refreshed_at).toBe(refreshedQuota.refreshed_at);
    expect(refreshedQuota.snapshots.every((quota) => !("availability" in quota))).toBe(true);
    expect(snapshot.quotaEventCursor).toBe("quota-fence-exact");
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "work",
    });
  });

  it("pool selection skips an unready row and picks the next ready one", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "spare" });
    gatewayMock.profileReadinessById = {
      work: { availability: "unavailable", verification: "failed" },
      spare: { availability: "available", verification: "passed" },
    };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: ["work", "spare"],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot(null, 0.95)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "spare",
    });
  });

  it("a NON-EMPTY rotation_eligible list filters next_up to rows the runtime would select", async () => {
    // Both rows are ready, but the explicit rotation policy names only
    // "spare": advertising "work" would promise an account the runtime's
    // staticRotationCandidates filter never picks.
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    registerConfigDirProfile({ harnessId: "claude", profileId: "spare" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: ["spare"],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.accountPools.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "spare",
    });
  });

  it("projects the API-key ROUTE for an exhausted pool only under the EXPLICIT api_key preference (Q3=A)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: { ...(config.harnesses.claude ?? {}), auth_preference: "api_key" },
      },
    }));
    gatewayMock.statuses = [
      {
        id: "claude",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "unavailable", verification: "failed" },
          { source: "api_key_env", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [quotaSnapshot("work", 1)],
      absences: [],
      refreshed_at: "2026-07-28T01:02:03Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    expect(snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up).toEqual({
      kind: "api_key_route",
    });
  });

  it("names a pool stopped only by the saved reserve in next_up, not as provider exhaustion (#318)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: [],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    const nextUp = async (usedRatio: number) => {
      const refreshedQuota = ControlQuotaResponse.parse({
        snapshots: [quotaSnapshot("work", usedRatio)],
        absences: [],
        refreshed_at: "2026-07-28T01:02:03Z",
      });
      const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
        await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
      );
      return snapshot.accountPools.find((value) => value.harness_id === "claude")?.next_up;
    };
    const reserve = await nextUp(0.95);
    expect(reserve).toMatchObject({ kind: "none" });
    expect(reserve && "reason" in reserve ? reserve.reason : "").toContain(
      "reached its saved quota reserve (headroom_threshold 90%)",
    );
    const spent = await nextUp(1);
    expect(spent && "reason" in spent ? spent.reason : "").toContain("over its quota window");
  });

  it("next_up judges each window at the decision like run admission, passive and atomic (#457)", async () => {
    registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    updateGlobalConfig((config) => ({
      ...config,
      harnesses: {
        ...config.harnesses,
        claude: {
          ...(config.harnesses.claude ?? {}),
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: [],
            headroom_threshold: 0.9,
          },
        },
      },
    }));
    // A three-minute-old reading: the short window reset a minute ago, the
    // weekly window is still current at 95% against a 90% reserve.
    const now = Date.now();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const reading: QuotaSnapshot = {
      ...quotaSnapshot("work", 1),
      observed_at: at(-3 * 60_000),
      constraints: [
        { ...quotaSnapshot("work", 1).constraints[0]!, resets_at: at(-60_000) },
        {
          id: "seven_day",
          label: "7 day",
          used_ratio: 0.95,
          window_seconds: 604_800,
          resets_at: at(3 * 86_400_000),
          cooldown_until: null,
        },
      ],
    };
    const registry = new QuotaRegistry(memoryEventLedger(at(0)), [
      async () => ({ snapshots: [reading] }),
    ]);
    registry.upsert(reading);
    const svc = services({ registry });
    const passive = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const atomic = ControlCredentialProfilesSnapshotResponse.parse(
      await svc.credentialProfiles({ snapshot: true }),
    );
    for (const response of [passive, atomic]) {
      const nextUp = response.accountPools?.find((pool) => pool.harness_id === "claude")?.next_up;
      // The runtime refuses this account at the reserve; next_up never names it.
      expect(nextUp).toMatchObject({ kind: "none" });
      expect(nextUp && "reason" in nextUp ? nextUp.reason : "").toContain("saved quota reserve");
    }
    // Display keeps the aggregate snapshot aging and the atomic cursor.
    expect(registry.read().snapshots[0]?.freshness).toBe("stale");
    expect(atomic.quota.snapshots[0]?.freshness).toBe("stale");
    expect(atomic.quotaEventCursor).toMatch(/^global:/);
    // Past the observation's own TTL nothing is revived: the account is
    // eligible again (unknown headroom), exactly as for runs.
    const aged = new QuotaRegistry(memoryEventLedger(at(0)));
    aged.upsert({ ...reading, observed_at: at(-6 * 60_000) });
    const later = ControlCredentialProfilesResponse.parse(
      await services({ registry: aged }).credentialProfiles(),
    );
    expect(later.accountPools?.find((pool) => pool.harness_id === "claude")?.next_up).toEqual({
      kind: "profile",
      profileId: "work",
    });
  });

  it("fails the complete snapshot when its quota epoch cannot refresh", async () => {
    const error = Object.assign(new Error("quota refresh unavailable"), {
      code: "quota_refresh_unavailable",
      status: 503,
    });
    await expect(
      services({ refreshError: error }).credentialProfiles({ snapshot: true }),
    ).rejects.toBe(error);
  });

  it("projects the non-secret {email, plan} identity from each row's OWN owned store (INV-067)", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    // The profile's OWN isolation-locator store discloses its identity.
    writeFileSync(
      join(profile.isolation_locator ?? "", ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "work@example.test", organizationType: "claude_max" },
      }),
    );

    const listing = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());

    const profileEntry = listing.profiles.find((p) => p.profile.profile_id === "work");
    expect(profileEntry?.identity).toEqual({ email: "work@example.test", plan: "claude_max" });
  });

  it("projects named Cursor emails from the Accounts-only probe receipts", async () => {
    registerConfigDirProfile({ harnessId: "cursor", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    gatewayMock.profileIdentities = { work: { email: "work-cursor@example.test" } };
    gatewayMock.statuses = [
      {
        id: "cursor",
        available: true,
        status: "ok",
        manifest: null,
        authSources: [
          { source: "native_session", availability: "available", verification: "passed" },
        ],
        enabledIntents: ["explain", "implement"],
        routableIntents: ["explain", "implement"],
        disabledIntents: [],
        checks: [],
        reasons: [],
      },
    ];

    const listing = ControlCredentialProfilesResponse.parse(await services().credentialProfiles());
    expect(listing.profiles.find((entry) => entry.profile.profile_id === "work")?.identity).toEqual(
      { email: "work-cursor@example.test" },
    );
  });

  it("keeps Cursor identity beside a vendor readiness error instead of hiding either", async () => {
    registerConfigDirProfile({ harnessId: "cursor", profileId: "work" });
    gatewayMock.profileReadiness = { availability: "available", verification: "passed" };
    gatewayMock.profileIdentities = { work: { email: "work-cursor@example.test" } };
    const refreshedQuota = ControlQuotaResponse.parse({
      snapshots: [],
      absences: [
        {
          subject: {
            harness: "cursor",
            credential_route: "vendor_native",
            plan_label: null,
            subject_id: "work",
          },
          reason: "auth_revoked",
          detail: "vendor rejected the profile credential",
          observed_at: "2026-08-09T00:00:00Z",
        },
      ],
      refreshed_at: "2026-08-09T00:00:00Z",
    });

    const snapshot = ControlCredentialProfilesSnapshotResponse.parse(
      await services({ refreshedQuota }).credentialProfiles({ snapshot: true }),
    );
    const entry = snapshot.profiles.find((candidate) => candidate.profile.profile_id === "work");
    expect(entry?.identity).toEqual({ email: "work-cursor@example.test" });
    expect(entry?.status).toMatchObject({
      availability: "available",
      verification: "failed",
      verification_source: "vendor",
      detail: "vendor rejected the profile credential",
    });
  });

  it("never lets a token-bearing store leak beyond {email, plan}", async () => {
    const { profile } = registerConfigDirProfile({ harnessId: "claude", profileId: "work" });
    const svc = services();
    writeFileSync(
      join(profile.isolation_locator ?? "", ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          emailAddress: "work@example.test",
          organizationType: "claude_max",
          accountUuid: "uuid-secret-do-not-leak",
        },
        oauthToken: "sk-ant-" + "secret-do-not-leak",
      }),
    );
    const listing = ControlCredentialProfilesResponse.parse(await svc.credentialProfiles());
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("uuid-secret-do-not-leak");
    expect(serialized).not.toContain("sk-ant-" + "secret-do-not-leak");
    const entry = listing.profiles.find((p) => p.profile.profile_id === "work");
    expect(Object.keys(entry?.identity ?? {}).sort()).toEqual(["email", "plan"]);
  });
});

describe("A7 per-subject unusable-ledger clearing on control-API credential mutations", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudexor-ledger-clear-"));
    prev = process.env.CLAUDEXOR_CONFIG_DIR;
    process.env.CLAUDEXOR_CONFIG_DIR = dir;
    credentialUnusableLedger.noteCredentialChange();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
    else process.env.CLAUDEXOR_CONFIG_DIR = prev;
    credentialUnusableLedger.noteCredentialChange();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const observation = (harnessId: string, profileId: string | null) => ({
    harness_id: harnessId,
    profile_id: profileId,
    model: null,
    code: "auth_revoked" as const,
    source: "attempt_stream" as const,
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  it("setSecret clears exactly the subject whose profile secret_ref it rewrote", async () => {
    updateGlobalConfig((cfg) => ({
      ...cfg,
      credential_profiles: [
        {
          profile_id: "solo",
          harness_id: "codex",
          display_name: "Solo",
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:solo",
          enabled: true,
          created_at: null,
        },
      ],
    }));
    credentialUnusableLedger.record(observation("codex", "solo"));
    credentialUnusableLedger.record(observation("claude", "other"));
    const svc = services();
    await svc.setSecret({ name: "openai:solo", value: "sk-new" });
    const live = credentialUnusableLedger.live();
    // The rewritten credential's verdict is void; an unrelated subject's is not.
    expect(live.find((o) => o.harness_id === "codex" && o.profile_id === "solo")).toBeUndefined();
    expect(live.find((o) => o.harness_id === "claude" && o.profile_id === "other")).toBeTruthy();
  });

  it("a bare managed name voids every DEFAULT subject's verdict (fail-open), named profiles keep theirs", async () => {
    credentialUnusableLedger.record(observation("cursor", null));
    credentialUnusableLedger.record(observation("codex", null));
    credentialUnusableLedger.record(observation("claude", "work"));
    const svc = services();
    await svc.setSecret({ name: "cursor", value: "key" });
    const live = credentialUnusableLedger.live();
    expect(live.filter((o) => o.profile_id === null)).toEqual([]);
    expect(live.find((o) => o.profile_id === "work")).toBeTruthy();
  });

  it("a profile mutation voids that account's model-substitution observations; a login/logout voids all", async () => {
    const substituted = (profileId: string) => ({
      harness_id: "codex",
      profile_id: profileId,
      requested_model: "model-a",
    });
    modelSubstitutionLedger.noteCredentialChange();
    registerConfigDirProfile({ harnessId: "codex", profileId: "work" });
    modelSubstitutionLedger.record(substituted("work"));
    modelSubstitutionLedger.record(substituted("other"));
    const svc = services();
    await svc.updateCredentialProfile({ harnessId: "codex", profileId: "work", enabled: false });
    expect(modelSubstitutionLedger.live().map((o) => o.profile_id)).toEqual(["other"]);
    bustGlobalCredentialStatusCaches(() => ({ noteCredentialChange }) as never, accounts);
    expect(modelSubstitutionLedger.live()).toEqual([]);
  });

  it("an oauth_token row's secret_ref names it to the refusal and substitution ledgers too (#363)", async () => {
    updateGlobalConfig((cfg) => ({
      ...cfg,
      credential_profiles: [
        {
          profile_id: "oauth",
          harness_id: "claude",
          display_name: "OAuth",
          credential_kind: "oauth_token",
          isolation_locator: null,
          secret_ref: "claude_oauth:oauth",
          enabled: true,
          created_at: null,
        },
      ],
    }));
    preProgressRefusalLedger.noteCredentialChange();
    modelSubstitutionLedger.noteCredentialChange();
    const mark = (profileId: string) => ({
      harness_id: "claude",
      profile_id: profileId,
      requested_model: "m",
    });
    preProgressRefusalLedger.record(mark("oauth"));
    preProgressRefusalLedger.record(mark("other"));
    modelSubstitutionLedger.record(mark("oauth"));
    modelSubstitutionLedger.record(mark("other"));
    const bound = preProgressRefusalLedger.generation("claude", "oauth");
    const sibling = preProgressRefusalLedger.generation("claude", "other");
    const svc = services();
    await svc.setSecret({ name: "claude_oauth:oauth", value: "rotated-token" });
    // The subscription row the secret IS: its marks are void and a try bound
    // to the old token can neither record nor clear one about the new token.
    expect(preProgressRefusalLedger.live().map((o) => o.profile_id)).toEqual(["other"]);
    expect(modelSubstitutionLedger.live().map((o) => o.profile_id)).toEqual(["other"]);
    expect(preProgressRefusalLedger.generation("claude", "oauth")).not.toBe(bound);
    expect(preProgressRefusalLedger.generation("claude", "other")).toBe(sibling);
    await svc.deleteSecret("claude_oauth:oauth");
    expect(preProgressRefusalLedger.generation("claude", "oauth")).not.toBe(bound);
  });

  it("deleteSecret clears the referencing profile's subject too", async () => {
    updateGlobalConfig((cfg) => ({
      ...cfg,
      credential_profiles: [
        {
          profile_id: "solo",
          harness_id: "codex",
          display_name: "Solo",
          credential_kind: "api_key",
          isolation_locator: null,
          secret_ref: "openai:solo",
          enabled: true,
          created_at: null,
        },
      ],
    }));
    credentialUnusableLedger.record(observation("codex", "solo"));
    const svc = services();
    await svc.deleteSecret("openai:solo");
    expect(credentialUnusableLedger.live()).toEqual([]);
  });
});
