import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import {
  nextEligibleProfile,
  planReactiveRotation,
  preflightDefaultSubject,
  profileHeadroomBreach,
  resolveCredentialProfile,
  rotateSpecOnTypedLimit,
  rotationRetryEligible,
  selectedProfileAvailability,
} from "./credential-profiles.js";
import { HarnessRunSpec as HarnessRunSpecSchema } from "@claudexor/schema";
import type { QuotaSnapshot } from "@claudexor/schema";

const work: CredentialProfile = {
  profile_id: "work",
  harness_id: "claude",
  display_name: "Work",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/p/work",
  secret_ref: null,
  enabled: true,
  created_at: null,
};

describe("resolveCredentialProfile (INV-135, the one resolve owner)", () => {
  it("returns the exact registry entry for a matching harness", () => {
    expect(resolveCredentialProfile([work], "work", "claude")).toBe(work);
  });

  it("refuses an unknown id — an explicit profile never defaults", () => {
    expect(() => resolveCredentialProfile([work], "ghost", "claude")).toThrow(/not registered/);
  });

  it("refuses a harness-mismatched id (same name registered for another harness)", () => {
    expect(() => resolveCredentialProfile([work], "work", "codex")).toThrow(/not registered/);
  });

  it("refuses a disabled profile", () => {
    expect(() => resolveCredentialProfile([{ ...work, enabled: false }], "work", "claude")).toThrow(
      /disabled/,
    );
  });
});

describe("selectedProfileAvailability", () => {
  it("rejects available-but-failed verification while preserving presence-only not_run", async () => {
    const failed = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: async () => ({
        availability: "available",
        verification: "failed",
        detail: "wrong credential route",
      }),
    });
    expect(failed).toBe("wrong credential route");
    const unverifiedNative = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: async () => ({
        availability: "available",
        verification: "not_run",
        detail: "native session unverified",
      }),
    });
    expect(unverifiedNative).toBe("native session unverified");
    const apiKey = {
      ...work,
      credential_kind: "api_key" as const,
      isolation_locator: null,
      secret_ref: "anthropic:work",
    };
    const presenceOnly = await selectedProfileAvailability({
      registry: [apiKey],
      profileId: "work",
      harnessId: "claude",
      probe: async () => ({
        availability: "available",
        verification: "not_run",
        detail: "secret present",
      }),
    });
    expect(presenceOnly).toBe("available");
  });
});

function snap(profileId: string | null, usedRatio: number | null): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: profileId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18000,
        resets_at: null,
        cooldown_until: null,
      },
    ],
    source: "claude_oauth_usage",
    observed_at: "2026-07-17T12:00:00Z",
    freshness: "fresh",
  } as QuotaSnapshot;
}

const policy = { limit_action: "rotate" as const, rotation_eligible: [], headroom_threshold: 0.9 };

describe("profileHeadroomBreach (W5.4 preflight)", () => {
  it("flags a window at/over the threshold with typed evidence", () => {
    const breach = profileHeadroomBreach([snap("work", 0.95)], "claude", "work", 0.9);
    expect(breach).toMatchObject({ constraint_id: "five_hour", used_ratio: 0.95, threshold: 0.9 });
  });

  it("unknown usage and other subjects are NEVER a breach", () => {
    expect(profileHeadroomBreach([snap("work", null)], "claude", "work", 0.9)).toBeNull();
    expect(profileHeadroomBreach([snap("other", 0.99)], "claude", "work", 0.9)).toBeNull();
    expect(profileHeadroomBreach([snap(null, 0.99)], "claude", "work", 0.9)).toBeNull();
    expect(profileHeadroomBreach([snap("work", 0.5)], "claude", "work", 0.9)).toBeNull();
  });
});

describe("nextEligibleProfile (W5.4 rotation order)", () => {
  const a = { ...work, profile_id: "a" };
  const b = { ...work, profile_id: "b" };
  const c = { ...work, profile_id: "c", enabled: false };

  it("registry order by default; skips current, disabled, excluded, and spent profiles", () => {
    expect(nextEligibleProfile([a, b, c], "claude", policy, a, [])?.profile_id).toBe("b");
    expect(nextEligibleProfile([a, b], "claude", policy, a, [], new Set(["b"]))).toBeNull();
    expect(nextEligibleProfile([a, b], "claude", policy, a, [snap("b", 0.95)])).toBeNull();
    expect(nextEligibleProfile([c, a], "claude", policy, a, [])).toBeNull();
  });

  it("policy order wins over registry order", () => {
    const ordered = { ...policy, rotation_eligible: ["b", "a"] };
    expect(nextEligibleProfile([a, b], "claude", ordered, null, [])?.profile_id).toBe("b");
  });

  it("rotation NEVER crosses credential kinds (round-16 BLOCK): a subscription→API-key swap would misvalue metered usage under the attempt's first-wins route receipt", () => {
    const keyed = {
      ...work,
      profile_id: "k",
      credential_kind: "api_key" as const,
      isolation_locator: null,
      secret_ref: "anthropic:k",
    };
    // The only remaining candidate pays with a different transport: no target.
    expect(nextEligibleProfile([a, keyed], "claude", policy, a, [])).toBeNull();
    // A same-kind candidate later in the order wins over an earlier cross-kind one.
    const ordered = { ...policy, rotation_eligible: ["k", "b"] };
    expect(nextEligibleProfile([a, keyed, b], "claude", ordered, a, [])?.profile_id).toBe("b");
    // Kind symmetry: an api_key profile rotates only to api_key profiles.
    const keyed2 = { ...keyed, profile_id: "k2", secret_ref: "anthropic:k2" };
    expect(nextEligibleProfile([keyed, keyed2, b], "claude", policy, keyed, [])?.profile_id).toBe(
      "k2",
    );
  });

  it("the kind guard FAILS CLOSED when the current profile vanished from the reloaded pool (round-17 hardening)", () => {
    const keyed = {
      ...work,
      profile_id: "k",
      credential_kind: "api_key" as const,
      isolation_locator: null,
      secret_ref: "anthropic:k",
    };
    // The current profile was disabled/removed mid-attempt: it is absent from
    // the registry, but its TYPED kind still forbids a cross-kind swap.
    expect(nextEligibleProfile([keyed], "claude", policy, a, [])).toBeNull();
    expect(nextEligibleProfile([keyed, b], "claude", policy, a, [])?.profile_id).toBe("b");
  });
});

describe("rotationRetryEligible (sol #30 predicate)", () => {
  it("requires BOTH the typed limit and an empty deliverable", () => {
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: true })).toBe(true);
    expect(rotationRetryEligible({ sawTypedLimit: false, deliverableEmpty: true })).toBe(false);
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: false })).toBe(false);
  });
});

describe("default-subject auto-balance (INV-135 owner scope)", () => {
  const a = { ...work, profile_id: "a" };
  const b = { ...work, profile_id: "b" };
  const keyed = {
    ...work,
    profile_id: "k",
    credential_kind: "api_key" as const,
    isolation_locator: null,
    secret_ref: "anthropic:k",
  };

  it("null current (default subject) never rotates INTO an api_key profile — the round-16 BLOCK generalized", () => {
    expect(nextEligibleProfile([keyed], "claude", policy, null, [])).toBeNull();
    expect(nextEligibleProfile([keyed, a], "claude", policy, null, [])?.profile_id).toBe("a");
  });

  it("preflightDefaultSubject: rotate + fresh default breach starts on the next subscription profile with full provenance", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = preflightDefaultSubject({
      harnessId: "claude",
      policy,
      registry: [a, b],
      snapshots: [snap(null, 0.95)],
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(next?.profile_id).toBe("a");
    expect(events.map(([t]) => t)).toEqual([
      "route.profile.headroom_exceeded",
      "route.profile.rotated",
    ]);
    expect(events[0]?.[1]).toMatchObject({ profile_id: null, used_ratio: 0.95 });
    expect(events[1]?.[1]).toMatchObject({ from_profile_id: null, to_profile_id: "a" });
  });

  it("emits typed rotation_exhausted evidence when every profile is also spent", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = preflightDefaultSubject({
      harnessId: "claude",
      policy,
      registry: [a, b],
      snapshots: [snap(null, 0.97), snap("a", 0.97), snap("b", 1)],
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(next).toBeNull();
    expect(events.map(([type]) => type)).toEqual([
      "route.profile.headroom_exceeded",
      "route.profile.rotation_exhausted",
    ]);
    expect(events[1]?.[1]).toMatchObject({
      from_profile_id: null,
      reason: "profile_headroom_preflight",
      candidates: [
        { profile_id: "a", rejected: "headroom_exceeded" },
        { profile_id: "b", rejected: "headroom_exceeded" },
      ],
    });
  });

  it("preflightDefaultSubject is strictly opt-in: fail/ask keep the default user untouched (no events, no selection)", () => {
    for (const limit_action of ["fail", "ask"] as const) {
      const events: string[] = [];
      const next = preflightDefaultSubject({
        harnessId: "claude",
        policy: { ...policy, limit_action },
        registry: [a],
        snapshots: [snap(null, 0.99)],
        emit: (type) => events.push(type),
      });
      expect(next).toBeNull();
      expect(events).toEqual([]);
    }
  });

  it("preflightDefaultSubject never rotates on missing, healthy, or profile-scoped usage", () => {
    const emit = () => {
      throw new Error("no event expected");
    };
    const base = { harnessId: "claude", policy, registry: [a], emit };
    expect(preflightDefaultSubject({ ...base, snapshots: [] })).toBeNull();
    expect(preflightDefaultSubject({ ...base, snapshots: [snap(null, 0.5)] })).toBeNull();
    // Profile "a" being spent says nothing about the DEFAULT subject.
    expect(preflightDefaultSubject({ ...base, snapshots: [snap("a", 0.99)] })).toBeNull();
  });

  it("planReactiveRotation from the default subject REQUIRES the vendor_native route proof", () => {
    const args = {
      currentProfile: null,
      harnessId: "claude",
      attemptId: "a01",
      policy,
      registry: [a],
      snapshots: [],
      triedProfiles: new Set<string>(),
      sawTypedLimit: true,
      deliverableEmpty: true,
      lastLimit: null,
      emit: () => {},
    };
    expect(planReactiveRotation(args)).toBeNull();
    expect(planReactiveRotation({ ...args, defaultRouteWasVendorNative: false })).toBeNull();
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = planReactiveRotation({
      ...args,
      defaultRouteWasVendorNative: true,
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(next?.profile_id).toBe("a");
    expect(events[0]?.[0]).toBe("route.profile.rotated");
    expect(events[0]?.[1]).toMatchObject({ from_profile_id: null, to_profile_id: "a" });
  });

  it("rotateSpecOnTypedLimit rebuilds a profile-less spec onto the rotation target with a fresh session", () => {
    const spec = HarnessRunSpecSchema.parse({
      session_id: "se-1",
      intent: "implement",
      prompt: "go",
      cwd: "/repo",
      resume_session_id: "native-123",
    });
    const rotated = rotateSpecOnTypedLimit({
      spec,
      harnessId: "claude",
      attemptId: "a01",
      policy,
      registry: [a],
      snapshots: [],
      triedProfiles: new Set<string>(),
      sawTypedLimit: true,
      deliverableEmpty: true,
      lastLimit: null,
      emit: () => {},
      newSessionId: () => "se-2",
      defaultRouteWasVendorNative: true,
    });
    expect(rotated?.credential_profile?.profile_id).toBe("a");
    expect(rotated?.session_id).toBe("se-2");
    expect(rotated?.resume_session_id).toBeNull();
    // Without the route proof the profile-less spec must fail as-is.
    expect(
      rotateSpecOnTypedLimit({
        spec,
        harnessId: "claude",
        attemptId: "a01",
        policy,
        registry: [a],
        snapshots: [],
        triedProfiles: new Set<string>(),
        sawTypedLimit: true,
        deliverableEmpty: true,
        lastLimit: null,
        emit: () => {},
        newSessionId: () => "se-2",
      }),
    ).toBeNull();
  });
});
