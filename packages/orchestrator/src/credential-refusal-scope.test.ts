import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialExecutionSubject } from "@claudexor/core";
import type {
  CredentialProfile,
  CredentialProfileStatus,
  CredentialRoute,
  HarnessEvent,
  HarnessRunSpec,
  QuotaAbsence,
} from "@claudexor/schema";
import { CredentialUnusableLedger } from "../../daemon/src/credential-unusable-ledger.js";
import { PreProgressRefusalLedger } from "../../daemon/src/pre-progress-refusal-ledger.js";
import { createClaudeParser } from "../../harness-claude/src/parse.js";
import {
  applicableCredentialUnusable,
  composeCredentialProfileEvidence,
} from "./account-evidence.js";
import { createAttemptTelemetry, observeAttemptTelemetry } from "./attemptTelemetry.js";
import {
  currentSubjectProber,
  differentialSubjectVerdict,
  readyProfilesForRotation,
} from "./credential-differential.js";
import { createCredentialExecutionObserver } from "./credential-execution.js";
import { selectedProfileAvailability } from "./credential-profiles.js";
import { dominantHarnessFailureCategory } from "./harnessFailure.js";
import { run } from "./inrun-continuity.test-support.js";

// #609: a refusal keeps its actual subject and scope. Every stream below is raw
// vendor frames through the Claude adapter's real parser, the production subject
// binding, the real dispatch observer and the real ledger; the readers are the
// listing's status composition, pin admission and pool rotation. Only the
// registry, the local probe answer and the clock are fixtures.

const row = (id: string, overrides: Partial<CredentialProfile> = {}): CredentialProfile => ({
  profile_id: id,
  harness_id: "claude",
  display_name: id,
  credential_kind: "config_dir_login",
  isolation_locator: `/fixture/${id}`,
  secret_ref: null,
  enabled: true,
  created_at: null,
  ...overrides,
});
const work = row("work");
const spare = row("spare");
const registry = [work, spare];
const passing = async (profile: CredentialProfile): Promise<CredentialProfileStatus> => ({
  profile_id: profile.profile_id,
  harness_id: profile.harness_id,
  availability: "available",
  verification: "passed",
  verification_source: "local_store",
  detail: "fixture local store verified",
  last_verified_at: null,
});
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

type Frames = (sessionId: string) => HarnessEvent[];
const parsed =
  (...frames: Array<Record<string, unknown>>): Frames =>
  (sessionId) => {
    const parser = createClaudeParser();
    return frames.flatMap((frame) => parser(frame, sessionId) ?? []);
  };
const apiRetry = (error: string) =>
  parsed({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, error });
const modelNotFound = apiRetry("model_not_found");
const authFailed = apiRetry("authentication_failed");
/** The vendor's exact typed code. */
const orgRetryFrame = apiRetry("oauth_org_not_allowed");
/** The recorded organization-disabled incident, frame by frame. */
const orgDisabledResult = parsed(
  ...readFileSync(
    new URL(
      "../../harness-claude/fixtures/signals/org-disabled-subscription.jsonl",
      import.meta.url,
    ),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>),
);
/** Prose the parser's fallback files under the org category, though each names one model. */
const PROSE_ONLY = [
  "Your organization is not allowed to use claude-opus-5-5",
  "OAuth token for this organization cannot access claude-opus-5-5",
];

function fixture() {
  const t0 = Date.now();
  let clock = t0;
  const ledger = new CredentialUnusableLedger(
    () => new Date(clock),
    () => false,
  );
  const stamp = () => new Date((clock += 1000)).toISOString();
  type Try = {
    profile?: CredentialProfile | null;
    authPreference?: "auto" | "subscription" | "api_key";
    model: string | null;
    route?: CredentialRoute;
  };
  /** Bound at dispatch through the production subject; returns the stream's end. */
  const dispatch = (at: Try) => {
    const profile = at.profile === undefined ? work : at.profile;
    const route = at.route ?? "vendor_native";
    const subject = credentialExecutionSubject("claude", {
      credential_profile: profile,
      auth_preference: at.authPreference ?? "auto",
      model_hint: at.model,
    } as unknown as HarnessRunSpec);
    const observer = createCredentialExecutionObserver(ledger, ledger.bind(subject));
    const base = {
      session_id: "session-1",
      credential_route: route,
      ...(profile ? { credential_profile_id: profile.profile_id } : {}),
    };
    const send = (over: Partial<HarnessEvent>) =>
      observer.observe({ type: "status", ...base, ...over, ts: stamp() } as HarnessEvent);
    return {
      refuse(frames: Frames) {
        send({ type: "started" });
        for (const frame of frames("session-1")) send(frame);
      },
      fail() {
        send({ type: "error", error: "request failed" });
        send({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
        observer.finish();
      },
      serve(observedModel: string) {
        send({
          type: "usage",
          usage: { input_tokens: 12, output_tokens: 3 },
          observed_model: observedModel,
        });
        send({ type: "completed", payload: { exit_code: 0 } });
        observer.finish();
      },
    };
  };
  const refused = (at: Try, frames: Frames) => {
    const attempt = dispatch(at);
    attempt.refuse(frames);
    attempt.fail();
  };
  const served = (at: Try, observedModel: string) => dispatch(at).serve(observedModel);
  const quota = () => ({ snapshots: [], absences: [], honored: ledger.honored() });
  /** The exact composition `accounts-services.ts` `withAccountEvidence` lists. */
  const listed = async (profile: CredentialProfile) =>
    composeCredentialProfileEvidence(await passing(profile), {
      quota: quota(),
      unusable: ledger.live(),
      model: null,
      route: profile.credential_kind === "api_key" ? "managed_api_key" : "vendor_native",
    });
  const pin = (profile: CredentialProfile, model: string | null) =>
    selectedProfileAvailability({
      registry,
      profileId: profile.profile_id,
      harnessId: "claude",
      probe: passing,
      quota: quota(),
      unusable: ledger.live(),
      model,
    });
  const pool = async (model: string | null) =>
    [
      ...(await readyProfilesForRotation({
        registry,
        harnessId: "claude",
        policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 1 },
        current: null,
        probe: passing,
        quota: quota(),
        unusable: ledger.live(),
        model,
      })),
    ].sort();
  return {
    ledger,
    dispatch,
    refused,
    served,
    listed,
    pin,
    pool,
    advance(ms: number) {
      clock += ms;
    },
  };
}

/** What the real attempt telemetry derives from a try's frames: the differential's input. */
const transientsOf = (...frames: Frames[]) => {
  const telemetry = createAttemptTelemetry("auto", false);
  for (const make of frames)
    for (const frame of make("session-1")) observeAttemptTelemetry(telemetry, frame);
  return telemetry.transientFailures;
};

describe("a model refusal of a run that named no model (#609)", () => {
  it("leaves no hard mark: the row, a different explicit model and the pool are untouched", async () => {
    const f = fixture();
    f.refused({ model: null }, modelNotFound);
    expect(f.ledger.live()).toEqual([]);
    expect((await f.listed(work)).verification).toBe("passed");
    expect(await f.pin(work, SONNET)).toBe("available");
    expect(await f.pin(work, null)).toBe("available");
    expect(await f.pool(SONNET)).toEqual(["spare", "work"]);
    expect(await f.pool(null)).toEqual(["spare", "work"]);
  });

  it("keeps the run's own diagnostic: the typed refusal still classifies and dominates the failure", () => {
    const telemetry = createAttemptTelemetry("auto", false);
    for (const frame of modelNotFound("session-1")) observeAttemptTelemetry(telemetry, frame);
    expect(telemetry.transientFailures).toMatchObject([
      { category: "capability_refused", adapterCode: "model_not_found", retryable: false },
    ]);
    expect(dominantHarnessFailureCategory(telemetry.transientFailures)).toBe("capability_refused");
  });

  it("is no verdict for the differential or its sink, and weaker independent evidence still answers", async () => {
    const recorded: unknown[] = [];
    const prober = currentSubjectProber({
      harnessId: "claude",
      profile: work,
      model: null,
      quota: { snapshots: [], absences: [] },
      transients: transientsOf(modelNotFound),
      probe: passing,
      record: (observation) => recorded.push(observation),
    });
    await expect(prober()).resolves.toBeNull();
    expect(recorded).toEqual([]);
    // The stream proved nothing about the credential, so it no longer hides a
    // failed local probe or the poller's authenticated rejection.
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(modelNotFound),
        probe: async (profile) => ({
          ...(await passing(profile)),
          verification: "failed",
          detail: "login expired",
        }),
      }),
    ).resolves.toMatchObject({ code: "verification_failed", source: "local_probe", model: null });
    const rejection: QuotaAbsence = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "work",
      },
      reason: "auth_revoked",
      detail: "vendor rejected the token",
      observed_at: new Date().toISOString(),
    };
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: { snapshots: [], absences: [rejection] },
        transients: transientsOf(modelNotFound),
      }),
    ).resolves.toMatchObject({ code: "auth_revoked", source: "vendor_poller" });
  });

  it("does not hide an authentication rejection seen later in the same try", async () => {
    const f = fixture();
    const attempt = f.dispatch({ model: null });
    attempt.refuse(authFailed);
    attempt.refuse(modelNotFound);
    attempt.fail();
    expect(f.ledger.live()).toMatchObject([{ code: "auth_revoked", model: null }]);
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(modelNotFound, authFailed),
      }),
    ).resolves.toMatchObject({ code: "auth_revoked", model: null });
  });
});

describe("a refusal of a known model (#609 control)", () => {
  it("stays exact: that model is refused on that row and nothing else changes", async () => {
    const f = fixture();
    f.refused({ model: OPUS }, modelNotFound);
    expect(f.ledger.live()).toMatchObject([
      {
        profile_id: "work",
        credential_route: "vendor_native",
        model: OPUS,
        code: "capability_refused",
        detail: "model_not_found",
      },
    ]);
    expect((await f.listed(work)).verification).toBe("passed");
    expect(await f.pin(work, OPUS)).toContain("credential is unusable (capability_refused)");
    expect(await f.pin(work, SONNET)).toBe("available");
    expect(await f.pin(work, null)).toBe("available");
    expect(await f.pool(OPUS)).toEqual(["spare"]);
    expect(await f.pool(SONNET)).toEqual(["spare", "work"]);
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: OPUS,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(modelNotFound),
      }),
    ).resolves.toMatchObject({ code: "capability_refused", model: OPUS });
  });

  it("clears on exactly that model's service, on a credential change and on expiry", async () => {
    const f = fixture();
    const listed = () => f.ledger.live().map((mark) => mark.model);
    f.refused({ model: OPUS }, modelNotFound);
    f.served({ model: SONNET }, SONNET);
    f.served({ model: OPUS }, "claude-opus-5-5-20261001");
    expect(listed()).toEqual([OPUS]);
    f.served({ model: OPUS }, OPUS);
    expect(listed()).toEqual([]);
    f.refused({ model: OPUS }, modelNotFound);
    expect(listed()).toEqual([OPUS]);
    f.ledger.clearSubject("claude", "work");
    expect(listed()).toEqual([]);
    f.refused({ model: OPUS }, modelNotFound);
    f.advance(59 * 60_000);
    expect(listed()).toEqual([OPUS]);
    f.advance(61_000);
    expect(listed()).toEqual([]);
  });
});

describe("a subscription-wide refusal (#609)", () => {
  it.each([
    ["the entitlement result on a run naming a model", OPUS, orgDisabledResult],
    ["the typed retry frame on a run naming a model", OPUS, orgRetryFrame],
    ["the entitlement result on a run naming none", null, orgDisabledResult],
  ] as const)(
    "%s covers every model of that exact subject for an hour",
    async (_name, model, frames) => {
      const f = fixture();
      f.refused({ model }, frames);
      const [mark, ...others] = f.ledger.live();
      expect(others).toEqual([]);
      expect(mark).toMatchObject({
        harness_id: "claude",
        profile_id: "work",
        credential_route: "vendor_native",
        model: null,
        code: "capability_refused",
        source: "attempt_stream",
        detail: "oauth_org_not_allowed",
      });
      expect(Date.parse(mark!.expires_at) - Date.parse(mark!.observed_at)).toBe(60 * 60_000);
      expect(await f.listed(work)).toMatchObject({
        verification: "failed",
        detail: "oauth_org_not_allowed",
      });
      for (const other of [OPUS, SONNET, null]) {
        expect(await f.pin(work, other)).toContain("credential is unusable (capability_refused)");
        expect(await f.pool(other)).toEqual(["spare"]);
      }
    },
  );

  it("is the differential's verdict too, on the subject's own route", async () => {
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: OPUS,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(orgRetryFrame),
      }),
    ).resolves.toMatchObject({
      code: "capability_refused",
      model: null,
      profile_id: "work",
      credential_route: "vendor_native",
      detail: "oauth_org_not_allowed",
    });
  });

  it("never reaches another profile, harness or API-key route", async () => {
    const f = fixture();
    f.refused({ model: OPUS }, orgDisabledResult);
    const live = f.ledger.live();
    expect((await f.listed(spare)).verification).toBe("passed");
    expect(await f.pin(spare, OPUS)).toBe("available");
    const applies = (harness_id: string, profile_id: string, route: CredentialRoute) =>
      applicableCredentialUnusable(
        { harness_id, profile_id },
        { unusable: live, model: SONNET, route },
      );
    expect(applies("claude", "work", "vendor_native")).not.toBeNull();
    expect(applies("claude", "work", "managed_api_key")).toBeNull();
    expect(applies("claude", "spare", "vendor_native")).toBeNull();
    expect(applies("codex", "work", "vendor_native")).toBeNull();
  });

  it("on the default subscription subject stays on that route and off the registered rows", async () => {
    const f = fixture();
    const subscription = { profile: null, authPreference: "subscription" as const };
    f.refused({ ...subscription, model: OPUS }, orgDisabledResult);
    expect(f.ledger.live()).toMatchObject([
      { profile_id: null, credential_route: "vendor_native", model: null },
    ]);
    expect((await f.listed(work)).verification).toBe("passed");
    expect(await f.pin(work, OPUS)).toBe("available");
    // Service on the default API-key route proves nothing about the subscription.
    f.served(
      { profile: null, authPreference: "api_key", route: "managed_api_key", model: OPUS },
      OPUS,
    );
    expect(f.ledger.live()).toHaveLength(1);
    f.served({ ...subscription, model: OPUS }, OPUS);
    expect(f.ledger.live()).toEqual([]);
  });

  it("is not widened when the observed route is an API key or unknown", async () => {
    // A known model keeps its exact scope; without one nothing is proven.
    const onKey = fixture();
    const keyed = row("keyed", { credential_kind: "api_key", isolation_locator: null });
    onKey.refused({ profile: keyed, route: "managed_api_key", model: OPUS }, orgRetryFrame);
    expect(onKey.ledger.live()).toMatchObject([
      { profile_id: "keyed", credential_route: "managed_api_key", model: OPUS },
    ]);
    const onKeyUnknownModel = fixture();
    onKeyUnknownModel.refused(
      { profile: keyed, route: "managed_api_key", model: null },
      orgRetryFrame,
    );
    expect(onKeyUnknownModel.ledger.live()).toEqual([]);
    const verdict = (model: string | null) =>
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: null,
        model,
        route: null,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(orgRetryFrame),
      });
    await expect(verdict(OPUS)).resolves.toMatchObject({ model: OPUS, profile_id: null });
    await expect(verdict(null)).resolves.toBeNull();
  });

  it("is not narrowed by a known-model refusal in the same try, in either order", async () => {
    const f = fixture();
    const attempt = f.dispatch({ model: OPUS });
    attempt.refuse(orgDisabledResult);
    attempt.refuse(modelNotFound);
    attempt.fail();
    expect(f.ledger.live()).toMatchObject([{ model: null, detail: "oauth_org_not_allowed" }]);
    const g = fixture();
    const reversed = g.dispatch({ model: OPUS });
    reversed.refuse(modelNotFound);
    reversed.refuse(orgDisabledResult);
    reversed.fail();
    expect(g.ledger.live()).toMatchObject([{ model: null, detail: "oauth_org_not_allowed" }]);
    for (const transients of [
      transientsOf(modelNotFound, orgDisabledResult),
      transientsOf(orgDisabledResult, modelNotFound),
    ])
      await expect(
        differentialSubjectVerdict({
          harnessId: "claude",
          profile: work,
          model: OPUS,
          quota: { snapshots: [], absences: [] },
          transients,
        }),
      ).resolves.toMatchObject({ model: null, detail: "oauth_org_not_allowed" });
  });

  it("clears on the subject's later service of any model, never another subject's", async () => {
    const f = fixture();
    f.refused({ model: OPUS }, orgDisabledResult);
    f.served({ profile: spare, model: OPUS }, OPUS);
    expect(f.ledger.live()).toHaveLength(1);
    f.served({ model: SONNET }, SONNET);
    expect(f.ledger.live()).toEqual([]);
    expect((await f.listed(work)).verification).toBe("passed");
    expect(await f.pin(work, OPUS)).toBe("available");
  });

  it("an older dispatch's later success does not heal it", () => {
    const f = fixture();
    const older = f.dispatch({ model: SONNET });
    f.refused({ model: OPUS }, orgDisabledResult);
    older.serve(SONNET);
    expect(f.ledger.live()).toHaveLength(1);
  });

  it("expires with its bounded TTL", () => {
    const f = fixture();
    f.refused({ model: OPUS }, orgDisabledResult);
    f.advance(59 * 60_000);
    expect(f.ledger.live()).toHaveLength(1);
    f.advance(61_000);
    expect(f.ledger.live()).toEqual([]);
  });

  it("a credential change voids it, and a try bound before the change cannot recreate it", async () => {
    const f = fixture();
    f.refused({ model: OPUS }, orgDisabledResult);
    const inFlight = f.dispatch({ model: OPUS });
    inFlight.refuse(orgDisabledResult);
    f.ledger.clearSubject("claude", "work");
    expect(f.ledger.live()).toEqual([]);
    inFlight.fail();
    expect(f.ledger.live()).toEqual([]);
    expect((await f.listed(work)).verification).toBe("passed");
    f.refused({ profile: spare, model: OPUS }, orgDisabledResult);
    f.refused({ model: OPUS }, orgDisabledResult);
    f.ledger.noteCredentialChange();
    expect(f.ledger.live()).toEqual([]);
  });
});

describe("a refusal only the parser's prose fallback calls org-wide (#609)", () => {
  it.each(PROSE_ONLY)("%s: keeps its diagnostic and retry class", (prose) => {
    const [frame] = apiRetry(prose)("session-1");
    expect(frame).toMatchObject({
      type: "status",
      status: { error_category: "oauth_org_not_allowed" },
    });
    expect(frame?.text).toContain(prose);
    expect(transientsOf(apiRetry(prose))).toMatchObject([
      { category: "capability_refused", adapterCode: "oauth_org_not_allowed", retryable: false },
    ]);
    expect(dominantHarnessFailureCategory(transientsOf(apiRetry(prose)))).toBe(
      "capability_refused",
    );
  });

  it.each(PROSE_ONLY)(
    "%s: on a named model restricts only that model, never the row or another model",
    async (prose) => {
      const f = fixture();
      f.refused({ model: OPUS }, apiRetry(prose));
      expect(f.ledger.live()).toMatchObject([
        { profile_id: "work", credential_route: "vendor_native", model: OPUS },
      ]);
      expect((await f.listed(work)).verification).toBe("passed");
      expect(await f.pin(work, OPUS)).toContain("credential is unusable (capability_refused)");
      expect(await f.pin(work, SONNET)).toBe("available");
      expect(await f.pool(SONNET)).toEqual(["spare", "work"]);
      await expect(
        differentialSubjectVerdict({
          harnessId: "claude",
          profile: work,
          model: OPUS,
          quota: { snapshots: [], absences: [] },
          transients: transientsOf(apiRetry(prose)),
        }),
      ).resolves.toMatchObject({ code: "capability_refused", model: OPUS });
    },
  );

  it.each(PROSE_ONLY)("%s: on a run naming no model records nothing", async (prose) => {
    const f = fixture();
    f.refused({ model: null }, apiRetry(prose));
    expect(f.ledger.live()).toEqual([]);
    expect((await f.listed(work)).verification).toBe("passed");
    expect(await f.pin(work, SONNET)).toBe("available");
    await expect(
      differentialSubjectVerdict({
        harnessId: "claude",
        profile: work,
        model: null,
        quota: { snapshots: [], absences: [] },
        transients: transientsOf(apiRetry(prose)),
      }),
    ).resolves.toBeNull();
  });

  it("does not hide a proven refusal seen later in the same try", () => {
    const f = fixture();
    const attempt = f.dispatch({ model: OPUS });
    attempt.refuse(apiRetry(PROSE_ONLY[0]!));
    attempt.refuse(orgDisabledResult);
    attempt.fail();
    expect(f.ledger.live()).toMatchObject([{ model: null, detail: "oauth_org_not_allowed" }]);
  });
});

describe("the real Orchestrator's account path (#609)", () => {
  function evidence() {
    const unusable = new CredentialUnusableLedger(undefined, () => false);
    const refusals = new PreProgressRefusalLedger(undefined, () => false);
    return {
      unusable,
      refusals,
      deps: {
        credentialObserverFactory: (subject: Parameters<typeof unusable.bind>[0]) =>
          createCredentialExecutionObserver(unusable, unusable.bind(subject)),
        credentialUnusable: () => unusable.live(),
        credentialEvidence: unusable,
        preProgressRefusals: {
          live: () => refusals.live(),
          generation: (harnessId: string, profileId: string) =>
            refusals.generation(harnessId, profileId),
          record: (value: Parameters<typeof refusals.record>[0]) => refusals.record(value),
          clear: (harnessId: string, profileId: string, model: string | null) =>
            refusals.clear(harnessId, profileId, model),
          services: null,
        },
      },
    };
  }
  const inventory = async () =>
    ["m1", "m2"].map((id) => ({ id, label: null, context_window: null, routes: null }));
  type Script = Parameters<typeof run>[0]["script"];
  /** `a`'s started session is refused before progress; every other try serves. */
  const refusingA = (frames: Frames): Script =>
    function* ({ profile, emit, spec }) {
      yield emit({ type: "started" });
      if (profile === "a") {
        for (const frame of frames(spec.session_id)) yield emit(frame);
        yield emit({ type: "error", error: "VENDOR-REFUSAL-TEXT-609" });
        yield emit({ type: "completed", payload: { exit_code: 1, harness_reported_error: true } });
        return;
      }
      writeFileSync(join(spec.cwd, "edited.txt"), "served\n");
      yield emit({ type: "file_change", payload: { path: "edited.txt" } });
      yield emit({ type: "message", text: "served", final: true });
      yield emit({ type: "completed" });
    };

  it("unpinned, no model: rotates as before, leaves only the soft mark, emits no hard verdict", async () => {
    const e = evidence();
    const o = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      model: null,
      deps: e.deps,
      script: refusingA(modelNotFound),
    });
    expect(o.spawns.map((spawn) => spawn.profile)).toEqual(["a", "b"]);
    expect(o.rotated).toMatchObject([{ reason: "structural_pre_progress_failure" }]);
    expect(o.events.map((event) => event.type)).not.toContain("route.profile.credential_unusable");
    expect(e.unusable.live()).toEqual([]);
    expect(e.refusals.live()).toMatchObject([{ profile_id: "a", requested_model: null }]);
  }, 60_000);

  it("pinned, no model: fails with the original diagnostic and a later explicit model still runs", async () => {
    const e = evidence();
    const first = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: null,
      deps: e.deps,
      models: inventory,
      script: refusingA(modelNotFound),
    });
    expect(first.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    expect(first.result.lifecycle).toBe("failed");
    expect(JSON.stringify(first.events.find((event) => event.type === "run.failed"))).toContain(
      "VENDOR-REFUSAL-TEXT-609",
    );
    expect(e.unusable.live()).toEqual([]);
    // A pin never records the soft mark: no hard or soft memory of this refusal.
    expect(e.refusals.live()).toEqual([]);
    const second = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: "m2",
      deps: e.deps,
      models: inventory,
      script: refusingA(() => []),
    });
    expect(second.spawns.map((spawn) => spawn.profile)).toEqual(["a"]);
    expect(second.spawns[0]?.model).toBe("m2");
  }, 120_000);

  it("a known model's refusal stays exact: the other model of that row still runs", async () => {
    const e = evidence();
    const first = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: "m1",
      deps: e.deps,
      models: inventory,
      script: refusingA(modelNotFound),
    });
    expect(first.result.lifecycle).toBe("failed");
    expect(e.unusable.live()).toMatchObject([
      { profile_id: "a", model: "m1", credential_route: "vendor_native" },
    ]);
    const other = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: "m2",
      deps: e.deps,
      models: inventory,
      script: refusingA(() => []),
    });
    expect(other.spawns.map((spawn) => spawn.model)).toEqual(["m2"]);
  }, 120_000);

  it("a prose-only org refusal on a named model rotates as before and leaves the other model usable", async () => {
    const e = evidence();
    const first = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      model: "m1",
      deps: e.deps,
      models: inventory,
      script: refusingA(apiRetry(PROSE_ONLY[0]!)),
    });
    expect(first.spawns.map((spawn) => spawn.profile)).toEqual(["a", "b"]);
    expect(first.rotated).toMatchObject([{ reason: "structural_pre_progress_failure" }]);
    expect(e.unusable.live()).toMatchObject([
      { profile_id: "a", model: "m1", credential_route: "vendor_native" },
    ]);
    expect(
      first.events.find((event) => event.type === "route.profile.credential_unusable")?.payload,
    ).toMatchObject({ profile_id: "a", model: "m1" });
    const other = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: "m2",
      deps: e.deps,
      models: inventory,
      script: refusingA(() => []),
    });
    expect(other.spawns.map((spawn) => spawn.model)).toEqual(["m2"]);
  }, 120_000);

  it("a subscription-wide refusal on a named model refuses that row for another model, not its sibling", async () => {
    const e = evidence();
    const first = await run({
      mode: "agent",
      profiles: ["a", "b"],
      maxRetries: 0,
      model: "m1",
      deps: e.deps,
      models: inventory,
      script: refusingA(orgDisabledResult),
    });
    expect(first.spawns.map((spawn) => spawn.profile)).toEqual(["a", "b"]);
    expect(e.unusable.live()).toMatchObject([
      { profile_id: "a", model: null, credential_route: "vendor_native" },
    ]);
    expect(
      first.events.find((event) => event.type === "route.profile.credential_unusable")?.payload,
    ).toMatchObject({ profile_id: "a", model: null, detail: "oauth_org_not_allowed" });
    const pinnedThere = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "a",
      maxRetries: 0,
      model: "m2",
      deps: e.deps,
      models: inventory,
      script: refusingA(() => []),
    });
    expect(pinnedThere.spawns).toEqual([]);
    expect(pinnedThere.result.lifecycle).toBe("failed");
    const sibling = await run({
      mode: "agent",
      profiles: ["a", "b"],
      pinned: "b",
      maxRetries: 0,
      model: "m2",
      deps: e.deps,
      models: inventory,
      script: refusingA(() => []),
    });
    expect(sibling.spawns.map((spawn) => spawn.profile)).toEqual(["b"]);
  }, 120_000);
});
