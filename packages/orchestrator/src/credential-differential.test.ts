import { describe, expect, it } from "vitest";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialUnusableObservation,
  QuotaAbsence,
} from "@claudexor/schema";
import {
  currentSubjectProber,
  differentialSubjectVerdict,
  readyProfilesForRotation,
  pollerCredentialRejections,
} from "./credential-differential.js";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import type { VendorQuotaObservations } from "./credential-profiles.js";
import type { TransientFailureObservation } from "./transientClassify.js";

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

const emptyQuota = { snapshots: [], absences: [] };

describe("current poller diagnostics after dispatch-bound recovery", () => {
  function fixture() {
    let clock = Date.now();
    const ledger = new CredentialUnusableLedger(() => new Date(clock));
    const refusal: QuotaAbsence = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "work",
      },
      reason: "auth_revoked",
      detail: "original poll rejection",
      observed_at: new Date(clock).toISOString(),
    };
    const subject = {
      harnessId: "claude",
      profileId: "work",
      route: "vendor_native" as const,
      requestedModel: null,
    };
    const evidence = (): VendorQuotaObservations => ({
      snapshots: [],
      absences: [refusal],
      honored: ledger.honored(),
    });
    return {
      ledger,
      refusal,
      subject,
      evidence,
      later() {
        clock += 1000;
        return new Date(clock).toISOString();
      },
    };
  }

  it("keeps exact route and original observation time, without a second stored poller copy", () => {
    const f = fixture();
    const [derived] = pollerCredentialRejections(f.evidence());
    expect(derived).toMatchObject({
      observed_at: f.refusal.observed_at,
      source: "vendor_poller",
      credential_route: "vendor_native",
      detail: f.refusal.detail,
    });
    f.ledger.recordBound(f.ledger.bind(f.subject), derived!);
    expect(f.ledger.live()).toEqual([]);
    expect(pollerCredentialRejections(f.evidence())).toHaveLength(1);
  });

  it("honored contact suppresses old poller diagnostics while a new refusal is still visible", async () => {
    const f = fixture();
    const binding = f.ledger.bind(f.subject);
    f.ledger.honorBound(binding, null, f.later());
    expect(pollerCredentialRejections(f.evidence())).toEqual([]);
    expect(
      await differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: f.evidence(),
        transients: [],
        probe: passingProbe,
      }),
    ).toBeNull();
    f.refusal.observed_at = f.later();
    expect(pollerCredentialRejections(f.evidence())).toHaveLength(1);
    expect(
      await differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: f.evidence(),
        transients: [],
        probe: passingProbe,
      }),
    ).toMatchObject({
      code: "auth_revoked",
      credential_route: "vendor_native",
      observed_at: f.refusal.observed_at,
    });
  });

  it("does not let another route or model-only evidence clear the native account refusal", () => {
    const f = fixture();
    const newer = f.later();
    for (const altered of [
      { credential_route: "managed_api_key" as const, model: null },
      { credential_route: "vendor_native" as const, model: "only-model" },
    ]) {
      const quota = {
        ...f.evidence(),
        honored: [{ harness_id: "claude", profile_id: "work", observed_at: newer, ...altered }],
      };
      expect(pollerCredentialRejections(quota)).toHaveLength(1);
    }
  });

  it("preserves dispatch order when an old execution finishes after a newer refusal", () => {
    const f = fixture();
    const older = f.ledger.bind(f.subject);
    const newer = f.ledger.bind(f.subject);
    f.refusal.observed_at = f.later();
    f.ledger.recordBound(newer, {
      harness_id: "claude",
      profile_id: "work",
      credential_route: "vendor_native",
      model: null,
      source: "attempt_stream",
      code: "auth_revoked",
      detail: "newer execution rejected",
      observed_at: f.refusal.observed_at,
      expires_at: new Date(Date.parse(f.refusal.observed_at) + 60_000).toISOString(),
    });
    f.ledger.honorBound(older, null, f.later());
    expect(f.ledger.honored()).toEqual([]);
    expect(pollerCredentialRejections(f.evidence())).toHaveLength(1);
    f.ledger.honorBound(f.ledger.bind(f.subject), null, f.later());
    expect(pollerCredentialRejections(f.evidence())).toEqual([]);
    expect(f.ledger.live()).toEqual([]);
  });
});

function transient(
  category: TransientFailureObservation["category"],
  retryable: boolean,
  adapterCode: string | null = null,
): TransientFailureObservation {
  return {
    kind: "unknown",
    category,
    retryable,
    retryDelayMs: null,
    httpStatus: null,
    signal: null,
    adapterCode,
  };
}

function passingProbe(profile: CredentialProfile): Promise<CredentialProfileStatus> {
  return Promise.resolve({
    profile_id: profile.profile_id,
    harness_id: profile.harness_id,
    availability: "available",
    verification: "passed",
    verification_source: "local_store",
    last_verified_at: null,
  });
}

function obs(over: Partial<CredentialUnusableObservation>): CredentialUnusableObservation {
  return {
    harness_id: "claude",
    profile_id: "work",
    model: null,
    code: "auth_revoked",
    source: "vendor_poller",
    detail: null,
    observed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
}

describe("differentialSubjectVerdict (A7 — dead credential vs spent quota)", () => {
  it("a typed NON-RETRYABLE model refusal on the attempt stream is the strongest evidence, scoped to the attempt's model", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: "opus",
      quota: emptyQuota,
      transients: [transient("capability_refused", false, "model_not_found")],
      probe: passingProbe,
    });
    expect(verdict).toMatchObject({
      code: "capability_refused",
      source: "attempt_stream",
      model: "opus",
      profile_id: "work",
      detail: "model_not_found",
    });
  });

  it("a typed auth_failed refusal condemns the credential for EVERY model", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: "opus",
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
    });
    expect(verdict).toMatchObject({ code: "auth_revoked", source: "attempt_stream", model: null });
  });

  it("a RETRYABLE rate limit is quota's story, never a dead-credential verdict", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("rate_limited", true)],
      probe: passingProbe,
    });
    expect(verdict).toBeNull();
  });

  it("the poller's typed auth_revoked absence condemns the subject — default subject included", async () => {
    const quota = {
      snapshots: [],
      absences: [
        {
          subject: {
            harness: "claude",
            credential_route: "vendor_native" as const,
            plan_label: null,
            subject_id: null,
          },
          reason: "auth_revoked" as const,
          detail: "vendor rejected the token",
          observed_at: new Date().toISOString(),
        },
      ],
    };
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: null,
      model: null,
      quota,
      transients: [],
    });
    expect(verdict).toMatchObject({
      code: "auth_revoked",
      source: "vendor_poller",
      profile_id: null,
      detail: "vendor rejected the token",
    });
  });

  it("a FAILED local doctor verification is a dead-credential fact (pinned profiles only)", async () => {
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [],
      probe: (profile) =>
        Promise.resolve({
          profile_id: profile.profile_id,
          harness_id: profile.harness_id,
          availability: "unavailable",
          verification: "failed",
          verification_source: "local_store",
          detail: "profile login expired",
          last_verified_at: null,
        }),
    });
    expect(verdict).toMatchObject({ code: "verification_failed", source: "local_probe" });
    // The default subject has no per-profile probe surface: no evidence, no verdict.
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: null,
        model: null,
        quota: emptyQuota,
        transients: [],
      }),
    ).resolves.toBeNull();
  });

  it("every observation self-expires within the 24h bound", async () => {
    const now = new Date();
    const verdict = await differentialSubjectVerdict({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
      now,
    });
    const ttl = Date.parse(verdict!.expires_at) - now.getTime();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});

describe("currentSubjectProber (the sibling probe — NEVER a mini-run)", () => {
  it("records the verdict through the sink and survives a throwing sink", async () => {
    const recorded: CredentialUnusableObservation[] = [];
    const prober = currentSubjectProber({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [transient("auth_failed", false)],
      record: (o) => {
        recorded.push(o);
        throw new Error("sink exploded");
      },
    });
    const verdict = await prober();
    expect(verdict?.code).toBe("auth_revoked");
    expect(recorded).toHaveLength(1);
  });

  it("spends NO quota: the probe path can only reach the doctor probe, never run()", async () => {
    // The design essay's line: a config-dir login has no cheaper liveness test
    // than spending quota on a mini-run — so the prober is handed ONLY the
    // doctor probe. A full adapter proves the boundary: run() must stay cold.
    const calls: string[] = [];
    const adapter = {
      probeCredentialProfile(profile: CredentialProfile) {
        calls.push(`probe:${profile.profile_id}`);
        return passingProbe(profile);
      },
      run() {
        calls.push("run");
        throw new Error("the differential probe must never spawn an attempt");
      },
    };
    const prober = currentSubjectProber({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: emptyQuota,
      transients: [],
      probe: adapter.probeCredentialProfile.bind(adapter),
    });
    await expect(prober()).resolves.toBeNull();
    expect(calls).toEqual(["probe:work"]);
  });
});

describe("readyProfilesForRotation (A7 live-observation refusal at the ONE composition point)", () => {
  const policy = {
    limit_action: "rotate" as const,
    rotation_eligible: [],
    headroom_threshold: 0.9,
  };
  const other = { ...work, profile_id: "other", isolation_locator: "/tmp/p/other" };

  async function readyWith(unusable: readonly CredentialUnusableObservation[], model?: string) {
    return readyProfilesForRotation({
      registry: [work, other],
      harnessId: "claude",
      policy,
      current: work,
      probe: passingProbe,
      quota: emptyQuota,
      unusable,
      model: model ?? null,
    });
  }

  it("a LIVE credential_unusable observation refuses the candidate", async () => {
    expect(await readyWith([])).toEqual(new Set(["other"]));
    expect(await readyWith([obs({ profile_id: "other" })])).toEqual(new Set());
  });

  it("an EXPIRED observation is ignored (clearing contract: self-expiry)", async () => {
    const expired = obs({
      profile_id: "other",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    expect(await readyWith([expired])).toEqual(new Set(["other"]));
  });

  it("a MODEL-SCOPED observation refuses only its own model", async () => {
    const scoped = obs({ profile_id: "other", code: "capability_refused", model: "opus" });
    expect(await readyWith([scoped], "opus")).toEqual(new Set());
    expect(await readyWith([scoped], "sonnet")).toEqual(new Set(["other"]));
  });
});
