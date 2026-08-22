import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import {
  effectiveAuthPreference,
  effectiveLimitAction,
  limitSubjectRoute,
  nextEligibleProfile,
  planReactiveRotation,
  preflightDefaultSubject,
  probeCredentialProfileStatus,
  profileHeadroomBreach,
  resolveCredentialProfile,
  rotateSpecOnTypedLimit,
  rotationRetryEligible,
  selectedProfileAvailability,
  staticRotationCandidates,
  profileStatusAdmits,
  vendorCredentialObservation,
  withVendorCredentialObservation,
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
        profile_id: "work",
        harness_id: "claude",
        availability: "available",
        verification: "failed",
        verification_source: "local_store",
        detail: "wrong credential route",
        last_verified_at: null,
      }),
    });
    expect(failed).toBe("wrong credential route");
    const unverifiedNative = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: async () => ({
        profile_id: "work",
        harness_id: "claude",
        availability: "available",
        verification: "not_run",
        verification_source: "local_store",
        detail: "native session unverified",
        last_verified_at: null,
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
        profile_id: "work",
        harness_id: "claude",
        availability: "available",
        verification: "not_run",
        verification_source: "local_store",
        detail: "secret present",
        last_verified_at: null,
      }),
    });
    expect(presenceOnly).toBe("available");
  });

  it("rejects a live credential ledger verdict before stale LKG admission or another probe", async () => {
    let probes = 0;
    const verdict = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      allowStale: true,
      unusable: [
        {
          harness_id: "claude",
          profile_id: "work",
          model: null,
          code: "auth_revoked",
          source: "vendor_poller",
          detail: "vendor rejected the profile",
          observed_at: "2026-01-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ],
      probe: async () => {
        probes += 1;
        return {
          profile_id: "work",
          harness_id: "claude",
          availability: "unknown" as const,
          verification: "not_run" as const,
          verification_source: "local_store" as const,
          stale: true,
          stale_age_ms: 42,
          detail: "last-known-good",
          last_verified_at: null,
        };
      },
    });
    expect(verdict).toContain("credential is unusable (auth_revoked)");
    expect(probes).toBe(0);
  });

  it("fails closed and redacts both thrown and returned probe diagnostics", async () => {
    const token = `sk-${"a".repeat(48)}`;
    const thrown = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: async () => {
        throw new Error(`vendor probe rejected ${token}`);
      },
    });
    expect(thrown).toContain("profile readiness probe failed");
    expect(thrown).not.toContain(token);

    const returned = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: async () => ({
        profile_id: "work",
        harness_id: "claude",
        availability: "unavailable",
        verification: "failed",
        verification_source: "local_store",
        detail: `credential rejected ${token}`,
        last_verified_at: null,
      }),
    });
    expect(returned).toContain("credential rejected");
    expect(returned).not.toContain(token);
  });

  it("admits stale readiness only when an already selected route opts in", async () => {
    const stale = {
      profile_id: "work",
      harness_id: "claude",
      availability: "unknown" as const,
      verification: "not_run" as const,
      verification_source: "local_store" as const,
      stale: true,
      stale_age_ms: 42,
      detail: "auth-status probe is stale",
      last_verified_at: null,
    };
    await expect(
      selectedProfileAvailability({
        registry: [work],
        profileId: "work",
        harnessId: "claude",
        probe: async () => stale,
      }),
    ).resolves.toBe("auth-status probe is stale");
    await expect(
      selectedProfileAvailability({
        registry: [work],
        profileId: "work",
        harnessId: "claude",
        allowStale: true,
        probe: async () => stale,
      }),
    ).resolves.toBe("available");
  });
});

describe("profileStatusAdmits", () => {
  it("shares the run-admission verification rule with account projection", () => {
    expect(profileStatusAdmits(work, { availability: "available", verification: "passed" })).toBe(
      true,
    );
    expect(profileStatusAdmits(work, { availability: "available", verification: "not_run" })).toBe(
      false,
    );
    expect(
      profileStatusAdmits(
        { credential_kind: "api_key" },
        { availability: "available", verification: "not_run" },
      ),
    ).toBe(true);
    expect(profileStatusAdmits(work, { availability: "unknown", verification: "not_run" })).toBe(
      false,
    );
    expect(
      profileStatusAdmits(work, {
        availability: "unknown",
        verification: "not_run",
        stale: true,
      }),
    ).toBe(false);
    expect(
      profileStatusAdmits(
        work,
        { availability: "unknown", verification: "not_run", stale: true },
        { allowStale: true },
      ),
    ).toBe(true);
    expect(
      profileStatusAdmits(
        { credential_kind: "api_key" },
        { availability: "unknown", verification: "not_run", stale: true },
        { allowStale: true },
      ),
    ).toBe(false);
  });

  it("turns a throwing profile probe into fail-closed readiness", async () => {
    const status = await probeCredentialProfileStatus(work, async () => {
      throw new Error("token=secret probe failed");
    });
    expect(profileStatusAdmits(work, status)).toBe(false);
    expect(status.availability).toBe("unknown");
    expect(status.detail).toContain("profile readiness probe failed");
  });
});

describe("effectiveAuthPreference", () => {
  it("shares run-admission preference precedence", () => {
    expect(effectiveAuthPreference("auto", "api_key", "subscription")).toBe("api_key");
    expect(effectiveAuthPreference(undefined, "auto", "subscription")).toBe("subscription");
    expect(effectiveAuthPreference("auto", undefined, "auto")).toBe("auto");
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
/** The A6 stored default: what an ABSENT profile_policy parses to. */
const autoPolicy = {
  limit_action: "auto" as const,
  rotation_eligible: [],
  headroom_threshold: 0.9,
};
const ready = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe("effectiveLimitAction (A6 kind-aware auto — ONE resolver)", () => {
  it("auto resolves by the subject's credential kind: subscription rotates, metered/unknown fail", () => {
    expect(effectiveLimitAction({ limit_action: "auto" }, "local_session")).toBe("rotate");
    expect(effectiveLimitAction({ limit_action: "auto" }, "api_key")).toBe("fail");
    expect(effectiveLimitAction({ limit_action: "auto" }, null)).toBe("fail");
  });

  it("explicit persisted values pass through untouched on EVERY route (3=A: only ABSENT changed meaning)", () => {
    for (const route of ["local_session", "api_key", null] as const) {
      expect(effectiveLimitAction({ limit_action: "fail" }, route)).toBe("fail");
      expect(effectiveLimitAction({ limit_action: "ask" }, route)).toBe("ask");
      expect(effectiveLimitAction({ limit_action: "rotate" }, route)).toBe("rotate");
    }
  });

  it("limitSubjectRoute: a pinned profile decides by its own kind, the default subject by the caller's estimate", () => {
    expect(limitSubjectRoute(work)).toBe("local_session");
    expect(limitSubjectRoute({ credential_kind: "api_key" })).toBe("api_key");
    expect(limitSubjectRoute({ credential_kind: "oauth_token" })).toBe("local_session");
    expect(limitSubjectRoute(null, "api_key")).toBe("api_key");
    expect(limitSubjectRoute(null)).toBe(null);
  });
});

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

  it("does not rotate an Opus run away from a Fable-scoped limit", () => {
    const scoped = snap("work", 1);
    scoped.constraints[0] = {
      ...scoped.constraints[0]!,
      id: "weekly_scoped:Fable",
      applies_to_models: ["fable", "claude-fable-5"],
    };
    expect(profileHeadroomBreach([scoped], "claude", "work", 0.9, "claude-opus-5")).toBeNull();
    expect(profileHeadroomBreach([scoped], "claude", "work", 0.9, null)).toBeNull();
    expect(profileHeadroomBreach([scoped], "claude", "work", 0.9)).toMatchObject({
      constraint_id: "weekly_scoped:Fable",
    });
    expect(profileHeadroomBreach([scoped], "claude", "work", 0.9, "claude-fable-5")).toMatchObject({
      constraint_id: "weekly_scoped:Fable",
    });
  });
});

describe("nextEligibleProfile (W5.4 rotation order)", () => {
  const a = { ...work, profile_id: "a" };
  const b = { ...work, profile_id: "b" };
  const c = { ...work, profile_id: "c", enabled: false };

  it("registry order by default; skips current, disabled, excluded, and spent profiles", () => {
    expect(
      nextEligibleProfile([a, b, c], "claude", policy, a, [], ready("a", "b"))?.profile_id,
    ).toBe("b");
    expect(
      nextEligibleProfile([a, b], "claude", policy, a, [], ready("a", "b"), new Set(["b"])),
    ).toBeNull();
    expect(
      nextEligibleProfile([a, b], "claude", policy, a, [snap("b", 0.95)], ready("a", "b")),
    ).toBeNull();
    expect(nextEligibleProfile([c, a], "claude", policy, a, [], ready("a"))).toBeNull();
  });

  it("policy order wins over registry order", () => {
    const ordered = { ...policy, rotation_eligible: ["b", "a"] };
    expect(
      nextEligibleProfile([a, b], "claude", ordered, null, [], ready("a", "b"))?.profile_id,
    ).toBe("b");
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
    expect(nextEligibleProfile([a, keyed], "claude", policy, a, [], ready("a", "k"))).toBeNull();
    // A same-kind candidate later in the order wins over an earlier cross-kind one.
    const ordered = { ...policy, rotation_eligible: ["k", "b"] };
    expect(
      nextEligibleProfile([a, keyed, b], "claude", ordered, a, [], ready("a", "k", "b"))
        ?.profile_id,
    ).toBe("b");
    // Kind symmetry: an api_key profile rotates only to api_key profiles.
    const keyed2 = { ...keyed, profile_id: "k2", secret_ref: "anthropic:k2" };
    expect(
      nextEligibleProfile([keyed, keyed2, b], "claude", policy, keyed, [], ready("k", "k2", "b"))
        ?.profile_id,
    ).toBe("k2");
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
    expect(nextEligibleProfile([keyed], "claude", policy, a, [], ready("k"))).toBeNull();
    expect(
      nextEligibleProfile([keyed, b], "claude", policy, a, [], ready("k", "b"))?.profile_id,
    ).toBe("b");
  });

  it("skips an enabled but unready target and selects the next ready sibling", () => {
    expect(nextEligibleProfile([a, b], "claude", policy, null, [], ready("b"))?.profile_id).toBe(
      "b",
    );
    expect(nextEligibleProfile([a], "claude", policy, null, [], ready())).toBeNull();
  });

  it("filters policy, current identity, kind, and tried profiles before readiness probing", () => {
    const keyed = {
      ...work,
      profile_id: "keyed",
      credential_kind: "api_key" as const,
      isolation_locator: null,
      secret_ref: "anthropic:keyed",
    };
    const outsidePolicy = { ...work, profile_id: "outside" };
    expect(
      staticRotationCandidates({
        registry: [a, b, keyed, outsidePolicy],
        harnessId: "claude",
        policy: { ...policy, rotation_eligible: ["a", "keyed", "b"] },
        current: a,
        excluded: new Set(["b"]),
      }),
    ).toEqual([]);
    expect(
      staticRotationCandidates({
        registry: [a, b, keyed, outsidePolicy],
        harnessId: "claude",
        policy: { ...policy, rotation_eligible: ["a", "keyed", "b"] },
        current: a,
      }).map((profile) => profile.profile_id),
    ).toEqual(["b"]);
  });
});

describe("rotationRetryEligible (sol #30 predicate)", () => {
  it("requires BOTH the typed limit and an empty deliverable", () => {
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: true })).toBe(true);
    expect(rotationRetryEligible({ sawTypedLimit: false, deliverableEmpty: true })).toBe(false);
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: false })).toBe(false);
  });

  it("A2 structural branch: a terminal non-transient pre-progress death is eligible; absent fields stay conservative", () => {
    // The full structural shape fires without any typed limit (owner 7=A).
    expect(
      rotationRetryEligible({
        sawTypedLimit: false,
        deliverableEmpty: true,
        mutationObserved: false,
        terminalNonTransientDeath: true,
        sawAgentProgress: false,
      }),
    ).toBe(true);
    // Any agent progress under the current credential blocks it (sol amendment:
    // a tool_call may have external side effects — never silently replay).
    expect(
      rotationRetryEligible({
        sawTypedLimit: false,
        deliverableEmpty: true,
        terminalNonTransientDeath: true,
        sawAgentProgress: true,
      }),
    ).toBe(false);
    // An observed mutation blocks BOTH branches — typed fast path included.
    expect(
      rotationRetryEligible({
        sawTypedLimit: true,
        deliverableEmpty: true,
        mutationObserved: true,
      }),
    ).toBe(false);
    // A transient-retryable death is NOT a structural death (same-profile
    // retry machinery owns it): the builder encodes that as
    // terminalNonTransientDeath=false, which never fires.
    expect(
      rotationRetryEligible({
        sawTypedLimit: false,
        deliverableEmpty: true,
        terminalNonTransientDeath: false,
        sawAgentProgress: false,
      }),
    ).toBe(false);
    // The typed fast path is NOT hardened against progress (W5.4 canon:
    // no-deliverable/no-mutation, not no-progress).
    expect(
      rotationRetryEligible({
        sawTypedLimit: true,
        deliverableEmpty: true,
        sawAgentProgress: true,
      }),
    ).toBe(true);
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
    expect(nextEligibleProfile([keyed], "claude", policy, null, [], ready("k"))).toBeNull();
    expect(
      nextEligibleProfile([keyed, a], "claude", policy, null, [], ready("k", "a"))?.profile_id,
    ).toBe("a");
  });

  it("preflightDefaultSubject: rotate + fresh default breach starts on the next subscription profile with full provenance", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = preflightDefaultSubject({
      harnessId: "claude",
      policy,
      registry: [a, b],
      snapshots: [snap(null, 0.95)],
      readyProfileIds: ready("a", "b"),
      defaultRoute: "local_session",
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
      readyProfileIds: ready("a", "b"),
      defaultRoute: "local_session",
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

  it("names not-ready targets in rotation exhaustion evidence", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = preflightDefaultSubject({
      harnessId: "claude",
      policy,
      registry: [a],
      snapshots: [snap(null, 0.97)],
      readyProfileIds: ready(),
      defaultRoute: "local_session",
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(next).toBeNull();
    expect(events.at(-1)?.[1]).toMatchObject({
      candidates: [{ profile_id: "a", rejected: "not_ready" }],
    });
  });

  it("the A6 auto default rotates the SUBSCRIPTION default subject exactly like explicit rotate — no configuration needed", () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const next = preflightDefaultSubject({
      harnessId: "claude",
      policy: autoPolicy,
      registry: [a, b],
      snapshots: [snap(null, 0.95)],
      readyProfileIds: ready("a", "b"),
      defaultRoute: "local_session",
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(next?.profile_id).toBe("a");
    expect(events.map(([t]) => t)).toEqual([
      "route.profile.headroom_exceeded",
      "route.profile.rotated",
    ]);
  });

  it("the A6 auto default keeps a METERED (api_key / unknown-route) default subject untouched — a metered limit is a budget fact", () => {
    for (const defaultRoute of ["api_key", null] as const) {
      const events: string[] = [];
      const next = preflightDefaultSubject({
        harnessId: "claude",
        policy: autoPolicy,
        registry: [a],
        snapshots: [snap(null, 0.99)],
        readyProfileIds: ready("a"),
        defaultRoute,
        emit: (type) => events.push(type),
      });
      expect(next).toBeNull();
      expect(events).toEqual([]);
    }
  });

  it("EXPLICIT fail/ask keep the default user untouched (no events, no selection) — persisted opt-outs survive A6 (3=A)", () => {
    for (const limit_action of ["fail", "ask"] as const) {
      const events: string[] = [];
      const next = preflightDefaultSubject({
        harnessId: "claude",
        policy: { ...policy, limit_action },
        registry: [a],
        snapshots: [snap(null, 0.99)],
        readyProfileIds: ready("a"),
        defaultRoute: "local_session",
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
    const base = {
      harnessId: "claude",
      policy,
      registry: [a],
      readyProfileIds: ready("a"),
      defaultRoute: "local_session" as const,
      emit,
    };
    expect(preflightDefaultSubject({ ...base, snapshots: [] })).toBeNull();
    expect(preflightDefaultSubject({ ...base, snapshots: [snap(null, 0.5)] })).toBeNull();
    // Profile "a" being spent says nothing about the DEFAULT subject.
    expect(preflightDefaultSubject({ ...base, snapshots: [snap("a", 0.99)] })).toBeNull();
  });

  it("never rotates an API-key default into a subscription profile", () => {
    const events: string[] = [];
    expect(
      preflightDefaultSubject({
        harnessId: "claude",
        policy,
        registry: [a],
        snapshots: [snap(null, 0.99)],
        readyProfileIds: ready("a"),
        defaultRoute: "api_key",
        emit: (type) => events.push(type),
      }),
    ).toBeNull();
    expect(events).toEqual([]);
  });

  it("planReactiveRotation from the default subject REQUIRES the vendor_native route proof", () => {
    const args = {
      currentProfile: null,
      harnessId: "claude",
      attemptId: "a01",
      policy,
      registry: [a],
      snapshots: [],
      readyProfileIds: ready("a"),
      triedProfiles: new Set<string>(),
      evidence: {
        sawTypedLimit: true,
        deliverableEmpty: true,
        mutationObserved: false,
        terminalNonTransientDeath: false,
        sawAgentProgress: false,
      },
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

  it("rotateSpecOnTypedLimit rebuilds a profile-less spec onto the rotation target with a fresh session", async () => {
    const spec = HarnessRunSpecSchema.parse({
      session_id: "se-1",
      intent: "implement",
      prompt: "go",
      cwd: "/repo",
      resume_session_id: "native-123",
    });
    const base = {
      spec,
      harnessId: "claude",
      attemptId: "a01",
      policy,
      registry: [a],
      snapshots: [],
      probeReadyProfiles: async () => ready("a"),
      markers: { sawAgentProgress: false, fileChanges: 0 },
      sawTypedLimit: true,
      sawRetryable: true,
      attemptErrored: true,
      deliverableEmpty: true,
      lastLimit: null,
      emit: () => {},
      newSessionId: () => "se-2",
    };
    const rotated = await rotateSpecOnTypedLimit({
      ...base,
      triedProfiles: new Set<string>(),
      defaultRouteWasVendorNative: true,
    });
    const spec2 = rotated && !("poolExhausted" in rotated) ? rotated : null;
    expect(spec2?.credential_profile?.profile_id).toBe("a");
    expect(spec2?.session_id).toBe("se-2");
    expect(spec2?.resume_session_id).toBeNull();
    // Without the route proof the profile-less spec must fail as-is.
    await expect(
      rotateSpecOnTypedLimit({ ...base, triedProfiles: new Set<string>() }),
    ).resolves.toBeNull();
  });

  it("rotateSpecOnTypedLimit probes readiness for a STRUCTURAL pre-progress death too (A2 pre-gate)", async () => {
    const spec = HarnessRunSpecSchema.parse({
      session_id: "se-1",
      intent: "implement",
      prompt: "go",
      cwd: "/repo",
    });
    let probed = 0;
    const base = {
      spec,
      harnessId: "claude",
      attemptId: "a01",
      policy,
      registry: [a],
      snapshots: [],
      probeReadyProfiles: async () => {
        probed += 1;
        return ready("a");
      },
      markers: { sawAgentProgress: false, fileChanges: 0 },
      sawTypedLimit: false,
      sawRetryable: false,
      attemptErrored: true,
      deliverableEmpty: true,
      lastLimit: null,
      emit: () => {},
      newSessionId: () => "se-2",
      defaultRouteWasVendorNative: true,
    };
    // Untyped terminal non-transient death, no progress, no mutation → the
    // probe fires and the rotation lands on the ready candidate.
    const rotated = await rotateSpecOnTypedLimit({ ...base, triedProfiles: new Set<string>() });
    expect(probed).toBe(1);
    const rotatedSpec = rotated && !("poolExhausted" in rotated) ? rotated : null;
    expect(rotatedSpec?.credential_profile?.profile_id).toBe("a");
    // Progress under the current credential blocks the structural branch AND
    // the probe (readiness is never spent on an ineligible try).
    const blocked = await rotateSpecOnTypedLimit({
      ...base,
      markers: { sawAgentProgress: true, fileChanges: 0 },
      triedProfiles: new Set<string>(),
    });
    expect(blocked).toBeNull();
    expect(probed).toBe(1);
    // A retryable transient death belongs to the same-profile retry machinery.
    await expect(
      rotateSpecOnTypedLimit({ ...base, sawRetryable: true, triedProfiles: new Set<string>() }),
    ).resolves.toBeNull();
    // An observed file_change is a mutation even with an empty workspace diff.
    await expect(
      rotateSpecOnTypedLimit({
        ...base,
        markers: { sawAgentProgress: false, fileChanges: 1 },
        triedProfiles: new Set<string>(),
      }),
    ).resolves.toBeNull();
  });
});

describe("vendor credential observation (honest profile verification)", () => {
  const local = {
    profile_id: "work",
    harness_id: "claude",
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    detail: "claude.ai login verified in the profile config dir",
    last_verified_at: "2026-07-17T11:00:00Z",
  } as const;

  const revoked = {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "work",
    },
    reason: "auth_revoked",
    detail: "oauth/usage responded 401",
    observed_at: "2026-07-17T12:00:00Z",
  } as const;

  it("reads a successful authenticated poll as the vendor honoring the credential", () => {
    expect(
      vendorCredentialObservation(
        { snapshots: [snap("work", 0.1)], absences: [] },
        "claude",
        "work",
      ),
    ).toEqual({ outcome: "honored", observed_at: "2026-07-17T12:00:00Z" });
  });

  it("ignores every reactive/spool source — usage is not credential liveness", () => {
    for (const source of ["claude_statusline", "claude_api_retry", "codex_rollout"] as const) {
      const evidence = { ...snap("work", 0.1), source };
      expect(
        vendorCredentialObservation({ snapshots: [evidence], absences: [] }, "claude", "work"),
      ).toBeNull();
    }
  });

  it("has no verdict for another subject's evidence", () => {
    expect(
      vendorCredentialObservation({ snapshots: [], absences: [revoked] }, "claude", "personal"),
    ).toBeNull();
    expect(
      vendorCredentialObservation({ snapshots: [], absences: [revoked] }, "codex", "work"),
    ).toBeNull();
  });

  it("downgrades a locally-passing profile the vendor has rejected", () => {
    const status = withVendorCredentialObservation(
      local,
      vendorCredentialObservation({ snapshots: [], absences: [revoked] }, "claude", "work"),
    );
    expect(status).toMatchObject({
      verification: "failed",
      verification_source: "vendor",
      last_verified_at: "2026-07-17T12:00:00Z",
    });
    // The whole point of task 4: admission must now refuse the dead account.
    expect(profileStatusAdmits({ credential_kind: "config_dir_login" }, status)).toBe(false);
  });

  it("re-stamps provenance on a passing profile the vendor answered for", () => {
    const status = withVendorCredentialObservation(
      local,
      vendorCredentialObservation(
        { snapshots: [snap("work", 0.1)], absences: [] },
        "claude",
        "work",
      ),
    );
    expect(status).toMatchObject({
      verification: "passed",
      verification_source: "vendor",
      last_verified_at: "2026-07-17T12:00:00Z",
    });
  });

  it("never upgrades a locally-failed verdict — the local probe knows more", () => {
    const wrongMethod = { ...local, verification: "failed" } as const;
    expect(
      withVendorCredentialObservation(
        wrongMethod,
        vendorCredentialObservation(
          { snapshots: [snap("work", 0.1)], absences: [] },
          "claude",
          "work",
        ),
      ),
    ).toEqual(wrongMethod);
  });

  it("leaves the status untouched when the poller has no verdict", () => {
    expect(withVendorCredentialObservation(local, null)).toEqual(local);
  });

  it("lets a rejection outrank a cached success, and refuses the profile", () => {
    // Snapshots and absences are read through two separate calls, so a refresh
    // cycle landing between them can hand one subject both. Reading the older
    // success first is what reported a revoked credential as vendor-verified
    // and then dispatched a run onto it.
    const evidence = { snapshots: [snap("work", 0.1)], absences: [revoked] };
    expect(vendorCredentialObservation(evidence, "claude", "work")).toEqual({
      outcome: "revoked",
      observed_at: "2026-07-17T12:00:00Z",
      detail: "oauth/usage responded 401",
    });
    const status = withVendorCredentialObservation(
      local,
      vendorCredentialObservation(evidence, "claude", "work"),
    );
    expect(status).toMatchObject({ verification: "failed", verification_source: "vendor" });
    expect(profileStatusAdmits({ credential_kind: "config_dir_login" }, status)).toBe(false);
  });
});

describe("run admission reads the vendor's verdict, not just the local store", () => {
  const revoked = {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: "work",
    },
    reason: "auth_revoked",
    detail: "oauth/usage responded 401",
    observed_at: "2026-07-17T12:00:00Z",
  } as const;

  const locallyPassing = async () =>
    ({
      profile_id: "work",
      harness_id: "claude",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "claude.ai login verified in the profile config dir",
      last_verified_at: "2026-07-17T11:00:00Z",
    }) as const;

  it("refuses a locally-passing profile the vendor already rejected", async () => {
    // Exactly the state that made this a bug: the Accounts card renders
    // `verification: failed` from this same quota response while the router
    // dispatched the run into the dead token.
    const verdict = await selectedProfileAvailability({
      registry: [work],
      profileId: "work",
      harnessId: "claude",
      probe: locallyPassing,
      quota: { snapshots: [], absences: [revoked] },
    });
    expect(verdict).toBe("oauth/usage responded 401");
  });

  it("still admits when the poller has no verdict for that subject", async () => {
    const otherSubject = { ...revoked, subject: { ...revoked.subject, subject_id: "personal" } };
    expect(
      await selectedProfileAvailability({
        registry: [work],
        profileId: "work",
        harnessId: "claude",
        probe: locallyPassing,
        quota: { snapshots: [], absences: [otherSubject] },
      }),
    ).toBe("available");
    expect(
      await selectedProfileAvailability({
        registry: [work],
        profileId: "work",
        harnessId: "claude",
        probe: locallyPassing,
        quota: { snapshots: [], absences: [] },
      }),
    ).toBe("available");
  });
});

describe("A7 differential probe wiring in rotateSpecOnTypedLimit", () => {
  const a = { ...work, profile_id: "a" };
  const b = { ...work, profile_id: "b", isolation_locator: "/tmp/p/b" };
  const spec = HarnessRunSpecSchema.parse({
    session_id: "se-1",
    intent: "implement",
    prompt: "go",
    cwd: "/repo",
    credential_profile: a,
  });
  const unusableA = {
    harness_id: "claude",
    profile_id: "a",
    model: null,
    code: "auth_revoked" as const,
    source: "attempt_stream" as const,
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const base = {
    spec,
    harnessId: "claude",
    attemptId: "a01",
    policy,
    registry: [a, b],
    snapshots: [],
    markers: { sawAgentProgress: false, fileChanges: 0 },
    sawTypedLimit: true,
    sawRetryable: true,
    attemptErrored: true,
    deliverableEmpty: true,
    lastLimit: null,
    emit: () => {},
    newSessionId: () => "se-2",
  };

  it("the sibling probe fires ONLY on rotation-eligible failures — an ordinary error never probes", async () => {
    let probes = 0;
    const probeCurrentSubject = async () => {
      probes += 1;
      return null;
    };
    // Ordinary transient-retryable death without a typed limit: not eligible.
    await rotateSpecOnTypedLimit({
      ...base,
      sawTypedLimit: false,
      probeReadyProfiles: async () => ready("b"),
      probeCurrentSubject,
      triedProfiles: new Set<string>(),
    });
    // A delivered attempt: not eligible either.
    await rotateSpecOnTypedLimit({
      ...base,
      deliverableEmpty: false,
      probeReadyProfiles: async () => ready("b"),
      probeCurrentSubject,
      triedProfiles: new Set<string>(),
    });
    expect(probes).toBe(0);
    // A typed vendor limit IS eligible: the sibling probe fires exactly once.
    const rotated = await rotateSpecOnTypedLimit({
      ...base,
      probeReadyProfiles: async () => ready("b"),
      probeCurrentSubject,
      triedProfiles: new Set<string>(),
    });
    expect(probes).toBe(1);
    expect(
      rotated && !("poolExhausted" in rotated) ? rotated.credential_profile?.profile_id : null,
    ).toBe("b");
  });

  it("a typed verdict is emitted as route.profile.credential_unusable with the attempt stamped", async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    await rotateSpecOnTypedLimit({
      ...base,
      probeReadyProfiles: async () => ready("b"),
      probeCurrentSubject: async () => unusableA,
      triedProfiles: new Set<string>(),
      emit: (type, payload) => events.push([type, payload]),
    });
    const emitted = events.find(([t]) => t === "route.profile.credential_unusable");
    expect(emitted?.[1]).toMatchObject({
      harness_id: "claude",
      profile_id: "a",
      code: "auth_revoked",
      source: "attempt_stream",
      attempt_id: "a01",
    });
  });

  it("pool terminal carries the dead-credential provenance, and a condemned candidate is refused TYPED", async () => {
    const unusableB = { ...unusableA, profile_id: "b" };
    const events: Array<[string, Record<string, unknown>]> = [];
    const out = await rotateSpecOnTypedLimit({
      ...base,
      // The overlay refused b upstream (readyProfileIdsForRotation); the row
      // must say WHY, typed, instead of hiding behind not_ready.
      probeReadyProfiles: async () => ready(),
      probeCurrentSubject: async () => unusableA,
      liveUnusable: [unusableB],
      triedProfiles: new Set<string>(),
      emit: (type, payload) => events.push([type, payload]),
    });
    expect(out && "poolExhausted" in out).toBe(true);
    const failure = out && "poolExhausted" in out ? out.poolExhausted : null;
    expect(failure?.message).toContain("observed unusable (auth_revoked)");
    expect(failure).toMatchObject({ code: "credential_pool_exhausted" });
    const exhausted = events.find(([t]) => t === "route.profile.rotation_exhausted");
    const rows = (exhausted?.[1]?.candidates ?? []) as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.profile_id === "b")).toMatchObject({
      rejected: "credential_unusable",
      unusable: { code: "auth_revoked", source: "attempt_stream" },
    });
  });

  it("the DEAD subject's typed-limit reset never becomes the pool's reopen promise", async () => {
    // Pool of one: the dead, limited subject itself. Its typed stream limit
    // names a reset — but a dead credential's window reopening will never
    // help, so the terminal's resetsAt stays honestly null instead of
    // promising the dead subject's own reset.
    const out = await rotateSpecOnTypedLimit({
      ...base,
      registry: [a],
      probeReadyProfiles: async () => ready(),
      probeCurrentSubject: async () => unusableA,
      liveUnusable: [unusableA],
      triedProfiles: new Set<string>(),
      lastLimit: { retryDelayMs: null, resetsAt: "2026-09-12T00:00:00.000Z" },
    });
    expect(out && "poolExhausted" in out).toBe(true);
    const failure =
      out && "poolExhausted" in out
        ? (out.poolExhausted as Error & { resetsAt?: string | null })
        : null;
    expect(failure?.resetsAt).toBeNull();
    expect(failure?.message).toContain("observed unusable (auth_revoked)");
  });
});
