import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { updateGlobalConfig } from "@claudexor/config";
import type { HarnessAdapter } from "@claudexor/core";
import { createAccountEvidence, type QuotaRegistry } from "@claudexor/daemon";
import { createFakeHarness } from "@claudexor/harness-fake";
import { probeCredentialProfileStatus, profileStatusAdmits } from "@claudexor/orchestrator";
import {
  CredentialProfile,
  GlobalConfig,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  type CredentialProfileStatus,
  type QuotaAbsence,
  type QuotaSnapshot,
} from "@claudexor/schema";
import {
  accountObservations,
  displayAccountObservation,
  retainAccountProbeObservations,
} from "./account-observations.js";
import { createCredentialProfilesService } from "./accounts-services.js";
import { harnessAccountModels } from "./registry.js";
import {
  invalidateStatusProjections,
  STATUS_PROJECTION_TTL_MS,
} from "./status-projection-cache.js";

const owned = vi.hoisted(() => ({
  adapters: new Map<string, HarnessAdapter>(),
}));
vi.mock("./registry.js", async (original) => ({
  ...(await original<typeof import("./registry.js")>()),
  buildRegistry: () => owned.adapters,
  buildGateway: () => ({ statusAllForAccounts: async () => [], statusAll: async () => [] }),
}));
vi.mock("@claudexor/workspace", async (original) => ({
  ...(await original<typeof import("@claudexor/workspace")>()),
  probeGitCapability: async () => ({ state: "available" }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  accountObservations.invalidate();
  owned.adapters.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const harnessId = "fake-success";
  const profile = CredentialProfile.parse({
    profile_id: "display-account",
    harness_id: harnessId,
    credential_kind: "config_dir_login",
    display_name: "Display fixture",
    isolation_locator: "/display-fixture",
  });
  const passed: CredentialProfileStatus = {
    profile_id: profile.profile_id,
    harness_id: harnessId,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    last_verified_at: new Date().toISOString(),
  };
  const probe = vi.fn(async () => passed);
  const models = vi.fn(async () => [
    { id: "observed-model", label: null, context_window: null, routes: null },
  ]);
  const adapter: HarnessAdapter = {
    ...createFakeHarness(harnessId),
    probeCredentialProfile: probe,
    models,
  };
  owned.adapters.set(harnessId, adapter);
  const config = GlobalConfig.parse({ credential_profiles: [profile] });
  updateGlobalConfig(() => config);
  let quota: { snapshots: QuotaSnapshot[]; absences: QuotaAbsence[]; refreshed_at: string | null } =
    {
      snapshots: [],
      absences: [],
      refreshed_at: null,
    };
  const read = vi.fn(() => quota);
  const readAdmission = () => ({ snapshots: quota.snapshots });
  const refresh = vi.fn(async () => ({
    response: quota,
    admission: { snapshots: quota.snapshots },
    quotaEventCursor: "fixture-cursor",
  }));
  // The store graph's evidence, injected like the daemon does (fresh per fixture).
  const accounts = createAccountEvidence();
  const service = createCredentialProfilesService(
    () => ({ read, readAdmission, refreshWithCursor: refresh }) as unknown as QuotaRegistry,
    accounts,
  );
  const catalog = () =>
    harnessAccountModels({
      harnessId,
      cwd: "/display-fixture",
      registry: owned.adapters,
      config,
      quota: { ...quota, honored: accounts.unusable.honored() },
      unusable: accounts.unusable.live(),
    });
  return {
    accounts,
    profile,
    adapter,
    probe,
    models,
    passed,
    service,
    catalog,
    read,
    refresh,
    setQuota(value: typeof quota) {
      quota = value;
    },
  };
}

describe("Accounts display acquisition", () => {
  it("composes route-matching recovery over retained observations without reacquiring displays", async () => {
    const f = fixture();
    const ledger = f.accounts.unusable;
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    const rejectedAt = new Date().toISOString();
    const refusal: QuotaAbsence = {
      subject: {
        harness: f.profile.harness_id,
        credential_route: "vendor_native",
        subject_id: f.profile.profile_id,
        plan_label: null,
      },
      reason: "auth_revoked",
      detail: "original vendor refusal",
      observed_at: rejectedAt,
    };
    f.setQuota({ snapshots: [], absences: [refusal], refreshed_at: null });
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("failed");
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("auth_required");
    const subject = {
      harnessId: f.profile.harness_id,
      profileId: f.profile.profile_id,
      route: "vendor_native" as const,
      requestedModel: null,
    };
    vi.setSystemTime(Date.now() + 1000);
    ledger.honorBound(ledger.bind({ ...subject, route: "managed_api_key" }), null);
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("failed");
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("auth_required");
    ledger.honorBound(ledger.bind(subject), null);
    const recovered = await f.service.credentialProfiles();
    expect(recovered.profiles[0]?.status.verification).toBe("passed");
    expect(recovered.accountPools[0]?.next_up.kind).toBe("profile");
    expect((await f.catalog()).accounts[0]?.availability).toBe("available");
    vi.setSystemTime(Date.now() + 1000);
    refusal.observed_at = new Date().toISOString();
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("failed");
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("auth_required");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.models).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent profile and catalog reads, then TTL ages evidence without probing again", async () => {
    const f = fixture();
    let release!: (value: CredentialProfileStatus) => void;
    f.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const profiles = f.service.credentialProfiles();
    const catalog = f.catalog();
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
    release(f.passed);
    await Promise.all([profiles, catalog]);
    expect(f.models).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS + 1);
    const later = await f.service.credentialProfiles();
    await f.catalog();
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.models).toHaveBeenCalledTimes(1);
    expect(later.profiles[0]?.status).toMatchObject({
      availability: "available",
      verification: "passed",
      last_verified_at: f.passed.last_verified_at,
    });
    expect(later.profiles[0]?.status.detail).toContain("Last checked");
  });

  it("reads the first native catalog after display TTL without repeating the successful profile probe", async () => {
    const f = fixture();
    await f.service.credentialProfiles();
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS + 1);
    const first = await f.catalog();
    expect(first.accounts[0]?.catalog).toMatchObject({
      source: "api",
      models: [{ id: "observed-model" }],
    });
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS * 3);
    expect((await f.catalog()).accounts[0]?.catalog?.models[0]?.id).toBe("observed-model");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.models).toHaveBeenCalledTimes(1);
  });

  it("remembers a failed cold probe and failed catalog acquisition until explicit invalidation", async () => {
    const f = fixture();
    f.probe.mockRejectedValue(new Error("temporary probe failure"));
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS * 3);
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.models).not.toHaveBeenCalled();
    f.probe.mockResolvedValue(f.passed);
    invalidateStatusProjections();
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.models).toHaveBeenCalledTimes(1);
  });

  it("retains catalog transport failure without repeated vendor calls after TTL", async () => {
    const f = fixture();
    f.models.mockRejectedValue(new Error("catalog network failure"));
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("model_catalog_unavailable");
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS * 3);
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("model_catalog_unavailable");
    expect(f.models).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("explicit Accounts Refresh renews profile and catalog evidence, then display reads stay passive", async () => {
    const f = fixture();
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    await f.service.credentialProfiles({ snapshot: true });
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.models).toHaveBeenCalledTimes(2);
    await Promise.all([f.service.credentialProfiles(), f.catalog()]);
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.models).toHaveBeenCalledTimes(2);
  });

  it("current quota changes affect a display read inside the TTL without another acquisition", async () => {
    const f = fixture();
    const first = await f.service.credentialProfiles();
    expect(first.accountPools[0]?.next_up.kind).toBe("profile");
    f.setQuota({
      snapshots: [
        {
          subject: {
            harness: f.profile.harness_id,
            subject_id: f.profile.profile_id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          constraints: [
            {
              id: "window",
              label: "Window",
              used_ratio: 1,
              window_seconds: 3600,
              resets_at: "2026-10-04T13:00:00Z",
              cooldown_until: null,
            },
          ],
          source: "codex_app_server",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        },
      ],
      absences: [],
      refreshed_at: null,
    });
    expect((await f.service.credentialProfiles()).accountPools[0]?.next_up.kind).toBe("none");
    expect(f.probe).toHaveBeenCalledTimes(1);
    f.setQuota({ snapshots: [], absences: [], refreshed_at: null });
    expect((await f.service.credentialProfiles()).accountPools[0]?.next_up.kind).toBe("profile");
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("next_up promises no reset for an account the vendor refused with no reopening time (#558)", async () => {
    const f = fixture();
    expect((await f.service.credentialProfiles()).accountPools[0]?.next_up.kind).toBe("profile");
    f.setQuota({
      snapshots: [
        {
          subject: {
            harness: f.profile.harness_id,
            subject_id: f.profile.profile_id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          constraints: [
            {
              id: REOPENING_UNKNOWN_COOLDOWN_ID,
              label: "Cooldown",
              used_ratio: null,
              window_seconds: null,
              resets_at: null,
              cooldown_until: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          ],
          source: "codex_rollout",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        },
      ],
      absences: [],
      refreshed_at: null,
    });
    expect((await f.service.credentialProfiles()).accountPools[0]?.next_up).toEqual({
      kind: "none",
      reason:
        "every enabled account is unavailable, and the vendor refused further usage on at least one with no reopening time named, so no reset is known (the paid API-key route requires the explicit api_key preference)",
    });
  });

  it("display reuse never replaces the runtime's independent readiness check", async () => {
    const f = fixture();
    await displayAccountObservation(f.profile, f.adapter);
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS + 1);
    const displayed = await displayAccountObservation(f.profile, f.adapter);
    expect(displayed.status.verification).toBe("passed");
    expect(displayed.status.last_verified_at).toBe(f.passed.last_verified_at);
    expect(displayed.status.detail).toContain("Last checked");
    f.probe.mockResolvedValue({ ...f.passed, availability: "unavailable", verification: "failed" });
    const admitted = await probeCredentialProfileStatus(
      f.profile,
      f.adapter.probeCredentialProfile?.bind(f.adapter),
    );
    expect(admitted).toMatchObject({ availability: "unavailable", verification: "failed" });
    expect(profileStatusAdmits(f.profile, admitted)).toBe(false);
    expect(f.probe).toHaveBeenCalledTimes(2);
  });

  it("preserves adapter stale evidence when display age increases", async () => {
    const f = fixture();
    f.probe.mockResolvedValue({
      ...f.passed,
      availability: "unknown",
      verification: "not_run",
      stale: true,
      stale_basis: "last_positive_after_timeout",
      stale_age_ms: 1000,
    });
    const first = await displayAccountObservation(f.profile, f.adapter);
    vi.setSystemTime(Date.now() + STATUS_PROJECTION_TTL_MS + 1);
    const later = await displayAccountObservation(f.profile, f.adapter);
    const { detail: _firstDetail, ...firstFact } = first.status;
    const { detail: _laterDetail, ...laterFact } = later.status;
    expect(laterFact).toEqual(firstFact);
    expect(later.status.detail).toContain("Last checked");
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("reprojects current credential rejection and recovery without latching either display verdict", async () => {
    const f = fixture();
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("passed");
    f.setQuota({
      snapshots: [],
      absences: [
        {
          subject: {
            harness: f.profile.harness_id,
            subject_id: f.profile.profile_id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          reason: "auth_revoked",
          detail: "Credential rejected",
          observed_at: new Date().toISOString(),
        },
      ],
      refreshed_at: null,
    });
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("failed");
    expect((await f.catalog()).accounts[0]?.problem?.code).toBe("auth_required");
    f.setQuota({ snapshots: [], absences: [], refreshed_at: null });
    expect((await f.service.credentialProfiles()).profiles[0]?.status.verification).toBe("passed");
    expect(f.probe).toHaveBeenCalledTimes(1);
  });

  it("projects quota observed during the cold probe rather than its pre-probe snapshot", async () => {
    const f = fixture();
    let release!: (value: CredentialProfileStatus) => void;
    f.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.credentialProfiles();
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
    f.setQuota({
      snapshots: [
        {
          subject: {
            harness: f.profile.harness_id,
            subject_id: f.profile.profile_id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          constraints: [
            {
              id: "window",
              label: "Window",
              used_ratio: 1,
              window_seconds: 3600,
              resets_at: "2026-10-04T13:00:00Z",
              cooldown_until: null,
            },
          ],
          source: "codex_app_server",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        },
      ],
      absences: [],
      refreshed_at: null,
    });
    release(f.passed);
    expect((await pending).accountPools[0]?.next_up.kind).toBe("none");
    expect(f.probe).toHaveBeenCalledTimes(1);
  });
});

it("uses a necessary runtime probe to replace display history without another read probe", async () => {
  const f = fixture();
  await displayAccountObservation(f.profile, f.adapter);
  f.probe.mockResolvedValue({ ...f.passed, availability: "unavailable", verification: "failed" });
  const runtime = retainAccountProbeObservations(f.adapter);
  await runtime.probeCredentialProfile!(f.profile);
  const displayed = await displayAccountObservation(f.profile, runtime);
  expect(displayed.status.verification).toBe("failed");
  expect(f.probe).toHaveBeenCalledTimes(2);
});
