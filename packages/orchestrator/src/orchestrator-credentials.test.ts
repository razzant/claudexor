import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import type { CredentialUnusableObservation, HarnessRunSpec } from "@claudexor/schema";
import {
  OrchestratorCredentials,
  reviewerProfileResolver,
  type CredentialResolutionHost,
} from "./orchestrator-credentials.js";
import {
  preProgressRefusalSubject,
  type PreProgressRefusalMemory,
} from "./pre-progress-refusal.js";
import type { TransientFailureObservation } from "./transientClassify.js";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";
import type { CredentialExecutionSubject } from "@claudexor/core";
import { rotateSpecOnTypedLimit } from "./credential-profile-rotation.js";
import { newAttemptOutputMarkers } from "./attemptOutputMarkers.js";

// #363: the A7 differential verdict about a try's CURRENT subject is recorded
// only while the credential that try bound is still the account's current one.

const authRefusal: TransientFailureObservation = {
  kind: "unknown",
  category: "auth_failed",
  retryable: false,
  retryDelayMs: null,
  httpStatus: null,
  signal: null,
  adapterCode: "auth_required",
};

function fixture() {
  const recorded: CredentialUnusableObservation[] = [];
  let generation = 0;
  const memory: PreProgressRefusalMemory = {
    live: () => [],
    generation: () => generation,
    record: () => {},
    clear: () => {},
  };
  const host = {
    quotaSnapshots: () => [],
    quotaAbsences: () => [],
    credentialUnusable: () => [],
    recordCredentialUnusable: (obs: CredentialUnusableObservation) => void recorded.push(obs),
    preProgressRefusals: () => memory,
  } as unknown as CredentialResolutionHost;
  const spec = {
    model_hint: "m",
    credential_profile: {
      profile_id: "a",
      harness_id: "cursor",
      display_name: "a",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    },
  } as unknown as HarnessRunSpec;
  const credentials = new OrchestratorCredentials(host);
  const adapter = { id: "cursor" } as HarnessAdapter;
  return {
    recorded,
    change: (next: number) => (generation = next),
    verdict: async (bindAt: number) => {
      generation = bindAt;
      const refusal = preProgressRefusalSubject(memory, "cursor", spec);
      return (subjectAfter: number) => {
        generation = subjectAfter;
        return credentials
          .rotationObservations(adapter, spec, [authRefusal], refusal)
          .probeCurrentSubject();
      };
    },
  };
}

describe("OrchestratorCredentials differential verdict fence (#363)", () => {
  it("keeps the typed rotation verdict and event with a managed observer, without duplicate storage", async () => {
    const ledger = new CredentialUnusableLedger();
    const recorded: CredentialUnusableObservation[] = [];
    const host = {
      quotaSnapshots: () => [],
      quotaAbsences: () => [],
      credentialUnusable: () => ledger.live(),
      credentialEvidence: () => ledger,
      credentialObserverFactory: () => (subject: CredentialExecutionSubject) =>
        createCredentialExecutionObserver(ledger, ledger.bind(subject)),
      recordCredentialUnusable: (obs: CredentialUnusableObservation) => recorded.push(obs),
    } as unknown as CredentialResolutionHost;
    const spec = {
      model_hint: "model-a",
      auth_preference: "subscription",
      credential_profile: null,
      extra: {},
    } as unknown as HarnessRunSpec;
    const observations = new OrchestratorCredentials(host).rotationObservations(
      { id: "claude" } as HarnessAdapter,
      spec,
      [authRefusal],
      null,
    );
    expect(await observations.probeCurrentSubject()).toMatchObject({
      source: "attempt_stream",
      code: "auth_revoked",
    });
    expect(ledger.live()).toEqual([]);
    expect(recorded).toEqual([]);
    const events: { type: string; payload: unknown }[] = [];
    const result = await rotateSpecOnTypedLimit({
      spec,
      harnessId: "claude",
      attemptId: "a01",
      policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 1 },
      registry: [],
      quotaSnapshots: () => [],
      probeReadyProfiles: async () => new Set(),
      ...observations,
      triedProfiles: new Set(),
      markers: newAttemptOutputMarkers(),
      sawTypedLimit: false,
      sawRetryable: false,
      attemptErrored: true,
      deliverableEmpty: true,
      lastLimit: null,
      emit: (type, payload) => {
        events.push({ type, payload });
        return undefined as never;
      },
      newSessionId: () => "session-next",
      defaultRouteWasVendorNative: true,
    });
    expect(
      events.find((event) => event.type === "route.profile.credential_unusable")?.payload,
    ).toMatchObject({ source: "attempt_stream", code: "auth_revoked" });
    expect(result).toHaveProperty("poolExhausted");
    expect(ledger.live()).toEqual([]);
  });
  it("does not record an asynchronous local probe after native or API credential change", async () => {
    for (const api of [false, true]) {
      const ledger = new CredentialUnusableLedger();
      const spec = {
        model_hint: "m",
        auth_preference: api ? "api_key" : "subscription",
        credential_profile: {
          profile_id: "a",
          harness_id: "claude",
          credential_kind: api ? "api_key" : "config_dir_login",
        },
        extra: {},
      } as unknown as HarnessRunSpec;
      let complete!: (value: unknown) => void;
      const result = new Promise((resolve) => {
        complete = resolve;
      });
      const host = {
        quotaSnapshots: () => [],
        quotaAbsences: () => [],
        credentialUnusable: () => ledger.live(),
        credentialEvidence: () => ledger,
        credentialObserverFactory: () => (subject: CredentialExecutionSubject) =>
          createCredentialExecutionObserver(ledger, ledger.bind(subject)),
        recordCredentialUnusable: () => {
          throw new Error("unbound recording");
        },
      } as unknown as CredentialResolutionHost;
      const adapter = {
        id: "claude",
        probeCredentialProfile: () => result,
      } as unknown as HarnessAdapter;
      const probe = new OrchestratorCredentials(host)
        .rotationObservations(adapter, spec, [], null)
        .probeCurrentSubject();
      ledger.clearSubject("claude", "a");
      complete({
        harness_id: "claude",
        profile_id: "a",
        availability: "available",
        verification: "failed",
        verification_source: "local_store",
        last_verified_at: null,
      });
      expect(await probe).toMatchObject({ code: "verification_failed" });
      expect(ledger.live()).toEqual([]);
    }
  });
  it("fences the legacy default subject and preserves its actual quota route", async () => {
    const ledger = new CredentialUnusableLedger();
    const host = {
      quotaSnapshots: () => [],
      quotaAbsences: () => [
        {
          subject: {
            harness: "claude",
            subject_id: null,
            credential_route: "vendor_native",
            plan_label: null,
          },
          reason: "auth_revoked",
          detail: "vendor rejection",
          observed_at: new Date().toISOString(),
        },
      ],
      credentialUnusable: () => ledger.live(),
      credentialEvidence: () => ledger,
      credentialObserverFactory: () => (subject: CredentialExecutionSubject) =>
        createCredentialExecutionObserver(ledger, ledger.bind(subject)),
    } as unknown as CredentialResolutionHost;
    const credentials = new OrchestratorCredentials(host);
    const spec = {
      model_hint: "m",
      credential_profile: null,
      auth_preference: "subscription",
      extra: {},
    } as unknown as HarnessRunSpec;
    const adapter = { id: "claude" } as HarnessAdapter;
    const late = credentials.rotationObservations(adapter, spec, [], null).probeCurrentSubject();
    ledger.clearDefaultSubjects();
    expect(await late).toMatchObject({ profile_id: null, code: "auth_revoked" });
    expect(ledger.live()).toEqual([]);
    const api = { ...spec, auth_preference: "api_key" } as HarnessRunSpec;
    expect(
      await credentials.rotationObservations(adapter, api, [], null).probeCurrentSubject(),
    ).toBeNull();
  });
  it("records the verdict while the bound credential is current", async () => {
    const f = fixture();
    const probe = await f.verdict(3);
    expect(await probe(3)).toMatchObject({ code: "auth_revoked", profile_id: "a" });
    expect(f.recorded).toHaveLength(1);
  });

  it.each([
    ["a credential change since the try spawned", 4],
    ["an open login window (generation is no number)", Number.NaN],
  ])("does not record it after %s", async (_label, after) => {
    const f = fixture();
    const probe = await f.verdict(3);
    // The rotation decision still sees the verdict; only the memory refuses it.
    expect(await probe(after)).toMatchObject({ code: "auth_revoked" });
    expect(f.recorded).toEqual([]);
  });
});

describe("reviewer seat account preflight (#532)", () => {
  const row = (profileId: string) => ({
    profile_id: profileId,
    harness_id: "stub",
    display_name: profileId,
    credential_kind: "config_dir_login" as const,
    isolation_locator: `/tmp/stub-${profileId}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
  });
  function seats(ready: boolean) {
    const probes: Array<{ profileId: string; signal: AbortSignal | undefined; options: unknown }> =
      [];
    const adapter = {
      id: "stub",
      async probeCredentialProfile(
        profile: { profile_id: string },
        signal?: AbortSignal,
        options?: unknown,
      ) {
        probes.push({ profileId: profile.profile_id, signal, options });
        return {
          profile_id: profile.profile_id,
          harness_id: "stub",
          availability: ready ? "available" : "unknown",
          verification: ready ? "passed" : "not_run",
          verification_source: "local_store",
          detail: ready ? "login verified" : "Cursor did not confirm sign-in within 120s",
          last_verified_at: null,
        };
      },
    } as unknown as HarnessAdapter;
    const host = {
      config: () => ({ global: { credential_profiles: [row("a"), row("b")], harnesses: {} } }),
      registry: () => new Map([["stub", adapter]]),
      quotaSnapshots: () => [],
      quotaAbsences: () => [],
      credentialUnusable: () => [],
      recordCredentialUnusable: () => {},
      preProgressRefusals: () => undefined,
      authPreferenceForHarness: () => "auto",
    } as unknown as CredentialResolutionHost;
    return { probes, credentials: new OrchestratorCredentials(host) };
  }
  const seat = (credentialProfileId: string | null) => ({
    harnessId: "stub",
    model: null,
    authPreference: "auto" as const,
    credentialProfileId,
  });

  it("an explicit seat's pin is checked with the pin fact under the run's cancellation", async () => {
    const { probes, credentials } = seats(true);
    const run = new AbortController();
    const profile = await reviewerProfileResolver(credentials, "/repo", run.signal)(seat("a"));
    expect(profile?.profile_id).toBe("a");
    expect(probes[0]).toEqual({ profileId: "a", signal: run.signal, options: { pinned: true } });
  });

  it("an explicit seat whose sign-in is not confirmed refuses with that reason", async () => {
    const { credentials } = seats(false);
    await expect(
      reviewerProfileResolver(credentials, "/repo", new AbortController().signal)(seat("a")),
    ).rejects.toThrow(
      'reviewer credential profile "a" (stub) is not ready: Cursor did not confirm sign-in within 120s',
    );
  });

  it("an automatic seat keeps the ordinary probe, without the pin fact", async () => {
    const { probes, credentials } = seats(true);
    const run = new AbortController();
    const profile = await reviewerProfileResolver(credentials, "/repo", run.signal)(seat(null));
    expect(["a", "b"]).toContain(profile?.profile_id);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe.options === undefined)).toBe(true);
  });
});
