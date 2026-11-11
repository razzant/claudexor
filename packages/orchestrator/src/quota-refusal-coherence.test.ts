/**
 * #318 coherent refusal attribution: a provider block and the owner's reserve
 * can sit on different windows of one account. The refusal's basis, window,
 * usage and recheck time always describe the same controlling evidence (a
 * provider block outranks the reserve); nothing is assembled from unrelated
 * windows or from another candidate. Admission itself is unchanged.
 */
import { describe, expect, it } from "vitest";
import type { CredentialProfile, QuotaConstraint, QuotaSnapshot } from "@claudexor/schema";
import { resolveAccountForRun } from "./account-resolution.js";
import { rankAccountPool } from "./account-pool.js";
import { type CandidateRun, unanimousDeclaredFailure } from "./candidateEvidence.js";
import { profileQuotaBlock } from "./credential-cooldown.js";
import { preflightDefaultSubject } from "./credential-preflight.js";
import type { DeclaredFailure } from "./runTerminalResults.js";

const in1h = new Date(Date.now() + 3600_000).toISOString();
const in2h = new Date(Date.now() + 7200_000).toISOString();
const in3d = new Date(Date.now() + 3 * 86_400_000).toISOString();

const row = (profileId: string): CredentialProfile => ({
  profile_id: profileId,
  harness_id: "claude",
  display_name: profileId,
  credential_kind: "config_dir_login",
  isolation_locator: `/tmp/claudexor-coherence/${profileId}`,
  secret_ref: null,
  enabled: true,
  created_at: null,
});

const window = (over: Partial<QuotaConstraint> & { id: string }): QuotaConstraint => ({
  label: over.id,
  used_ratio: null,
  window_seconds: null,
  resets_at: null,
  cooldown_until: null,
  ...over,
});

const snapshot = (subjectId: string | null, constraints: QuotaConstraint[]): QuotaSnapshot => ({
  subject: {
    harness: "claude",
    credential_route: "vendor_native",
    plan_label: null,
    subject_id: subjectId,
  },
  source: "claude_oauth_usage",
  observed_at: new Date().toISOString(),
  freshness: "fresh",
  constraints,
});

// The reviewer's shape: the reserve window resets in one hour, the provider
// cooldown on another window lasts two hours.
const mixed = (subjectId: string | null) =>
  snapshot(subjectId, [
    window({ id: "seven_day", used_ratio: 0.95, resets_at: in1h, window_seconds: 604_800 }),
    window({ id: "cooldown", cooldown_until: in2h }),
  ]);

async function pinnedRefusal(snapshots: QuotaSnapshot[]) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const error = await resolveAccountForRun({
    harnessId: "claude",
    registry: [row("a")],
    policy: { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 },
    snapshots,
    quota: { snapshots: [], absences: [] },
    unusable: [],
    probe: undefined,
    pinnedProfile: row("a"),
    boundProfileId: null,
    threadId: null,
    model: null,
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "subscription",
    notePoolApiKeyRoute: () => undefined,
    emit: (type, payload) => events.push({ type, payload }),
  }).catch((e: unknown) => e as Record<string, unknown>);
  const event = events.find((e) => e.type === "route.profile.headroom_exceeded")?.payload;
  return { error, event };
}

describe("one snapshot blocking on several windows", () => {
  const spentLater = window({ id: "five_hour", used_ratio: 1, resets_at: in2h });
  const coolingSooner = window({ id: "cooldown", cooldown_until: in1h });

  it.each([
    ["spent window listed first", [spentLater, coolingSooner]],
    ["cooldown listed first", [coolingSooner, spentLater]],
  ])("names the window that owns the earliest recheck, with its own kind (%s)", (_, windows) => {
    expect(profileQuotaBlock([snapshot("a", windows)], "claude", "a", "local_session")).toEqual({
      blocked: true,
      constraint_id: "cooldown",
      resets_at: in1h,
      kind: "cooldown",
    });
  });

  it("keeps a single spent window as provider exhaustion", () => {
    expect(
      profileQuotaBlock([snapshot("a", [spentLater])], "claude", "a", "local_session"),
    ).toEqual({ blocked: true, constraint_id: "five_hour", resets_at: in2h, kind: "exhausted" });
  });
});

describe("provider block and owner reserve on different windows", () => {
  it("the pinned refusal, its event and its problem describe the provider block only", async () => {
    const { error, event } = await pinnedRefusal([mixed("a")]);
    expect(error).toMatchObject({
      code: "subscription_window_exhausted",
      resetsAt: in2h,
      quotaRefusal: {
        basis: "provider_cooldown",
        constraintId: "cooldown",
        // The reserve window's 95% belongs to another window: not attached.
        usedRatio: null,
        threshold: 0.9,
      },
      problem: { context: { constraint_id: "cooldown", refusal_basis: "provider_cooldown" } },
    });
    expect(event).toMatchObject({
      constraint_id: "cooldown",
      used_ratio: null,
      resets_at: in2h,
      basis: "provider_cooldown",
    });
  });

  it("the pool verdict pairs the provider basis with the provider block's recheck time", () => {
    const [candidate] = rankAccountPool({
      registry: [row("a")],
      harnessId: "claude",
      snapshots: [mixed("a")],
      readyProfileIds: new Set(["a"]),
      headroomThreshold: 0.9,
    });
    expect(candidate?.verdict).toEqual({
      kind: "exhausted",
      resets_at: in2h,
      basis: "provider_cooldown",
    });
  });

  it("the default-subject preflight event has one controlling window", () => {
    const events: Array<Record<string, unknown>> = [];
    // The default subject's own block with no alternative refuses typed; its
    // recheck time is the same provider block the event names.
    expect(() =>
      preflightDefaultSubject({
        harnessId: "claude",
        policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 0.9 },
        registry: [],
        snapshots: [mixed(null)],
        readyProfileIds: new Set(),
        defaultRoute: "local_session",
        emit: (_, payload) => events.push(payload as Record<string, unknown>),
      }),
    ).toThrowError(expect.objectContaining({ code: "credential_pool_exhausted", resetsAt: in2h }));
    expect(events[0]).toMatchObject({
      constraint_id: "cooldown",
      used_ratio: null,
      resets_at: in2h,
      basis: "provider_cooldown",
    });
  });

  it("the same window blocking and breaching keeps its own usage", async () => {
    const same = snapshot("a", [window({ id: "five_hour", used_ratio: 1, resets_at: in1h })]);
    const { error, event } = await pinnedRefusal([same]);
    expect(error).toMatchObject({
      resetsAt: in1h,
      quotaRefusal: { basis: "provider_window", constraintId: "five_hour", usedRatio: 1 },
    });
    expect(event).toMatchObject({ constraint_id: "five_hour", used_ratio: 1, resets_at: in1h });
  });
});

describe("a provider-spent window with an unknown reset after a softer reserve", () => {
  const spentUnknownReset = snapshot("a", [
    window({ id: "seven_day", used_ratio: 0.92, resets_at: in3d }),
    window({ id: "weekly_scoped:Opus", used_ratio: 1, resets_at: null }),
  ]);

  it("is labelled provider exhaustion, never the owner's reserve", async () => {
    const { error, event } = await pinnedRefusal([spentUnknownReset]);
    expect(error).toMatchObject({
      code: "subscription_window_exhausted",
      resetsAt: null,
      quotaRefusal: { basis: "provider_window", constraintId: "weekly_scoped:Opus", usedRatio: 1 },
    });
    expect(String((error as unknown as Error).message)).not.toContain("reserve");
    expect(event).toMatchObject({ basis: "provider_window", resets_at: null, used_ratio: 1 });
  });

  it("a reserve-only account is still the owner's reserve", async () => {
    const reserveOnly = snapshot("a", [
      window({ id: "seven_day", used_ratio: 0.92, resets_at: in3d }),
    ]);
    const { error } = await pinnedRefusal([reserveOnly]);
    expect(error).toMatchObject({
      resetsAt: in3d,
      quotaRefusal: { basis: "owner_reserve", constraintId: "seven_day", usedRatio: 0.92 },
    });
  });
});

describe("multi-candidate reduction keeps only shared refusal details", () => {
  const limited = (constraintId: string, resetsAt: string): CandidateRun =>
    ({
      attemptId: constraintId,
      harnessId: "claude",
      errored: true,
      declaredFailure: {
        category: "harness_unavailable",
        code: "subscription_window_exhausted",
        resetsAt,
        quotaRefusal: {
          basis: "provider_cooldown",
          constraintId,
          usedRatio: null,
          threshold: null,
        },
      } satisfies DeclaredFailure,
    }) as CandidateRun;

  it("drops a window the candidates do not share instead of pairing it with another's reset", () => {
    expect(
      unanimousDeclaredFailure([limited("five_hour", in1h), limited("weekly", in2h)]),
    ).toMatchObject({
      resetsAt: in2h,
      quotaRefusal: { basis: "provider_cooldown", constraintId: null, usedRatio: null },
    });
  });

  it("keeps a window every candidate shares", () => {
    expect(
      unanimousDeclaredFailure([limited("five_hour", in1h), limited("five_hour", in2h)]),
    ).toMatchObject({
      resetsAt: in2h,
      quotaRefusal: { basis: "provider_cooldown", constraintId: "five_hour" },
    });
  });
});
