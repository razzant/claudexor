/**
 * Account tiers and the complexity route table (INV-135): the deterministic
 * selection for a run that states a complexity, and its absence for a run that
 * does not. No model is asked anywhere on this path, so every case is plain
 * arithmetic over rows and quota windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountTierPolicy,
  ComplexityRouteTable,
  GlobalConfig,
  type ComplexityRoute,
  type CredentialProfile,
  type QuotaSnapshot,
} from "@claudexor/schema";
import { rankAccountPool, selectFromAccountPool } from "./account-pool.js";
import { resolveAccountForRun, type AccountResolutionContext } from "./account-resolution.js";
import { tierRotationOrder, tierRoutingFor, type TierRouting } from "./account-tier-routing.js";
import {
  COMPLEXITY_ROUTE_REFUSED,
  ComplexityTrace,
  resolveComplexityPool,
  type ComplexityLane,
} from "./complexity-routing.js";

const NOW = Date.parse("2026-08-18T00:01:00Z");
const OBSERVED = "2026-08-18T00:00:00Z";
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const WEEK = 7 * 24 * 3600;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function row(
  id: string,
  tier?: CredentialProfile["tier"],
  harness = "claude",
  overrides: Partial<CredentialProfile> = {},
): CredentialProfile {
  return {
    profile_id: id,
    harness_id: harness,
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/claudexor-test/profiles/${harness}-${id}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...(tier ? { tier } : {}),
    ...overrides,
  };
}

/** One quota window of one account; the source is whatever feeds that harness. */
function quota(
  id: string,
  used: number | null,
  options: {
    harness?: string;
    resetsAt?: string | null;
    seconds?: number | null;
    freshness?: "fresh" | "stale";
    cooldownUntil?: string | null;
    window?: string;
  } = {},
): QuotaSnapshot {
  const harness = options.harness ?? "claude";
  return {
    subject: {
      harness,
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: id,
    },
    constraints: [
      {
        id: options.window ?? "weekly",
        label: "window",
        used_ratio: used,
        window_seconds: options.seconds === undefined ? WEEK : options.seconds,
        resets_at: options.resetsAt === undefined ? at(48 * HOUR) : options.resetsAt,
        cooldown_until: options.cooldownUntil ?? null,
      },
    ],
    source:
      harness === "grok"
        ? "grok_local_usage"
        : harness === "codex"
          ? "codex_app_server"
          : "claude_oauth_usage",
    observed_at: OBSERVED,
    freshness: options.freshness ?? "fresh",
  };
}

const TIER: TierRouting = tierRoutingFor("medium", AccountTierPolicy.parse({}))!;
const ids = (ranked: { profile: CredentialProfile }[]) => ranked.map((c) => c.profile.profile_id);
const ready = (registry: CredentialProfile[]) => new Set(registry.map((r) => r.profile_id));

function rank(registry: CredentialProfile[], snapshots: QuotaSnapshot[], tier?: TierRouting) {
  return rankAccountPool({
    registry,
    harnessId: registry[0]!.harness_id,
    snapshots,
    readyProfileIds: ready(registry),
    headroomThreshold: 1,
    model: null,
    ...(tier ? { tier } : {}),
  });
}

function ctx(overrides: Partial<AccountResolutionContext>): AccountResolutionContext & {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const snapshots = overrides.snapshots ?? [];
  return {
    harnessId: "claude",
    registry: [],
    policy: { limit_action: "auto", rotation_eligible: [], headroom_threshold: 1 },
    snapshots,
    quota: { snapshots: [...snapshots], absences: [] },
    unusable: [],
    probe: async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "test probe",
      last_verified_at: null,
    }),
    pinnedProfile: null,
    boundProfileId: null,
    threadId: null,
    model: null,
    defaultRoute: "local_session",
    nativeCredentialsDisabled: false,
    authPreference: "auto",
    notePoolApiKeyRoute: () => {},
    emit: (type, payload) => events.push({ type, payload }),
    ...overrides,
    events,
  };
}

describe("no tier configuration: routing is unchanged", () => {
  it("defaults to an empty table, an 85% weekly reserve and no allowance", () => {
    const routing = GlobalConfig.parse({}).routing;
    expect(routing.complexity_routes).toEqual({});
    expect(routing.account_tiers.primary_reserve.weekly_used_ratio).toBe(0.85);
    expect(routing.account_tiers.allowances).toEqual({});
  });

  it("a run without a complexity builds no tier policy and no pool", () => {
    expect(tierRoutingFor(undefined, AccountTierPolicy.parse({}))).toBeNull();
    expect(resolveComplexityPool({ harnesses: ["claude"] }, {})).toBeNull();
  });

  it("ranks marked rows exactly as unmarked ones when the run states no complexity", () => {
    const snapshots = [quota("a", 0.2), quota("b", 0.95), quota("c", 0.5)];
    const plain = rank([row("a"), row("b"), row("c"), row("d")], snapshots);
    const marked = rank(
      [row("a", "primary"), row("b", "auxiliary"), row("c", "auxiliary"), row("d", "primary")],
      snapshots,
    );
    // Headroom descending, then unknown: a primary row at 95% is still usable
    // and an unknown primary row is still eligible, as before this feature.
    expect(ids(marked)).toEqual(["a", "c", "b", "d"]);
    expect(marked.map((c) => c.verdict)).toEqual(plain.map((c) => c.verdict));
  });

  it("keeps the ordinary order for untiered rows even under a complexity", () => {
    const registry = [row("a"), row("b"), row("c")];
    const snapshots = [quota("a", 0.6), quota("b", 0.1)];
    expect(ids(rank(registry, snapshots, TIER))).toEqual(ids(rank(registry, snapshots)));
  });
});

describe("tier order for a run that states a complexity", () => {
  it("uses an auxiliary account before a primary one with more room", () => {
    const registry = [row("lead", "primary"), row("spare", "auxiliary")];
    const ranked = rank(registry, [quota("lead", 0.05), quota("spare", 0.8)], TIER);
    expect(ids(ranked)).toEqual(["spare", "lead"]);
  });

  it("moves to the primary account only once every auxiliary one is exhausted", () => {
    const registry = [row("lead", "primary"), row("s1", "auxiliary"), row("s2", "auxiliary")];
    const select = (snapshots: QuotaSnapshot[]) =>
      selectFromAccountPool({
        registry,
        harnessId: "claude",
        snapshots,
        readyProfileIds: ready(registry),
        headroomThreshold: 1,
        model: null,
        tier: TIER,
      });
    const one = select([quota("lead", 0.1), quota("s1", 1), quota("s2", 0.4)]);
    expect(one.outcome === "selected" && one.candidate.profile.profile_id).toBe("s2");
    const none = select([quota("lead", 0.1), quota("s1", 1), quota("s2", 1)]);
    expect(none.outcome === "selected" && none.candidate.profile.profile_id).toBe("lead");
  });

  it("prefers the auxiliary account whose limiting window resets soonest", () => {
    const registry = [row("a", "auxiliary"), row("b", "auxiliary"), row("c", "auxiliary")];
    const ranked = rank(
      registry,
      [
        // "a" has the most room but loses nothing soon; "c" resets first.
        quota("a", 0.1, { resetsAt: at(72 * HOUR) }),
        quota("b", 0.5, { resetsAt: at(30 * HOUR) }),
        quota("c", 0.7, { resetsAt: at(2 * HOUR) }),
      ],
      TIER,
    );
    expect(ids(ranked)).toEqual(["c", "b", "a"]);
  });

  it("breaks an equal reset by headroom, then by profile id", () => {
    const registry = [row("z", "auxiliary"), row("m", "auxiliary"), row("a", "auxiliary")];
    const same = { resetsAt: at(5 * HOUR) };
    expect(
      ids(
        rank(registry, [quota("z", 0.2, same), quota("m", 0.6, same), quota("a", 0.6, same)], TIER),
      ),
    ).toEqual(["z", "a", "m"]);
  });

  it("puts a window with no known reset after every dated one", () => {
    const registry = [row("a", "auxiliary"), row("b", "auxiliary")];
    const ranked = rank(
      registry,
      [quota("a", 0.1, { resetsAt: null }), quota("b", 0.6, { resetsAt: at(HOUR) })],
      TIER,
    );
    expect(ids(ranked)).toEqual(["b", "a"]);
  });

  it("skips an auxiliary account under a live cooldown", () => {
    const registry = [row("a", "auxiliary"), row("b", "auxiliary")];
    const ranked = rank(
      registry,
      [
        quota("a", null, { cooldownUntil: at(HOUR), resetsAt: null, window: "cooldown" }),
        quota("b", 0.9),
      ],
      TIER,
    );
    expect(ranked.map((c) => [c.profile.profile_id, c.verdict.kind])).toEqual([
      ["b", "fresh_headroom"],
      ["a", "exhausted"],
    ]);
  });

  it("orders in-run rotation auxiliary, untiered, then primary", () => {
    const registry = [row("p", "primary"), row("u"), row("x", "auxiliary"), row("y", "auxiliary")];
    expect(tierRotationOrder(registry, "claude", [])).toEqual(["x", "y", "u", "p"]);
    expect(tierRotationOrder(registry, "claude", ["p", "y"])).toEqual(["y", "p"]);
  });
});

describe("primary reserve", () => {
  const primary = [row("lead", "primary")];
  const verdictAt = (used: number, options: Parameters<typeof quota>[2] = {}) =>
    rank(primary, [quota("lead", used, options)], TIER)[0]!.verdict;

  it("serves a primary account just below 85% of its weekly window", () => {
    expect(verdictAt(0.8499).kind).toBe("fresh_headroom");
  });

  it("refuses it at exactly 85%, as the owner's reserve with that window's reset", () => {
    expect(verdictAt(0.85, { resetsAt: at(20 * HOUR) })).toEqual({
      kind: "exhausted",
      resets_at: at(20 * HOUR),
      basis: "owner_reserve",
    });
  });

  it("applies the separate short-window ceiling to a short window", () => {
    const short = { seconds: 5 * 3600, window: "five_hour" };
    // 87% is over the weekly reserve but under the 90% short-window ceiling.
    expect(verdictAt(0.87, short).kind).toBe("fresh_headroom");
    expect(verdictAt(0.9, short)).toMatchObject({ kind: "exhausted", basis: "owner_reserve" });
  });

  it("reads both ceilings from the configuration", () => {
    const tier = tierRoutingFor(
      "hard",
      AccountTierPolicy.parse({
        primary_reserve: { weekly_used_ratio: 0.5, short_window_used_ratio: 0.6 },
      }),
    )!;
    const weekly = rank(primary, [quota("lead", 0.5)], tier)[0]!.verdict;
    const short = rank(primary, [quota("lead", 0.59, { seconds: 3600 })], tier)[0]!.verdict;
    expect(weekly.kind).toBe("exhausted");
    expect(short.kind).toBe("fresh_headroom");
  });

  it("never applies to an auxiliary or an untiered account", () => {
    const registry = [row("spare", "auxiliary"), row("plain")];
    const ranked = rank(registry, [quota("spare", 0.97), quota("plain", 0.97)], TIER);
    expect(ranked.map((c) => c.verdict.kind)).toEqual(["fresh_headroom", "fresh_headroom"]);
  });

  it("states a provider-spent primary window as the provider's, not the reserve", () => {
    expect(verdictAt(1)).toMatchObject({ kind: "exhausted", basis: "provider_window" });
  });
});

describe("stale and unknown quota", () => {
  it("ranks after every account with known room, primary included", () => {
    const registry = [row("lead", "primary"), row("spare", "auxiliary"), row("plain")];
    const ranked = rank(registry, [quota("lead", 0.3)], TIER);
    expect(ids(ranked)).toEqual(["lead", "spare", "plain"]);
    expect(ranked.map((c) => c.verdict.kind)).toEqual(["fresh_headroom", "unknown", "unknown"]);
  });

  it("is never room on a primary account: unknown usage does not select it", () => {
    const registry = [row("lead", "primary")];
    for (const snapshots of [
      [],
      [quota("lead", null)],
      [quota("lead", 0.1, { freshness: "stale" })],
      // A window whose reset instant has passed describes a period that ended.
      [quota("lead", 0.1, { resetsAt: at(-HOUR) })],
    ]) {
      const selection = selectFromAccountPool({
        registry,
        harnessId: "claude",
        snapshots,
        readyProfileIds: ready(registry),
        headroomThreshold: 1,
        model: null,
        tier: TIER,
      });
      expect(selection.outcome).toBe("exhausted");
      expect(rank(registry, snapshots, TIER)[0]!.verdict).toMatchObject({ quota_unknown: true });
    }
  });

  it("still serves an auxiliary account whose quota is unknown, after known ones", () => {
    const registry = [row("a", "auxiliary"), row("b", "auxiliary")];
    expect(ids(rank(registry, [quota("b", 0.99)], TIER))).toEqual(["b", "a"]);
  });
});

describe("account resolution keeps pins and thread bindings", () => {
  const registry = [row("lead", "primary"), row("spare", "auxiliary")];
  const roomy = [quota("lead", 0.4), quota("spare", 0.1)];

  it("a strict pin wins over the tier order", async () => {
    const chosen = await resolveAccountForRun(
      ctx({ registry, snapshots: roomy, tier: TIER, pinnedProfile: registry[0]! }),
    );
    expect(chosen?.profile_id).toBe("lead");
  });

  it("a pinned primary account at its reserve refuses typed and never rotates", async () => {
    const snapshots = [quota("lead", 0.9, { resetsAt: at(9 * HOUR) }), quota("spare", 0.1)];
    const context = ctx({ registry, snapshots, tier: TIER, pinnedProfile: registry[0]! });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "subscription_window_exhausted",
      category: "harness_unavailable",
      resetsAt: at(9 * HOUR),
      quotaRefusal: { basis: "owner_reserve", constraintId: "weekly", threshold: 0.85 },
    });
    expect(context.events.map((e) => e.type)).toEqual(["route.profile.headroom_exceeded"]);
  });

  it("the same pin is served when the run states no complexity", async () => {
    const snapshots = [quota("lead", 0.9), quota("spare", 0.1)];
    const chosen = await resolveAccountForRun(
      ctx({ registry, snapshots, pinnedProfile: registry[0]! }),
    );
    expect(chosen?.profile_id).toBe("lead");
  });

  it("a pinned primary account with unknown quota refuses typed", async () => {
    await expect(
      resolveAccountForRun(
        ctx({ registry, snapshots: [], tier: TIER, pinnedProfile: registry[0]! }),
      ),
    ).rejects.toMatchObject({ code: "primary_quota_unknown", category: "harness_unavailable" });
  });

  it("a thread stays on its bound primary account while it is below the reserve", async () => {
    const context = ctx({ registry, snapshots: roomy, tier: TIER, boundProfileId: "lead" });
    expect((await resolveAccountForRun(context))?.profile_id).toBe("lead");
    expect(context.events).toEqual([]);
  });

  it("a bound primary account at its reserve moves with a disclosed lane switch", async () => {
    const snapshots = [quota("lead", 0.86), quota("spare", 0.1)];
    const context = ctx({
      registry,
      snapshots,
      tier: TIER,
      boundProfileId: "lead",
      threadId: "thr_1",
    });
    expect((await resolveAccountForRun(context))?.profile_id).toBe("spare");
    expect(context.events.map((e) => e.type)).toEqual([
      "route.account.lane_switch",
      "route.account.pool_selected",
    ]);
    expect(context.events[0]!.payload).toMatchObject({
      from_profile_id: "lead",
      to_profile_id: "spare",
    });
    expect(String(context.events[0]!.payload["reason"])).toContain("saved quota reserve reached");
    expect(context.events[1]!.payload).toMatchObject({ profile_id: "spare", tier: "auxiliary" });
  });

  it("never falls through to a reserved primary account: the pool refuses typed", async () => {
    const snapshots = [
      quota("lead", 0.9, { resetsAt: at(30 * HOUR) }),
      quota("spare", 1, { resetsAt: at(3 * HOUR) }),
    ];
    const context = ctx({ registry, snapshots, tier: TIER });
    await expect(resolveAccountForRun(context)).rejects.toMatchObject({
      code: "credential_pool_exhausted",
      category: "harness_unavailable",
      resetsAt: at(3 * HOUR),
    });
    expect(context.events.at(-1)?.type).toBe("route.account.pool_exhausted");
  });
});

describe("complexity route table", () => {
  const table = ComplexityRouteTable.parse({
    easy: [
      { harness: "claude", model: "small" },
      { harness: "grok", model: "g", effort: "medium" },
    ],
  });

  it("turns the level into the pool, each candidate's model and its effort", () => {
    expect(resolveComplexityPool({ complexity: "easy" }, table)).toMatchObject({
      harnesses: ["claude", "grok"],
      models: { claude: "small", grok: "g" },
      efforts: { grok: "medium" },
    });
  });

  it("narrows to requested harnesses and accepts a restated identical model", () => {
    const pool = resolveComplexityPool(
      { complexity: "easy", harnesses: ["grok"], models: { grok: "g" } },
      table,
    );
    expect(pool?.harnesses).toEqual(["grok"]);
  });

  it("refuses an unconfigured level, a scalar model and a contradicting model", () => {
    expect(() => resolveComplexityPool({ complexity: "hard" }, table)).toThrow(
      /no route candidates/,
    );
    expect(() => resolveComplexityPool({ complexity: "easy", model: "x" }, table)).toThrow(
      /scalar/,
    );
    expect(() =>
      resolveComplexityPool({ complexity: "easy", models: { claude: "big" } }, table),
    ).toThrow(/names big/);
    expect(() =>
      resolveComplexityPool({ complexity: "easy", harnesses: ["codex"] }, table),
    ).toThrow(/no candidate among/);
  });

  it("refuses a level that lists one harness twice", () => {
    const parsed = ComplexityRouteTable.safeParse({
      hard: [
        { harness: "codex", model: "a" },
        { harness: "codex", model: "b" },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The whole decision as the route resolver makes it: each table candidate's
 * account is resolved by the ordinary owner under the tiers, the admitted
 * lanes are ordered across harnesses, and nothing qualifying is one refusal.
 */
describe("one table over Claude, two Codex accounts and Grok", () => {
  const routes: ComplexityRoute[] = [
    { harness: "claude", model: "claude-mid" },
    { harness: "grok", model: "grok-mid", effort: "xhigh" },
    { harness: "codex", model: "codex-mid", effort: "medium" },
  ];
  const registry = [
    row("lead", "primary", "claude"),
    row("spare", "auxiliary", "claude"),
    row("cx1", "auxiliary", "codex"),
    row("cx2", "auxiliary", "codex"),
    row("gk", "auxiliary", "grok"),
  ];

  async function decide(snapshots: QuotaSnapshot[]) {
    const trace = new ComplexityTrace("medium", routes, registry, TIER, () => snapshots);
    const lanes: ComplexityLane[] = [];
    for (const route of routes) {
      try {
        const profile = await resolveAccountForRun(
          ctx({ harnessId: route.harness, registry, snapshots, tier: TIER, model: route.model }),
        );
        lanes.push({ harnessId: route.harness, profile, model: route.model, headroomThreshold: 1 });
      } catch (error) {
        trace.accountRefused(route.harness, error);
      }
    }
    const ordered = trace.order(lanes);
    return { trace, ordered, decision: trace.decision(ordered) };
  }

  const grokReset = at(10 * HOUR);
  const codexReset = at(4 * HOUR);
  /** Grok's allowance period and both Codex windows are spent. */
  const spent = [
    quota("gk", 1, { harness: "grok", resetsAt: grokReset, seconds: 30 * 24 * 3600 }),
    quota("cx1", 1, { harness: "codex", resetsAt: codexReset }),
    quota("cx2", 1, { harness: "codex", resetsAt: at(6 * HOUR) }),
    quota("spare", 0.3, { resetsAt: at(60 * HOUR) }),
    quota("lead", 0.2),
  ];

  it("falls to the next available Claude candidate while Grok and both Codex are spent", async () => {
    const { ordered, decision } = await decide(spent);
    expect(ordered.map((lane) => [lane.harnessId, lane.profile?.profile_id])).toEqual([
      ["claude", "spare"],
    ]);
    expect(decision.selected).toBe("claude");
    expect(decision.candidates.map((c) => [c.harness_id, c.blocked_by, c.resets_at])).toEqual([
      ["claude", null, at(60 * HOUR)],
      ["grok", "account_exhausted", grokReset],
      ["codex", "account_exhausted", codexReset],
    ]);
    // Every account of a blocked candidate is named with its own cause.
    expect(decision.candidates[2]!.accounts).toEqual([
      {
        profile_id: "cx1",
        tier: "auxiliary",
        blocked_by: "account_exhausted",
        resets_at: codexReset,
      },
      {
        profile_id: "cx2",
        tier: "auxiliary",
        blocked_by: "account_exhausted",
        resets_at: at(6 * HOUR),
      },
    ]);
  });

  it("chooses them again by the normal tier order once their windows reset", async () => {
    // Nothing is reconfigured and no evidence is replaced: the clock passes the
    // first Codex reset, and that account's spent window stops describing it.
    vi.setSystemTime(Date.parse(codexReset) + 1);
    const afterCodex = await decide(spent);
    expect(afterCodex.ordered.map((lane) => [lane.harnessId, lane.profile?.profile_id])).toEqual([
      // Known room first (the auxiliary Claude account), then the reopened
      // Codex account, whose usage is unknown until its next reading.
      ["claude", "spare"],
      ["codex", "cx1"],
    ]);

    // The next readings arrive: all three are auxiliary accounts with room, so
    // the soonest limiting reset decides across harnesses.
    vi.setSystemTime(Date.parse(grokReset) + 1);
    const fresh = (id: string, used: number, harness: string, resetHours: number) => ({
      ...quota(id, used, { harness, resetsAt: at(resetHours * HOUR) }),
      observed_at: new Date().toISOString(),
    });
    const refreshed = await decide([
      fresh("gk", 0.05, "grok", 400),
      fresh("cx1", 0.1, "codex", 12),
      fresh("cx2", 0.2, "codex", 50),
      fresh("spare", 0.3, "claude", 60),
      fresh("lead", 0.2, "claude", 60),
    ]);
    expect(refreshed.ordered.map((lane) => [lane.harnessId, lane.profile?.profile_id])).toEqual([
      ["codex", "cx1"],
      ["claude", "spare"],
      ["grok", "gk"],
    ]);
    expect(refreshed.decision.candidates.every((c) => c.blocked_by === null)).toBe(true);
  });

  it("refuses typed, naming what blocked each candidate, rather than use a reserved account", async () => {
    const { trace, ordered } = await decide([
      ...spent.filter((s) => s.subject.harness !== "claude"),
      quota("spare", 1, { resetsAt: at(60 * HOUR) }),
      quota("lead", 0.9, { resetsAt: at(70 * HOUR) }),
    ]);
    expect(ordered).toEqual([]);
    const refusal = trace.refusal(new Error("no harness remains eligible"));
    expect(refusal).toMatchObject({
      code: COMPLEXITY_ROUTE_REFUSED,
      category: "harness_unavailable",
      resetsAt: codexReset,
    });
    expect(refusal.message).toContain("lead: owner_reserve");
    expect(refusal.complexityDecision.selected).toBeNull();
    expect(
      refusal.complexityDecision.candidates.map((c) => [
        c.harness_id,
        c.blocked_by,
        c.accounts.map((a) => `${a.profile_id}:${a.blocked_by}`),
      ]),
    ).toEqual([
      ["claude", "account_exhausted", ["lead:owner_reserve", "spare:account_exhausted"]],
      ["grok", "account_exhausted", ["gk:account_exhausted"]],
      ["codex", "account_exhausted", ["cx1:account_exhausted", "cx2:account_exhausted"]],
    ]);
  });

  it("treats a typed refusal dated to the allowance period like a spent window", async () => {
    // The shape the registry keeps for a vendor refusal: a cooldown, no usage.
    const refused = quota("gk", null, {
      harness: "grok",
      window: "cooldown:usage_period",
      seconds: null,
      resetsAt: grokReset,
      cooldownUntil: grokReset,
    });
    const blocked = await decide([refused]);
    expect(blocked.decision.candidates[1]).toMatchObject({
      harness_id: "grok",
      blocked_by: "account_exhausted",
      resets_at: grokReset,
    });
    vi.setSystemTime(Date.parse(grokReset) + 1);
    const reopened = await decide([refused]);
    expect(reopened.decision.candidates[1]).toMatchObject({ profile_id: "gk", blocked_by: null });
  });
});
