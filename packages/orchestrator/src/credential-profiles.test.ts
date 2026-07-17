import { describe, expect, it } from "vitest";
import type { CredentialProfile } from "@claudexor/schema";
import {
  nextEligibleProfile,
  profileHeadroomBreach,
  resolveCredentialProfile,
  rotationRetryEligible,
} from "./credential-profiles.js";
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
    expect(nextEligibleProfile([a, b, c], "claude", policy, "a", [])?.profile_id).toBe("b");
    expect(nextEligibleProfile([a, b], "claude", policy, "a", [], new Set(["b"]))).toBeNull();
    expect(nextEligibleProfile([a, b], "claude", policy, "a", [snap("b", 0.95)])).toBeNull();
    expect(nextEligibleProfile([c, a], "claude", policy, "a", [])).toBeNull();
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
    expect(nextEligibleProfile([a, keyed], "claude", policy, "a", [])).toBeNull();
    // A same-kind candidate later in the order wins over an earlier cross-kind one.
    const ordered = { ...policy, rotation_eligible: ["k", "b"] };
    expect(nextEligibleProfile([a, keyed, b], "claude", ordered, "a", [])?.profile_id).toBe("b");
    // Kind symmetry: an api_key profile rotates only to api_key profiles.
    const keyed2 = { ...keyed, profile_id: "k2", secret_ref: "anthropic:k2" };
    expect(nextEligibleProfile([keyed, keyed2, b], "claude", policy, "k", [])?.profile_id).toBe(
      "k2",
    );
  });
});

describe("rotationRetryEligible (sol #30 predicate)", () => {
  it("requires BOTH the typed limit and an empty deliverable", () => {
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: true })).toBe(true);
    expect(rotationRetryEligible({ sawTypedLimit: false, deliverableEmpty: true })).toBe(false);
    expect(rotationRetryEligible({ sawTypedLimit: true, deliverableEmpty: false })).toBe(false);
  });
});
