import { describe, expect, it } from "vitest";
import {
  REOPENING_UNKNOWN_COOLDOWN_ID,
  REOPENING_UNKNOWN_REFUSAL_CODE,
  type CredentialProfile,
  type QuotaConstraint,
  type QuotaSnapshot,
} from "@claudexor/schema";
import {
  credentialPoolExhausted,
  profileQuotaBlock,
  type PoolExhaustionCandidate,
} from "./credential-cooldown.js";
import {
  nextEligibleProfile,
  preflightDefaultSubject,
  type ProfilePolicy,
} from "./credential-profiles.js";
import { resolveAccountForRun, type AccountResolutionContext } from "./account-resolution.js";
import { selectFromAccountPool } from "./account-pool.js";
import { pinnedWindowBlocked, quotaRefusalWithScope } from "./quota-refusal-scope.js";

/** Strict-pin resolution context (D-U6): everything but the overrides inert. */
function resolutionCtx(overrides: Partial<AccountResolutionContext>): AccountResolutionContext {
  return {
    harnessId: "cursor",
    registry: [],
    policy: { limit_action: "rotate", rotation_eligible: [], headroom_threshold: 0.9 },
    snapshots: [],
    quota: { snapshots: [], absences: [] },
    unusable: [],
    probe: undefined,
    pinnedProfile: null,
    boundProfileId: null,
    threadId: null,
    model: null,
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "auto",
    notePoolApiKeyRoute: () => {},
    emit: () => {},
    ...overrides,
  };
}

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function profile(id: string): CredentialProfile {
  return {
    profile_id: id,
    harness_id: "cursor",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/p/${id}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
  };
}

function cooldownSnapshot(
  subjectId: string | null,
  constraint: Partial<QuotaConstraint> = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "cursor",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "cooldown",
        label: "Cooldown",
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: FUTURE,
        ...constraint,
      } as QuotaConstraint,
    ],
    source: "cursor_rate_limit",
    // STALE on purpose: the registry keeps an aged snapshot alive exactly
    // because its cooldown still extends into the future.
    observed_at: "2026-08-17T00:00:00.000Z",
    freshness: "stale",
  };
}

const policy: ProfilePolicy = {
  limit_action: "rotate",
  rotation_eligible: [],
  headroom_threshold: 0.9,
};

describe("profileQuotaBlock (A4 cooldown reader)", () => {
  it("a STALE snapshot with a live cooldown blocks, with typed evidence", () => {
    expect(profileQuotaBlock([cooldownSnapshot("a")], "cursor", "a", "local_session")).toEqual({
      blocked: true,
      constraint_id: "cooldown",
      resets_at: FUTURE,
      kind: "cooldown",
    });
  });

  it("an expired cooldown never blocks", () => {
    expect(
      profileQuotaBlock(
        [cooldownSnapshot("a", { cooldown_until: PAST })],
        "cursor",
        "a",
        "local_session",
      ),
    ).toBeNull();
  });

  it("a spent window with a known future reset blocks as exhausted; unknown reset never blocks", () => {
    expect(
      profileQuotaBlock(
        [cooldownSnapshot("a", { cooldown_until: null, used_ratio: 1, resets_at: FUTURE })],
        "cursor",
        "a",
        "local_session",
      ),
    ).toMatchObject({ kind: "exhausted", resets_at: FUTURE });
    expect(
      profileQuotaBlock(
        [cooldownSnapshot("a", { cooldown_until: null, used_ratio: 1, resets_at: null })],
        "cursor",
        "a",
        "local_session",
      ),
    ).toBeNull();
  });

  it("#558: a usage refusal blocks for its bounded cooldown, which is a recheck, never a reset", () => {
    const refused = cooldownSnapshot("a", { id: REOPENING_UNKNOWN_COOLDOWN_ID });
    expect(profileQuotaBlock([refused], "cursor", "a", "local_session")).toEqual({
      blocked: true,
      constraint_id: REOPENING_UNKNOWN_COOLDOWN_ID,
      resets_at: null,
      reopening: "unknown",
      recheck_at: FUTURE,
      kind: "cooldown",
    });
    expect(
      profileQuotaBlock([refused], "cursor", "a", "local_session", null, new Date(FUTURE)),
    ).toBeNull();
    // Controls: every other reset-less cooldown keeps its release as today, the
    // generic one, a vendor retry delay or day (`cooldown_until` only), and one
    // reported spent by another producer. Only the identity names the refusal.
    for (const constraint of [{}, { id: "cooldown:five_hour" }, { used_ratio: 1 }]) {
      const block = profileQuotaBlock(
        [cooldownSnapshot("a", constraint)],
        "cursor",
        "a",
        "local_session",
      );
      expect(block).toMatchObject({ resets_at: FUTURE });
      expect(block).not.toHaveProperty("reopening");
    }
  });

  it("#558: an active refusal decides the account whatever else blocks it; other dates stay with their windows", () => {
    const LATER = "2099-06-01T00:00:00.000Z";
    const refused = cooldownSnapshot("a", { id: REOPENING_UNKNOWN_COOLDOWN_ID });
    const window: QuotaSnapshot = {
      ...cooldownSnapshot("a", {
        id: "weekly",
        used_ratio: 1,
        resets_at: LATER,
        cooldown_until: null,
      }),
      source: "codex_app_server" as QuotaSnapshot["source"],
    };
    // The plain limit the vendor's words produce beside the typed code: a dated cooldown.
    const plain = cooldownSnapshot("a");
    const both: QuotaSnapshot = {
      ...refused,
      constraints: [...refused.constraints, ...plain.constraints, ...window.constraints],
    };
    for (const snapshots of [
      [refused, window],
      [window, refused],
      [plain, refused],
      [window, plain, refused],
      [both],
    ])
      expect(profileQuotaBlock(snapshots, "cursor", "a", "local_session")).toEqual({
        blocked: true,
        constraint_id: REOPENING_UNKNOWN_COOLDOWN_ID,
        resets_at: null,
        reopening: "unknown",
        recheck_at: FUTURE,
        kind: "cooldown",
      });
    const dated = {
      blocked: true,
      constraint_id: "weekly",
      resets_at: LATER,
      kind: "exhausted",
    };
    // Controls: the window alone keeps its date, and so does it once the refusal has lapsed.
    expect(profileQuotaBlock([window], "cursor", "a", "local_session")).toEqual(dated);
    expect(
      profileQuotaBlock([refused, window], "cursor", "a", "local_session", null, new Date(FUTURE)),
    ).toEqual(dated);
    // A refusal scoped to text never decides another request kind.
    const textOnly = cooldownSnapshot("a", {
      id: REOPENING_UNKNOWN_COOLDOWN_ID,
      applies_to_request_kinds: ["text"],
    });
    expect(
      profileQuotaBlock(
        [textOnly, window],
        "cursor",
        "a",
        "local_session",
        null,
        undefined,
        "image",
      ),
    ).toEqual(dated);
  });

  it("#558: the refusal's control problem is not the timer-healing code a raw caller reads", () => {
    const block = profileQuotaBlock(
      [cooldownSnapshot("a", { id: REOPENING_UNKNOWN_COOLDOWN_ID })],
      "cursor",
      "a",
      "local_session",
    )!;
    const error = quotaRefusalWithScope(pinnedWindowBlocked("a", "cursor", block), {
      harness: "cursor",
      profileId: "a",
    }) as Error & { problem: { code: string; context: Record<string, unknown> }; code: string };
    expect(error.problem.code).toBe(REOPENING_UNKNOWN_REFUSAL_CODE);
    expect(error.problem.context["resetsAt"]).toBeNull();
    expect(error.message).toContain("no reopening time named");
    expect(error.message).not.toContain("resets ");
  });

  it("#558: one member with no known reopening leaves the whole pool undated and not a quota claim", () => {
    const LATER = "2099-06-01T00:00:00.000Z";
    const snapshots = [
      cooldownSnapshot("a", { id: REOPENING_UNKNOWN_COOLDOWN_ID }),
      cooldownSnapshot("b", { used_ratio: 1, resets_at: LATER, cooldown_until: null }),
    ];
    const selection = selectFromAccountPool({
      registry: [profile("a"), profile("b")],
      harnessId: "cursor",
      snapshots,
      readyProfileIds: new Set(["a", "b"]),
      headroomThreshold: 1,
    });
    expect(selection).toMatchObject({ outcome: "exhausted", resets_at: null });
    const candidates: PoolExhaustionCandidate[] = [
      {
        profile_id: "a",
        rejected: "cooldown",
        headroom: null,
        cooldown: { resets_at: null, reopening: "unknown" },
      },
      {
        profile_id: "b",
        rejected: "headroom_exceeded",
        headroom: { resets_at: LATER },
        cooldown: null,
      },
    ];
    const error = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: null,
      reason: "profile_headroom_preflight",
      candidates,
      subjectLimit: null,
    }) as Error & { resetsAt: string | null; problem: { context: { poolCauses: string[] } } };
    expect(error.resetsAt).toBeNull();
    expect(error.problem.context.poolCauses.sort()).toEqual(["quota", "unavailable"]);
    // Alone, the refused member claims no quota at all, so no pool reader maps it to a timer.
    const alone = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: null,
      reason: "profile_headroom_preflight",
      candidates: candidates.slice(0, 1),
      subjectLimit: null,
    }) as Error & { problem: { context: { poolCauses: string[] } } };
    expect(alone.problem.context.poolCauses).toEqual(["unavailable"]);
    // A reserve breach's date on the same member is that window's, and promises the pool nothing.
    const breached = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: null,
      reason: "profile_headroom_preflight",
      candidates: [
        {
          profile_id: "a",
          rejected: "headroom_exceeded",
          headroom: { resets_at: LATER },
          cooldown: { resets_at: null, reopening: "unknown" },
        },
      ],
      subjectLimit: null,
    }) as Error & { resetsAt: string | null; problem: { context: { poolCauses: string[] } } };
    expect(breached.resetsAt).toBeNull();
    expect(breached.problem.context.poolCauses).toEqual(["unavailable"]);
  });

  it("blocks only the snapshot's own subject — never a sibling or the default", () => {
    const snapshots = [cooldownSnapshot("a")];
    expect(profileQuotaBlock(snapshots, "cursor", "a", "local_session")).not.toBeNull();
    expect(profileQuotaBlock(snapshots, "cursor", "b", "local_session")).toBeNull();
    expect(profileQuotaBlock(snapshots, "cursor", null, "local_session")).toBeNull();
    expect(profileQuotaBlock(snapshots, "codex", "a", "local_session")).toBeNull();
  });

  it("route-scoped: an api_key-route cooldown never blocks the subscription-session default of the same harness (and vice versa)", () => {
    // Both defaults carry subject_id=null — the credential_route is the only
    // thing separating the managed-api-key subject from the native session.
    const apiKeyDefault: QuotaSnapshot = {
      ...cooldownSnapshot(null),
      subject: {
        harness: "cursor",
        credential_route: "managed_api_key",
        plan_label: null,
        subject_id: null,
      },
    };
    expect(profileQuotaBlock([apiKeyDefault], "cursor", null, "local_session")).toBeNull();
    expect(profileQuotaBlock([apiKeyDefault], "cursor", null, "api_key")).not.toBeNull();
    const nativeDefault = cooldownSnapshot(null); // vendor_native subject
    expect(profileQuotaBlock([nativeDefault], "cursor", null, "api_key")).toBeNull();
    expect(profileQuotaBlock([nativeDefault], "cursor", null, "local_session")).not.toBeNull();
  });

  it("a Gemini-scoped cooldown never cools the grok lane on the same account", () => {
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(profileQuotaBlock(scoped, "cursor", "a", "local_session", "grok-4.6")).toBeNull();
    expect(
      profileQuotaBlock(scoped, "cursor", "a", "local_session", "Gemini 3.7 Flash High"),
    ).not.toBeNull();
  });

  it("fails OPEN when a display label cannot be proven to cover the routed slug", () => {
    // The init frame reports "Gemini 3.7 Flash High"; the router spends by
    // slug. Unprovable coverage must leave the subject spendable, never cool
    // every model on the account.
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(
      profileQuotaBlock(scoped, "cursor", "a", "local_session", "gemini-3.7-flash"),
    ).toBeNull();
    // Provable containment still blocks (alias ⊂ slug).
    const alias = [cooldownSnapshot("a", { applies_to_models: ["gemini"] })];
    expect(
      profileQuotaBlock(alias, "cursor", "a", "local_session", "gemini-3.7-flash"),
    ).not.toBeNull();
  });

  it("with no model context a scoped window blocks only when it governs the unspecified route", () => {
    const scoped = [cooldownSnapshot("a", { applies_to_models: ["Gemini 3.7 Flash High"] })];
    expect(profileQuotaBlock(scoped, "cursor", "a", "local_session", null)).toBeNull();
    const governing = [
      cooldownSnapshot("a", {
        applies_to_models: ["Gemini 3.7 Flash High"],
        applies_to_unspecified_model: true,
      }),
    ];
    expect(profileQuotaBlock(governing, "cursor", "a", "local_session", null)).not.toBeNull();
  });
});

describe("A4 wiring: rotation and preflight see observed live blocks", () => {
  const a = profile("a");
  const b = profile("b");
  const ready = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  it("nextEligibleProfile skips a candidate whose own windows are still cooling", () => {
    expect(
      nextEligibleProfile([a, b], "cursor", policy, a, [cooldownSnapshot("b")], ready("b")),
    ).toBeNull();
    expect(
      nextEligibleProfile(
        [a, b],
        "cursor",
        policy,
        a,
        [cooldownSnapshot("b", { cooldown_until: PAST })],
        ready("b"),
      )?.profile_id,
    ).toBe("b");
  });

  it("a PINNED profile's live cooldown refuses TYPED for EVERY limit_action — a pin never rotates (D-U6 + A4)", async () => {
    for (const limit_action of ["rotate", "fail", "auto"] as const) {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      await expect(
        resolveAccountForRun(
          resolutionCtx({
            pinnedProfile: a,
            registry: [a, b],
            policy: { ...policy, limit_action },
            snapshots: [cooldownSnapshot("a")],
            emit: (type, payload) => events.push({ type, payload }),
          }),
        ),
      ).rejects.toMatchObject({
        code: "subscription_window_exhausted",
        category: "harness_unavailable",
        resetsAt: FUTURE,
      });
      expect(events.map((e) => e.type)).toEqual(["route.profile.headroom_exceeded"]);
      expect(events[0]?.payload).toMatchObject({
        profile_id: "a",
        action: "refuse",
        constraint_id: "cooldown",
        resets_at: FUTURE,
      });
    }
  });

  it("rotation_exhausted names a cooling candidate `cooldown` with its release instant, then refuses TYPED (A5)", () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    // The LEGACY default subject's own live block + a fully-blocked pool is
    // hard evidence (A5 preflight split): the refusal happens BEFORE spawn
    // instead of proceeding into a certain vendor rejection.
    expect(() =>
      preflightDefaultSubject({
        harnessId: "cursor",
        policy,
        registry: [b],
        snapshots: [cooldownSnapshot(null), cooldownSnapshot("b")],
        readyProfileIds: ready("b"),
        defaultRoute: "local_session",
        emit: (type, payload) => events.push({ type, payload }),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "credential_pool_exhausted",
        category: "harness_unavailable",
        resetsAt: FUTURE,
      }),
    );
    const exhausted = events.find((e) => e.type === "route.profile.rotation_exhausted");
    const candidates = exhausted?.payload["candidates"] as Array<Record<string, unknown>>;
    expect(candidates.find((c) => c["profile_id"] === "b")).toMatchObject({
      rejected: "cooldown",
      resets_at: FUTURE,
      cooldown: { kind: "cooldown", resets_at: FUTURE },
    });
  });

  it("the LEGACY default subject fails over to a profile when its own windows are cooling", () => {
    // Unified model: the legacy ladder (a harness with no registered rows)
    // rotates its cooling default onto the next eligible profile — the same
    // A4 block evidence the pool ranking consumes for registered rows.
    expect(
      preflightDefaultSubject({
        harnessId: "cursor",
        policy,
        registry: [b],
        snapshots: [cooldownSnapshot(null)],
        readyProfileIds: ready("b"),
        defaultRoute: "local_session",
        model: null,
        emit: () => {},
      })?.profile_id,
    ).toBe("b");
  });
});

describe("credentialPoolExhausted reset fold (dead-subject exclusion)", () => {
  const SUBJECT_RESET = "2026-09-12T00:00:00.000Z"; // earlier than FUTURE
  const memberRow = (
    id: string,
    resetsAt: string | null,
    over: Partial<PoolExhaustionCandidate> = {},
  ): PoolExhaustionCandidate => ({
    profile_id: id,
    rejected: "cooldown",
    headroom: null,
    cooldown: { resets_at: resetsAt },
    unusable: null,
    ...over,
  });
  const deadSubjectRow: PoolExhaustionCandidate = {
    profile_id: "a",
    rejected: "current",
    headroom: null,
    cooldown: null,
    unusable: { code: "auth_revoked" },
  };
  const resetsAt = (failure: Error): string | null =>
    (failure as Error & { resetsAt: string | null }).resetsAt;

  it("a DEAD subject's own limit reset is excluded — the fold reflects only evidenced pool members", () => {
    const failure = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: "a",
      reason: "vendor_limit_rejected",
      candidates: [deadSubjectRow, memberRow("b", FUTURE)],
      subjectLimit: { resets_at: SUBJECT_RESET },
      subjectUnusable: { code: "auth_revoked" },
    });
    // The dead subject's EARLIER reset must not become the reopen promise.
    expect(resetsAt(failure)).toBe(FUTURE);
  });

  it("a dead subject with NO evidenced members leaves the reset honestly unknown", () => {
    const failure = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: "a",
      reason: "vendor_limit_rejected",
      candidates: [deadSubjectRow],
      subjectLimit: { resets_at: SUBJECT_RESET },
      subjectUnusable: { code: "auth_revoked" },
    });
    expect(resetsAt(failure)).toBeNull();
    expect(failure.message).toContain("observed unusable (auth_revoked)");
  });

  it("a LIVE subject's own limit still joins the fold (unchanged A5 contract)", () => {
    const failure = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: "a",
      reason: "vendor_limit_rejected",
      candidates: [memberRow("b", FUTURE)],
      subjectLimit: { resets_at: SUBJECT_RESET },
      subjectUnusable: null,
    });
    expect(resetsAt(failure)).toBe(SUBJECT_RESET);
  });

  it("a dead MEMBER-labeled row neither shapes nor poisons the fold", () => {
    // A dead already-tried row with an UNKNOWN reset would poison the fold to
    // null under the honesty rule; a dead credential's windows are excluded
    // instead, so the living member's reset survives.
    const failure = credentialPoolExhausted({
      harnessId: "cursor",
      profileId: null,
      reason: "structural_pre_progress_failure",
      candidates: [
        memberRow("dead", null, { rejected: "already_tried", unusable: { code: "auth_revoked" } }),
        memberRow("living", FUTURE),
      ],
      subjectLimit: null,
    });
    expect(resetsAt(failure)).toBe(FUTURE);
  });
});
