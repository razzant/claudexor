import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialProfile,
  ModelSubstitutionObservation,
  PreProgressRefusalObservation,
  QuotaSnapshot,
} from "@claudexor/schema";
import { GlobalConfig, REOPENING_UNKNOWN_COOLDOWN_ID } from "@claudexor/schema";
import { rankAccountPool, selectFromAccountPool } from "./account-pool.js";

function row(id: string, overrides: Partial<CredentialProfile> = {}): CredentialProfile {
  return {
    profile_id: id,
    harness_id: "claude",
    display_name: id,
    credential_kind: "config_dir_login",
    isolation_locator: `/tmp/claudexor-test/profiles/claude-${id}`,
    secret_ref: null,
    enabled: true,
    created_at: null,
    ...overrides,
  };
}

function snapshot(
  subjectId: string,
  usedRatio: number,
  options: { freshness?: "fresh" | "stale"; resetsAt?: string | null; model?: string } = {},
): QuotaSnapshot {
  return {
    subject: {
      harness: "claude",
      credential_route: "vendor_native",
      plan_label: null,
      subject_id: subjectId,
    },
    constraints: [
      {
        id: "five_hour",
        label: "5 hour",
        used_ratio: usedRatio,
        window_seconds: 18_000,
        resets_at: options.resetsAt ?? null,
        cooldown_until: null,
        ...(options.model ? { applies_to_models: [options.model] } : {}),
      },
    ],
    source: "claude_oauth_usage",
    observed_at: "2026-08-18T00:00:00Z",
    freshness: options.freshness ?? "fresh",
  } as QuotaSnapshot;
}

// Quota evidence is judged per window at the decision instant (#457): decide at
// the fixtures' own observation time, one minute after it was read.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-08-18T00:01:00Z"));
});
afterEach(() => vi.useRealTimers());

const baseArgs = {
  harnessId: "claude",
  headroomThreshold: 0.9,
  model: null as string | null,
};

describe("account pool ranking (unified model, D-U1 + K.5)", () => {
  it("orders known fresh headroom descending, then unknown, then exhausted", () => {
    const registry = [row("a"), row("b"), row("c"), row("d")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("a", 0.5), // headroom 0.5
        snapshot("b", 0.1), // headroom 0.9 — best known
        snapshot("d", 0.95), // exhausted (>= 0.9 threshold)
        // c: no evidence → unknown
      ],
      readyProfileIds: new Set(["a", "b", "c", "d"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["b", "a", "c", "d"]);
    expect(ranked.map((c) => c.verdict.kind)).toEqual([
      "fresh_headroom",
      "fresh_headroom",
      "unknown",
      "exhausted",
    ]);
  });

  it("ranks a row under an OBSERVED live cooldown exhausted with its release instant (A4)", () => {
    // STALE on purpose: the registry keeps an aged snapshot alive exactly
    // because its cooldown still extends into the future — a reactive
    // vendor-limit cooldown is absolute clock truth, and selecting the row
    // would burn an attempt rediscovering the limit.
    const FUTURE = "2099-01-01T00:00:00.000Z";
    const cooling: QuotaSnapshot = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [
        {
          id: "cooldown",
          label: "Cooldown",
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: FUTURE,
        },
      ],
      source: "claude_api_retry",
      observed_at: "2026-08-17T00:00:00Z",
      freshness: "stale",
    } as QuotaSnapshot;
    const ranked = rankAccountPool({
      ...baseArgs,
      registry: [row("a"), row("b")],
      snapshots: [cooling],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(ranked.map((c) => [c.profile.profile_id, c.verdict.kind])).toEqual([
      ["b", "unknown"],
      ["a", "exhausted"],
    ]);
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("a"), row("b")],
      snapshots: [cooling],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(selection.outcome === "selected" && selection.candidate.profile.profile_id).toBe("b");
  });

  it("never ranks STALE quota as known headroom (D3: stale cannot authorize routing)", () => {
    const registry = [row("fresh-low"), row("stale-high")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("fresh-low", 0.8), // fresh, headroom 0.2
        snapshot("stale-high", 0.0, { freshness: "stale" }), // stale — ignored
      ],
      readyProfileIds: new Set(["fresh-low", "stale-high"]),
    });
    // Known-positive fresh evidence outranks a stale reading even though the
    // stale reading claims a full window.
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["fresh-low", "stale-high"]);
    expect(ranked[1]?.verdict.kind).toBe("unknown");
  });

  it("breaks ties deterministically by profile id", () => {
    const registry = [row("zeta"), row("alpha"), row("mid")];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [],
      readyProfileIds: new Set(["zeta", "alpha", "mid"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("excludes disabled rows, foreign harnesses, api_key rows, and not-ready rows", () => {
    const registry = [
      row("ready"),
      row("disabled", { enabled: false }),
      row("foreign", { harness_id: "codex" }),
      row("paid", {
        credential_kind: "api_key",
        isolation_locator: null,
        secret_ref: "anthropic:paid",
      }),
      row("not-ready"),
    ];
    const ranked = rankAccountPool({
      ...baseArgs,
      registry,
      snapshots: [],
      readyProfileIds: new Set(["ready", "disabled", "foreign", "paid"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["ready"]);
  });

  it("ranks only model-applicable fresh quota for the requested model", () => {
    const registry = [row("scoped"), row("other")];
    const ranked = rankAccountPool({
      ...baseArgs,
      model: "claude-fable-5",
      registry,
      snapshots: [
        snapshot("scoped", 0.2, { model: "claude-fable-5" }),
        snapshot("other", 0.1, { model: "some-other-model" }), // not applicable → unknown
      ],
      readyProfileIds: new Set(["scoped", "other"]),
    });
    expect(ranked.map((c) => c.profile.profile_id)).toEqual(["scoped", "other"]);
    expect(ranked[1]?.verdict.kind).toBe("unknown");
  });
});

describe("model-substitution ordering (INV-135: ordered last, never excluded)", () => {
  const MODEL = "model-a";
  const substituted = (
    profileId: string,
    observedAt: string,
    over: Partial<ModelSubstitutionObservation> = {},
  ): ModelSubstitutionObservation => ({
    harness_id: "claude",
    profile_id: profileId,
    requested_model: MODEL,
    observed_at: observedAt,
    expires_at: "2099-01-01T00:00:00.000Z",
    ...over,
  });
  const pool = (ids: string[], usedRatios: Record<string, number> = {}) => ({
    ...baseArgs,
    model: MODEL,
    registry: ids.map((id) => row(id)),
    snapshots: Object.entries(usedRatios).map(([id, used]) => snapshot(id, used)),
    readyProfileIds: new Set(ids),
  });
  const order = (args: Parameters<typeof rankAccountPool>[0]) =>
    rankAccountPool(args).map((c) => c.profile.profile_id);

  it("ranks a marked row after every other selectable row, whatever its headroom", () => {
    const args = pool(["best", "low", "unknown"], { best: 0.1, low: 0.8 });
    expect(order(args)).toEqual(["best", "low", "unknown"]);
    expect(
      order({ ...args, substitutions: [substituted("best", "2026-09-20T10:00:00.000Z")] }),
    ).toEqual(["low", "unknown", "best"]);
  });

  it("orders a fully marked pool oldest observation first and still selects from it", () => {
    const args = {
      ...pool(["a", "b", "c"], { a: 0.1, b: 0.5 }),
      substitutions: [
        substituted("a", "2026-09-20T10:20:00.000Z"),
        substituted("b", "2026-09-20T10:00:00.000Z"),
        substituted("c", "2026-09-20T10:10:00.000Z"),
      ],
    };
    expect(order(args)).toEqual(["b", "c", "a"]);
    expect(selectFromAccountPool(args)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "b" }, verdict: { kind: "fresh_headroom" } },
    });
  });

  it("a refreshed observation re-orders: the account marked longest ago goes first", () => {
    const args = pool(["a", "b"], { a: 0.1, b: 0.5 });
    const old = substituted("b", "2026-09-20T10:00:00.000Z");
    expect(
      order({ ...args, substitutions: [substituted("a", "2026-09-20T10:05:00.000Z"), old] }),
    ).toEqual(["b", "a"]);
    // b substituted again: its refreshed observation is now the newest.
    expect(
      order({
        ...args,
        substitutions: [
          substituted("a", "2026-09-20T10:05:00.000Z"),
          substituted("b", "2026-09-20T10:06:00.000Z"),
        ],
      }),
    ).toEqual(["a", "b"]);
    // Equal instants fall back to today's order.
    expect(order({ ...args, substitutions: [substituted("a", old.observed_at), old] })).toEqual([
      "a",
      "b",
    ]);
  });

  it("keeps a marked singleton selectable and never makes a pool exhausted", () => {
    const only = {
      ...pool(["only"]),
      substitutions: [substituted("only", "2026-09-20T10:00:00.000Z")],
    };
    expect(selectFromAccountPool(only)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "only" } },
    });
    const spent = {
      ...pool(["marked", "spent"], { spent: 0.99 }),
      substitutions: [
        substituted("marked", "2026-09-20T10:00:00.000Z"),
        substituted("spent", "2026-09-20T09:00:00.000Z"),
      ],
    };
    // An exhausted row keeps its place at the end whatever its mark says.
    expect(order(spent)).toEqual(["marked", "spent"]);
    expect(selectFromAccountPool(spent)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "marked" } },
    });
  });

  it("ignores expired, foreign-harness and other-model observations", () => {
    const args = pool(["a", "b"], { a: 0.1, b: 0.5 });
    const at = "2026-09-20T10:00:00.000Z";
    for (const substitutions of [
      [substituted("a", "2020-01-01T00:00:00.000Z", { expires_at: "2020-01-01T00:30:00.000Z" })],
      [substituted("a", at, { harness_id: "codex" })],
      [substituted("a", at, { requested_model: "model-z" })],
      [],
    ])
      expect(order({ ...args, substitutions })).toEqual(["a", "b"]);
    // No requested model (a catalog read) matches no observation.
    expect(order({ ...args, model: null, substitutions: [substituted("a", at)] })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("pre-progress refusal ordering (#363: demoted for that model, never excluded)", () => {
  const MODEL = "grok-4.7";
  const refused = (
    profileId: string,
    observedAt: string,
    over: Partial<PreProgressRefusalObservation> = {},
  ): PreProgressRefusalObservation => ({
    harness_id: "claude",
    profile_id: profileId,
    requested_model: MODEL,
    observed_at: observedAt,
    expires_at: "2099-01-01T00:00:00.000Z",
    ...over,
  });
  const pool = (ids: string[], usedRatios: Record<string, number> = {}) => ({
    ...baseArgs,
    model: MODEL as string | null,
    registry: ids.map((id) => row(id)),
    snapshots: Object.entries(usedRatios).map(([id, used]) => snapshot(id, used)),
    readyProfileIds: new Set(ids),
  });
  const order = (args: Parameters<typeof rankAccountPool>[0]) =>
    rankAccountPool(args).map((c) => c.profile.profile_id);
  const at = "2026-09-28T19:52:00.000Z";

  it("the no-evidence tie no longer re-picks the refusing row: it ranks after its sibling", () => {
    // Cursor exposes no quota: both rows are `unknown` and the id tie-break
    // alone put `a` first on every unpinned run.
    const args = pool(["a", "b"]);
    expect(order(args)).toEqual(["a", "b"]);
    expect(order({ ...args, refusals: [refused("a", at)] })).toEqual(["b", "a"]);
    expect(selectFromAccountPool({ ...args, refusals: [refused("a", at)] })).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "b" }, verdict: { kind: "unknown" } },
    });
  });

  it("outranks known headroom, but a marked singleton or fully marked pool still selects", () => {
    const args = pool(["best", "unknown"], { best: 0.1 });
    expect(order({ ...args, refusals: [refused("best", at)] })).toEqual(["unknown", "best"]);
    expect(selectFromAccountPool({ ...pool(["only"]), refusals: [refused("only", at)] })).toEqual(
      expect.objectContaining({ outcome: "selected" }),
    );
    // Oldest mark first, so a fully marked pool takes turns.
    expect(
      order({
        ...pool(["a", "b"]),
        refusals: [refused("a", "2026-09-28T19:55:00.000Z"), refused("b", at)],
      }),
    ).toEqual(["b", "a"]);
  });

  it("shares the substitution tier: a row's newest mark of either kind orders it", () => {
    const substituted: ModelSubstitutionObservation = {
      harness_id: "claude",
      profile_id: "a",
      requested_model: MODEL,
      observed_at: "2026-09-28T19:40:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    expect(
      order({
        ...pool(["a", "b", "c"]),
        substitutions: [substituted],
        refusals: [refused("a", "2026-09-28T19:58:00.000Z"), refused("b", at)],
      }),
    ).toEqual(["c", "b", "a"]);
  });

  it("ignores expired, foreign-harness and other-model marks; null is its own model", () => {
    const args = pool(["a", "b"]);
    for (const refusals of [
      [refused("a", "2020-01-01T00:00:00.000Z", { expires_at: "2020-01-01T01:00:00.000Z" })],
      [refused("a", at, { harness_id: "cursor" })],
      [refused("a", at, { requested_model: "auto" })],
      [refused("a", at, { requested_model: null })],
      [],
    ])
      expect(order({ ...args, refusals })).toEqual(["a", "b"]);
    // The harness default model (null) matches only a null-model mark.
    expect(
      order({ ...args, model: null, refusals: [refused("a", at, { requested_model: null })] }),
    ).toEqual(["b", "a"]);
    expect(order({ ...args, model: null, refusals: [refused("a", at)] })).toEqual(["a", "b"]);
  });

  it("never rescues an exhausted row or makes the pool exhausted", () => {
    const args = {
      ...pool(["marked", "spent"], { spent: 0.99 }),
      refusals: [refused("marked", at)],
    };
    expect(order(args)).toEqual(["marked", "spent"]);
    expect(selectFromAccountPool(args)).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "marked" } },
    });
  });
});

describe("account pool selection", () => {
  it.each([
    [0.9, "selected"],
    [0.95, "selected"],
    [0.99, "selected"],
    [1, "exhausted"],
  ] as const)("default policy at %s usage leaves the pool %s", (usedRatio, outcome) => {
    const policy = GlobalConfig.parse({ harnesses: { claude: {} } }).harnesses["claude"]!
      .profile_policy;
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("last-account")],
      snapshots: [snapshot("last-account", usedRatio)],
      readyProfileIds: new Set(["last-account"]),
      headroomThreshold: policy.headroom_threshold,
    });
    expect(selection.outcome).toBe(outcome);
  });

  it("selects the best candidate and never an exhausted row", () => {
    const registry = [row("spent"), row("open")];
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry,
      snapshots: [snapshot("spent", 0.99), snapshot("open", 0.3)],
      readyProfileIds: new Set(["spent", "open"]),
    });
    expect(selection).toMatchObject({
      outcome: "selected",
      candidate: { profile: { profile_id: "open" } },
    });
  });

  it("reports exhaustion with the earliest known reset when every ready row is spent", () => {
    const registry = [row("a"), row("b")];
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("a", 0.95, { resetsAt: "2026-08-18T12:00:00Z" }),
        snapshot("b", 0.99, { resetsAt: "2026-08-18T06:00:00Z" }),
      ],
      readyProfileIds: new Set(["a", "b"]),
    });
    // Both rows stopped below 100% at the saved 90% reserve (#318).
    expect(selection).toEqual({
      outcome: "exhausted",
      resets_at: "2026-08-18T06:00:00Z",
      reserveOnly: true,
    });
    const spent = selectFromAccountPool({
      ...baseArgs,
      registry,
      snapshots: [
        snapshot("a", 0.95, { resetsAt: "2026-08-18T12:00:00Z" }),
        snapshot("b", 1, { resetsAt: "2026-08-18T06:00:00Z" }),
      ],
      readyProfileIds: new Set(["a", "b"]),
    });
    expect(spent).toMatchObject({ outcome: "exhausted", reserveOnly: false });
  });

  it("reports an empty pool when nothing is ready", () => {
    const selection = selectFromAccountPool({
      ...baseArgs,
      registry: [row("cold")],
      snapshots: [],
      readyProfileIds: new Set(),
    });
    expect(selection).toEqual({ outcome: "empty", resets_at: null });
  });

  it("says a row the vendor refused with no reopening time (#558) leaves the spent pool undated", () => {
    const refused = {
      subject: {
        harness: "claude",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      constraints: [
        {
          id: REOPENING_UNKNOWN_COOLDOWN_ID,
          label: "Cooldown",
          used_ratio: null,
          window_seconds: null,
          resets_at: null,
          cooldown_until: "2026-08-18T00:05:00Z",
        },
      ],
      source: "claude_api_retry",
      observed_at: "2026-08-18T00:00:30Z",
      freshness: "fresh",
    } as QuotaSnapshot;
    const dated = snapshot("b", 1, { resetsAt: "2026-08-18T06:00:00Z" });
    const pool = (ids: string[], snapshots: QuotaSnapshot[]) =>
      selectFromAccountPool({
        ...baseArgs,
        registry: ids.map((id) => row(id)),
        snapshots,
        readyProfileIds: new Set(ids),
      });
    expect(pool(["a", "b"], [refused, dated])).toEqual({
      outcome: "exhausted",
      resets_at: null,
      reserveOnly: false,
      reopening: "unknown",
    });
    // Control: a dated window alone keeps its reset and claims no unknown reopening.
    expect(pool(["b"], [dated])).toEqual({
      outcome: "exhausted",
      resets_at: "2026-08-18T06:00:00Z",
      reserveOnly: false,
    });
  });
});

describe("last-served tie-break (INV-135: only among otherwise-equal unknown headroom)", () => {
  const MODEL = "grok-4.7";
  /** Durable last-served facts for one ranking: `served` maps row → service order. */
  const reader = (served: Record<string, number>, forModel = MODEL, forHarness = "claude") => {
    const reads: Array<{ harnessId: string; model: string | null; rows: string[] }> = [];
    return {
      reads,
      orders: (harnessId: string, model: string | null, profiles: readonly CredentialProfile[]) => {
        reads.push({ harnessId, model, rows: profiles.map((p) => p.profile_id) });
        if (harnessId !== forHarness || model !== forModel) return new Map<string, number>();
        return new Map(
          profiles
            .filter((p) => p.profile_id in served)
            .map((p) => [p.profile_id, served[p.profile_id]!]),
        );
      },
    };
  };
  const pool = (ids: string[], usedRatios: Record<string, number> = {}) => ({
    ...baseArgs,
    model: MODEL as string | null,
    registry: ids.map((id) => row(id)),
    snapshots: Object.entries(usedRatios).map(([id, used]) => snapshot(id, used)),
    readyProfileIds: new Set(ids),
  });
  const order = (args: Parameters<typeof rankAccountPool>[0]) =>
    rankAccountPool(args).map((c) => c.profile.profile_id);
  const mark = (profileId: string, observedAt: string): PreProgressRefusalObservation => ({
    harness_id: "claude",
    profile_id: profileId,
    requested_model: MODEL,
    observed_at: observedAt,
    expires_at: "2099-01-01T00:00:00.000Z",
  });

  it("puts the row that last served this model first, then keeps id order; no history = id order", () => {
    expect(order({ ...pool(["a", "b", "c"]), lastService: reader({ b: 7, c: 3 }) })).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(order({ ...pool(["a", "b"]), lastService: reader({}) })).toEqual(["a", "b"]);
    expect(order({ ...pool(["a", "b"]), lastService: null })).toEqual(["a", "b"]);
  });

  it("reads the facts once per ranking, for this harness, requested model and unknown rows only", () => {
    const facts = reader({ b: 1 });
    order({ ...pool(["a", "b", "known"], { known: 0.2 }), lastService: facts });
    expect(facts.reads).toEqual([{ harnessId: "claude", model: MODEL, rows: ["a", "b"] }]);
    // Another model's or harness's service never reorders this ranking.
    expect(order({ ...pool(["a", "b"]), lastService: reader({ b: 1 }, "other-model") })).toEqual([
      "a",
      "b",
    ]);
    expect(order({ ...pool(["a", "b"]), lastService: reader({ b: 1 }, MODEL, "cursor") })).toEqual([
      "a",
      "b",
    ]);
    // A singleton needs no tie-break: nothing to read.
    const single = reader({ only: 1 });
    expect(order({ ...pool(["only"]), lastService: single })).toEqual(["only"]);
    expect(single.reads).toEqual([]);
  });

  it("never outranks known headroom, a mark or exhaustion", () => {
    const facts = reader({ unknown: 9, marked: 9, spent: 9 });
    expect(order({ ...pool(["known", "unknown"], { known: 0.5 }), lastService: facts })).toEqual([
      "known",
      "unknown",
    ]);
    const at = "2026-09-28T19:52:00.000Z";
    const marked = {
      ...pool(["fresh", "marked"]),
      lastService: facts,
      refusals: [mark("marked", at)],
    };
    expect(order(marked)).toEqual(["fresh", "marked"]);
    expect(order({ ...pool(["a", "spent"], { spent: 0.99 }), lastService: facts })).toEqual([
      "a",
      "spent",
    ]);
    // A fully marked pool still selects (oldest mark first), whatever served last.
    expect(
      selectFromAccountPool({
        ...pool(["a", "b"]),
        lastService: reader({ a: 9 }),
        refusals: [mark("a", "2026-09-28T19:55:00.000Z"), mark("b", at)],
      }),
    ).toMatchObject({ outcome: "selected", candidate: { profile: { profile_id: "b" } } });
  });

  it("an expired mark restores the service preference", () => {
    const expired: PreProgressRefusalObservation = {
      ...mark("b", "2020-01-01T00:00:00.000Z"),
      expires_at: "2020-01-01T01:00:00.000Z",
    };
    expect(
      order({ ...pool(["a", "b"]), lastService: reader({ b: 2 }), refusals: [expired] }),
    ).toEqual(["b", "a"]);
  });
});
