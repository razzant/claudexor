/**
 * A spent subscription window must arrive as a MACHINE-READABLE terminal: an
 * automating caller decides when to come back from `code` + `resetsAt`, never
 * by reading `safeMessage`.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "@claudexor/artifact-store";
import { EventLog } from "@claudexor/event-log";
import {
  HarnessRunSpec,
  RunFailure,
  type CredentialProfile,
  type QuotaConstraint,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { type CandidateRun, unanimousDeclaredFailure } from "./candidateEvidence.js";
import { preflightDefaultSubject } from "./credential-preflight.js";
import {
  profileHeadroomBreach,
  rotateSpecOnTypedLimit,
  type ProfilePolicy,
} from "./credential-profile-rotation.js";
import { resolveAccountForRun } from "./account-resolution.js";
import { subscriptionWindowExhausted } from "./quota-refusal-scope.js";
import { type DeclaredFailure, failTerminally } from "./runTerminalResults.js";
import { writeRoutingFailureTerminal } from "./routing-failure.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

const RESETS_AT = "2026-08-02T18:00:00.000Z";

const profile: CredentialProfile = {
  profile_id: "valentine",
  harness_id: "claude",
  display_name: "Valentine",
  credential_kind: "config_dir_login",
  isolation_locator: "/tmp/p/valentine",
  secret_ref: null,
  enabled: true,
  created_at: null,
};

const spent: QuotaSnapshot = {
  subject: {
    harness: "claude",
    credential_route: "vendor_native",
    plan_label: null,
    subject_id: "valentine",
  },
  constraints: [
    {
      id: "weekly_scoped:Fable",
      label: "7 day (Fable)",
      used_ratio: 0.91,
      window_seconds: 604800,
      resets_at: RESETS_AT,
      cooldown_until: null,
    },
  ],
  source: "claude_oauth_usage",
  observed_at: "2026-08-02T12:00:00.000Z",
  freshness: "fresh",
};

function refusal(): unknown {
  // The strict-pin refusal path (D-U6): a fresh breach of the pinned
  // account's window becomes the typed subscription_window_exhausted error.
  const breach = profileHeadroomBreach([spent], "claude", profile.profile_id, 0.9, null);
  if (!breach) throw new Error("fixture snapshot did not breach the headroom threshold");
  return subscriptionWindowExhausted(profile.profile_id, "claude", breach);
}

function terminalFailure(error: unknown): RunFailure {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-quota-refusal-")));
  dirs.push(repo);
  const store = new ArtifactStore(repo);
  const paths = store.createRun("run-quota");
  const log = new EventLog(paths.eventsPath, "run-quota", "task-quota");
  failTerminally(log, store, paths, "run-quota", "task-quota", "agent", "routing", error);
  // failure.yaml is the durable contract surface: read it back the way a caller
  // does rather than trusting the argument that was handed to the writer.
  return RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
}

describe("subscription window exhaustion", () => {
  // The fixture is fresh evidence at its own decision instant (#457 judges
  // freshness per window at the decision, not by the stored label alone).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-02T12:01:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("refuses with a typed code, category and structural reset time", () => {
    expect(refusal()).toMatchObject({
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: RESETS_AT,
    });
  });

  it("lands in failure.yaml as machine-readable fields, not prose", () => {
    const failure = terminalFailure(refusal());
    expect(failure.code).toBe("subscription_window_exhausted");
    expect(failure.category).toBe("harness_unavailable");
    expect(failure.resetsAt).toBe(RESETS_AT);
  });

  it("records the owner-reserve basis of a strict-pin refusal through the routing terminal", async () => {
    const reserve: QuotaSnapshot = {
      ...spent,
      observed_at: new Date().toISOString(),
      constraints: [
        {
          ...spent.constraints[0]!,
          used_ratio: 0.9,
          resets_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    };
    const error = await resolveAccountForRun({
      harnessId: "claude",
      registry: [profile],
      policy: { limit_action: "fail", rotation_eligible: [], headroom_threshold: 0.9 },
      snapshots: [reserve],
      quota: { snapshots: [], absences: [] },
      unusable: [],
      probe: undefined,
      pinnedProfile: profile,
      boundProfileId: null,
      threadId: null,
      model: null,
      defaultRoute: "local_session",
      nativeCredentialsDisabled: false,
      authPreference: "subscription",
      notePoolApiKeyRoute: () => undefined,
      emit: () => undefined,
    }).catch((e: unknown) => e);
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "cx-quota-reserve-")));
    dirs.push(repo);
    const store = new ArtifactStore(repo);
    const paths = store.createRun("run-reserve");
    const log = new EventLog(paths.eventsPath, "run-reserve", "task-reserve");
    writeRoutingFailureTerminal(store, paths, log, {
      runId: "run-reserve",
      modeLabel: "agent",
      message: (error as Error).message,
      err: error,
    });
    const failure = RunFailure.parse(store.readYaml(join(paths.finalDir, "failure.yaml")));
    expect(failure).toMatchObject({
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      quotaRefusal: {
        basis: "owner_reserve",
        constraintId: "weekly_scoped:Fable",
        usedRatio: 0.9,
        threshold: 0.9,
      },
    });
    expect(failure.nextActions.join(" ")).toContain("reserve");
  });

  it("still defaults an untyped throw to internal with no reset time", () => {
    const failure = terminalFailure(new Error("something broke"));
    expect(failure.category).toBe("internal");
    expect(failure.code).toBeNull();
    expect(failure.resetsAt).toBeNull();
  });

  it("ignores a foreign category an unrelated error happens to carry", () => {
    const failure = terminalFailure(
      Object.assign(new Error("adapter said timeout"), { category: "timeout" }),
    );
    expect(failure.category).toBe("internal");
  });
});

describe("unanimousDeclaredFailure (no ranking of mixed causes)", () => {
  const window = (resetsAt: string | null): DeclaredFailure => ({
    category: "harness_unavailable",
    code: "subscription_window_exhausted",
    resetsAt,
  });

  const slot = (declaredFailure?: DeclaredFailure): CandidateRun =>
    ({ attemptId: "a", harnessId: "h", errored: true, declaredFailure }) as CandidateRun;

  it("carries the LATEST reset when every candidate died of the same window", () => {
    expect(
      unanimousDeclaredFailure([
        slot(window("2026-08-02T12:00:00.000Z")),
        slot(window("2026-08-02T18:00:00.000Z")),
        slot(window("2026-08-02T15:00:00.000Z")),
      ]),
    ).toEqual(window("2026-08-02T18:00:00.000Z"));
    // Waiting out the EARLIEST would return to two windows that are still spent.
  });

  it("refuses to speak for a run whose candidates failed differently", () => {
    expect(unanimousDeclaredFailure([slot(window(RESETS_AT)), slot(undefined)])).toBeNull();
    expect(
      unanimousDeclaredFailure([
        slot(window(RESETS_AT)),
        slot({ category: "budget", code: "hard_cap", resetsAt: null }),
      ]),
    ).toBeNull();
  });

  it("reports an unknown reset rather than a partial one", () => {
    expect(unanimousDeclaredFailure([slot(window(RESETS_AT)), slot(window(null))])).toEqual(
      window(null),
    );
  });

  it("has nothing to say about an empty or untyped candidate set", () => {
    expect(unanimousDeclaredFailure([])).toBeNull();
    expect(unanimousDeclaredFailure([slot(undefined), slot(undefined)])).toBeNull();
  });
});

// A5: the WHOLE pool refused. Within ONE pool the fold is the EARLIEST known
// reset (one reopened member is enough to retry) — the across-candidates
// LATEST rule above stays untouched.
describe("credential pool exhaustion (A5)", () => {
  const EARLY = "2099-01-01T06:00:00.000Z";
  const MID = "2099-01-01T12:00:00.000Z";
  const LATE = "2099-01-01T18:00:00.000Z";

  const mkProfile = (id: string): CredentialProfile => ({
    ...profile,
    profile_id: id,
    display_name: id,
    isolation_locator: `/tmp/p/${id}`,
  });

  const snapshotFor = (
    subjectId: string | null,
    constraint: Partial<QuotaConstraint>,
  ): QuotaSnapshot => ({
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "window",
        label: "Window",
        used_ratio: null,
        window_seconds: null,
        resets_at: null,
        cooldown_until: null,
        ...constraint,
      } as QuotaConstraint,
    ],
    source: "claude_oauth_usage",
    observed_at: new Date().toISOString(),
    freshness: "fresh",
  });

  const rotatePolicy: ProfilePolicy = {
    limit_action: "rotate",
    rotation_eligible: [],
    headroom_threshold: 0.9,
  };

  const rotateArgs = (snapshots: QuotaSnapshot[], lastResetsAt: string | null) => ({
    spec: HarnessRunSpec.parse({
      session_id: "se-1",
      intent: "implement" as const,
      prompt: "go",
      cwd: "/repo",
    }),
    harnessId: "claude",
    attemptId: "a01",
    policy: rotatePolicy,
    registry: [mkProfile("b"), mkProfile("c")],
    quotaSnapshots: () => snapshots,
    probeReadyProfiles: async () => new Set(["b", "c"]),
    triedProfiles: new Set<string>(),
    markers: { sawAgentProgress: false, fileChanges: 0 },
    sawTypedLimit: true,
    sawRetryable: true,
    attemptErrored: true,
    deliverableEmpty: true,
    lastLimit: { retryDelayMs: null, resetsAt: lastResetsAt },
    emit: () => {},
    newSessionId: () => "se-2",
    defaultRouteWasVendorNative: true,
  });

  it("terminalizes with the EARLIEST reset within the pool, the default subject's own limit included", async () => {
    // Pool: b reopens LATE, c reopens MID; the DEFAULT subject itself reopens
    // EARLY — the registry's own evidence for the triggering subject joins the
    // fold (and outranks the raw stream limit's unknown reset).
    const result = await rotateSpecOnTypedLimit(
      rotateArgs(
        [
          snapshotFor("b", { cooldown_until: LATE }),
          snapshotFor("c", { cooldown_until: MID }),
          snapshotFor(null, { cooldown_until: EARLY }),
        ],
        null,
      ),
    );
    expect(result).toMatchObject({
      poolExhausted: {
        code: "credential_pool_exhausted",
        category: "harness_unavailable",
        resetsAt: EARLY,
      },
    });
  });

  it("an unknown reset anywhere in the pool makes the pool's reset unknown", async () => {
    // The triggering subject's typed limit carried NO reset (the cursor
    // day-granularity class) and the registry has not ingested it: the pool
    // cannot promise a reopen time even though b's reset is known.
    const result = await rotateSpecOnTypedLimit(
      rotateArgs(
        [snapshotFor("b", { cooldown_until: MID }), snapshotFor("c", { cooldown_until: LATE })],
        null,
      ),
    );
    expect(result).toMatchObject({
      poolExhausted: { code: "credential_pool_exhausted", resetsAt: null },
    });
  });

  it("an api_key sibling's stale cooldown is NEVER pool evidence for a subscription subject (member-only gate)", async () => {
    // A subscription (native-session) subject dies structurally; the only
    // registered identity is a METERED api_key sibling — a row rotation could
    // never select (`credential_kind_mismatch`). Its own cooldown evidence
    // must not let the terminal claim "the credential pool refused": the
    // attempt keeps its TRUE failure (fail-as-is → null).
    const metered: CredentialProfile = {
      ...profile,
      profile_id: "metered",
      display_name: "metered",
      credential_kind: "api_key",
      isolation_locator: null,
      secret_ref: "anthropic_key:metered",
    };
    const meteredCooldown: QuotaSnapshot = {
      ...snapshotFor("metered", { cooldown_until: MID }),
      subject: {
        harness: "claude",
        credential_route: "managed_api_key",
        plan_label: null,
        subject_id: "metered",
      },
    };
    const result = await rotateSpecOnTypedLimit({
      ...rotateArgs([meteredCooldown], null),
      registry: [metered],
      probeReadyProfiles: async () => new Set<string>(),
      // STRUCTURAL death: no typed limit, so the subject carries no evidence.
      sawTypedLimit: false,
      sawRetryable: false,
    });
    expect(result).toBeNull();
  });

  it("lands in failure.yaml with its code and folded reset intact", async () => {
    const result = await rotateSpecOnTypedLimit(
      rotateArgs(
        [snapshotFor("b", { cooldown_until: MID }), snapshotFor("c", { cooldown_until: LATE })],
        EARLY,
      ),
    );
    const failure = terminalFailure(
      result && "poolExhausted" in result ? result.poolExhausted : null,
    );
    expect(failure.code).toBe("credential_pool_exhausted");
    expect(failure.category).toBe("harness_unavailable");
    // b reopens MID; the subject's own typed limit says EARLY — earliest wins.
    expect(failure.resetsAt).toBe(EARLY);
  });

  it("a PINNED subject's OBSERVED spent window refuses TYPED before spawn — a pin never rotates (D-U6 + A4)", async () => {
    const events: string[] = [];
    await expect(
      resolveAccountForRun({
        harnessId: "claude",
        registry: [profile],
        policy: rotatePolicy,
        snapshots: [
          snapshotFor("valentine", { used_ratio: 1, resets_at: MID, window_seconds: 604800 }),
        ],
        quota: { snapshots: [], absences: [] },
        unusable: [],
        probe: undefined,
        pinnedProfile: profile,
        boundProfileId: null,
        threadId: null,
        model: null,
        defaultRoute: "local_session",
        nativeCredentialsDisabled: false,
        authPreference: "auto",
        notePoolApiKeyRoute: () => {},
        emit: (type) => events.push(type),
      }),
    ).rejects.toMatchObject({
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: MID,
    });
    // The refusal is a decision with provenance: the typed event precedes it,
    // and the pool is never consulted for a pin.
    expect(events).toEqual(["route.profile.headroom_exceeded"]);
  });

  it("legacy default subject under rotate: a bare headroom breach with no alternative PROCEEDS (not proven spent)", () => {
    const kept = preflightDefaultSubject({
      harnessId: "claude",
      policy: rotatePolicy,
      registry: [],
      snapshots: [
        // 0.91 of the DEFAULT subject's window — proximity, not exhaustion.
        snapshotFor(null, { used_ratio: 0.91, resets_at: RESETS_AT, window_seconds: 604800 }),
      ],
      readyProfileIds: new Set(),
      defaultRoute: "local_session",
      emit: () => {},
    });
    // null = keep the default subject: the run proceeds and the vendor is
    // the truth (a bare breach never becomes a pool terminal).
    expect(kept).toBeNull();
  });

  it("preflight default subject: its own live block with a fully-blocked pool refuses TYPED with the earliest reset", () => {
    expect(() =>
      preflightDefaultSubject({
        harnessId: "claude",
        policy: rotatePolicy,
        registry: [mkProfile("b")],
        snapshots: [
          snapshotFor(null, { cooldown_until: MID }),
          snapshotFor("b", { cooldown_until: EARLY }),
        ],
        readyProfileIds: new Set(["b"]),
        defaultRoute: "local_session",
        emit: () => {},
      }),
    ).toThrowError(expect.objectContaining({ code: "credential_pool_exhausted", resetsAt: EARLY }));
  });

  it("reads the quota authority once, after both probes; the exhausted event and terminal agree (#457)", async () => {
    const order: string[] = [];
    // A second read would see different evidence; one read keeps the event
    // and the terminal on the same value.
    const reads = [
      [snapshotFor("b", { cooldown_until: MID }), snapshotFor("c", { cooldown_until: LATE })],
      [snapshotFor("b", { cooldown_until: EARLY }), snapshotFor("c", { cooldown_until: EARLY })],
    ];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const result = await rotateSpecOnTypedLimit({
      ...rotateArgs([], LATE),
      quotaSnapshots: () => {
        order.push("quota");
        return reads[order.filter((step) => step === "quota").length - 1] ?? [];
      },
      probeReadyProfiles: async () => {
        order.push("ready");
        return new Set(["b", "c"]);
      },
      probeCurrentSubject: async () => {
        order.push("subject");
        return null;
      },
      emit: (type, payload) => events.push({ type, payload }),
    });
    expect(order).toEqual(["ready", "subject", "quota"]);
    const exhausted = events.find((e) => e.type === "route.profile.rotation_exhausted");
    expect(exhausted?.payload["candidates"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile_id: "b", rejected: "cooldown", resets_at: MID }),
        expect.objectContaining({ profile_id: "c", rejected: "cooldown", resets_at: LATE }),
      ]),
    );
    expect(result).toMatchObject({ poolExhausted: { resetsAt: MID } });
  });

  it("a pinned or ineligible decision never reads the quota authority (#457)", async () => {
    let reads = 0;
    const quotaSnapshots = () => {
      reads += 1;
      return [];
    };
    await rotateSpecOnTypedLimit({ ...rotateArgs([], EARLY), quotaSnapshots, pinned: true });
    await rotateSpecOnTypedLimit({
      ...rotateArgs([], EARLY),
      quotaSnapshots,
      sawTypedLimit: false,
      sawRetryable: false,
      markers: { sawAgentProgress: true, fileChanges: 0 },
    });
    expect(reads).toBe(0);
  });
});
