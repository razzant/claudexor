import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "@claudexor/core";
import { HarnessUnavailableError } from "@claudexor/core";
import {
  ConformanceReport,
  HarnessManifest,
  CredentialProfile,
  type KnownModelEntry,
  type ProviderFamily,
} from "@claudexor/schema";
import { resolveAutoReviewerPanel, resolveExplicitReviewerPanel } from "./reviewerPanel.js";

/**
 * The reviewer effort gate. `reviewerEfforts` and `reviewerPanel[].effort` are
 * OPEN slugs on the wire (a level only means something per harness+model), so the
 * boundary can only refuse a malformed shape. These pin the layer that judges the
 * LEVEL for a reviewer without a native knob: a word its ladder can place (its
 * own order first, the shared preference order for a word it does not list) is
 * kept; a harness with no effort controls keeps the preference as omitted and
 * discloses it; only a word a real ladder cannot place is refused (explicit
 * panel) or dropped with disclosure (auto panel).
 */
function reviewerAdapter(
  id: string,
  family: ProviderFamily,
  effortLevels: readonly string[],
  extras: {
    modelEffortLevels?: Record<string, { levels: string[]; default: string | null }>;
    knownModels?: string[];
    knownModelEntries?: KnownModelEntry[];
  } = {},
): HarnessAdapter {
  return {
    id,
    async discover() {
      return HarnessManifest.parse({
        id,
        display_name: id,
        kind: "local_cli",
        provider_family: family,
        access_profiles_supported: ["readonly", "workspace_write"],
        // A reviewer reads the candidate evidence itself, as every shipped one declares.
        capabilities: {
          review: true,
          read_files: true,
          effort_levels: [...effortLevels],
          ...(extras.modelEffortLevels ? { model_effort_levels: extras.modelEffortLevels } : {}),
          ...(extras.knownModelEntries
            ? { known_models: extras.knownModelEntries }
            : extras.knownModels
              ? { known_models: extras.knownModels }
              : {}),
        },
      });
    },
    async doctor() {
      return ConformanceReport.parse({ harness_id: id, status: "ok", enabled_intents: ["review"] });
    },
    // eslint-disable-next-line require-yield
    async *run() {
      throw new Error("not used in panel resolution");
    },
  };
}

const deps = (adapters: HarnessAdapter[]) => ({
  cwd: mkdtempSync(join(tmpdir(), "clawdexor-panel-")),
  registry: new Map(adapters.map((a) => [a.id, a])),
  harnessSettings: {},
  authPreferenceFor: () => "auto" as const,
});

describe("reviewer effort gate", () => {
  const claude = () => reviewerAdapter("claude", "anthropic", ["low", "medium", "high", "max"]);
  const cursor = () => reviewerAdapter("cursor", "cursor", ["low", "medium", "high"]);

  it("DROPS-AND-DISCLOSES a legacy reviewerEfforts level the auto reviewer does not advertise", async () => {
    // The per-family `reviewerEfforts` map also rides stored replay surfaces
    // (Exact Retry params, ControlRunAgainDraft.request), and a replay is not
    // distinguishable from a fresh request at this layer — so an unadvertised
    // level is dropped WITH disclosure instead of a typed refusal killing a
    // replay that used to run. The panel still reviews, at the reviewer's
    // default effort; the review artifact no longer records the level as
    // requested (requestedEffort is nulled), so nothing reads as honored.
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      { ...deps([claude()]), onIgnoredSetting: (d) => ignored.push(d) },
      { reviewerEfforts: { anthropic: "banana" } },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBeNull();
    expect(ignored).toEqual([
      expect.stringMatching(
        /reviewer effort dropped:.*does not support requested effort 'banana'.*low, medium, high, max/,
      ),
    ]);
  });

  it("KEEPS a shared-vocabulary level this reviewer's ladder does not list — the route places it", async () => {
    // `ultra` is not on this reviewer's advertised ladder, but the shared
    // preference order places it (above max), so it is a preference the route
    // can resolve downward — no longer dropped to null, which used to make the
    // receipt read as if nothing had been requested (owner decision 2026-10-05).
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      { ...deps([claude()]), onIgnoredSetting: (d) => ignored.push(d) },
      { reviewerEfforts: { anthropic: "ultra" } },
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("ultra");
    expect(ignored).toEqual([]);
  });

  it("the AUTO panel keeps a knob-less reviewer's preference as omitted, disclosed — not nulled", async () => {
    const bare = reviewerAdapter("bare", "cursor", []);
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      { ...deps([bare]), onIgnoredSetting: (d) => ignored.push(d) },
      { reviewerEfforts: { cursor: "high" } },
    );
    expect(specs).toHaveLength(1);
    // The original preference survives into the reviewer spec (and so into the
    // run's receipt as requested=high / omitted) instead of being erased.
    expect(specs[0]?.requestedEffort).toBe("high");
    expect(ignored).toEqual([
      "reviewer effort omitted: reviewer harness 'bare' declares no effort controls; " +
        "the preference 'high' stays in the receipt and no native effort is submitted",
    ]);
    // No sink wired: the panel still resolves.
    expect(
      await resolveAutoReviewerPanel(deps([bare]), { reviewerEfforts: { cursor: "high" } }),
    ).toHaveLength(1);
  });

  it("accepts a legacy reviewer effort the reviewer advertises", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {
      reviewerEfforts: { anthropic: "max" },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("max");
  });

  it("leaves the reviewer effort unset when no override was given", async () => {
    const specs = await resolveAutoReviewerPanel(deps([claude()]), {});
    expect(specs[0]?.requestedEffort).toBeNull();
  });

  it("discloses an unknown model inventory and continues to the next family", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => {
      throw new Error("provider transport failed");
    };
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor, claude()]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.adapter.id).toBe("claude");
    expect(ignored).toEqual([
      expect.stringMatching(/reviewer family 'cursor' skipped: inventory unavailable/),
    ]);
  });

  it("does not turn an empty fail-soft inventory into a model mismatch", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => [];
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual(["reviewer family 'cursor' skipped: inventory unavailable"]);
  });

  it("discloses an automatic model mismatch instead of failing the run", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["high"]);
    cursor.models = async () => [
      { id: "other-model", label: null, context_window: null, routes: null },
    ];
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        harnessSettings: { cursor: { default_model: "grok-4.6" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual([expect.stringMatching(/requested model 'grok-4.6' is unavailable/)]);
  });

  it("refuses an explicit reviewerPanel effort the reviewer does not advertise", async () => {
    // Explicit panel entries are precise owner statements — they keep the
    // HARD typed refusal (only the auto map above dropped to disclosure).
    await expect(
      resolveExplicitReviewerPanel(deps([cursor()]), [{ harness: "cursor", effort: "turbo" }]),
    ).rejects.toThrow(HarnessUnavailableError);
    await expect(
      resolveExplicitReviewerPanel(deps([cursor()]), [{ harness: "cursor", effort: "turbo" }]),
    ).rejects.toThrow(
      /does not support requested effort 'turbo'.*harness-wide advertised ladder.*low, medium, high/,
    );
  });

  it("accepts an explicit reviewerPanel effort the reviewer advertises", async () => {
    const specs = await resolveExplicitReviewerPanel(deps([cursor()]), [
      { harness: "cursor", effort: "high" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedEffort).toBe("high");
  });

  it("keeps the review when the harness declares no effort controls: omitted, disclosed", async () => {
    // This used to refuse the WHOLE explicit panel — a preference the harness
    // simply has no knob for cost the owner the review (owner decision
    // 2026-10-05). The preference now stays in the receipt and nothing is sent.
    const bare = reviewerAdapter("bare", "openai", []);
    const ignored: string[] = [];
    const specs = await resolveExplicitReviewerPanel(
      { ...deps([bare]), onIgnoredSetting: (d) => ignored.push(d) },
      [{ harness: "bare", effort: "high" }],
    );
    expect(specs).toMatchObject([{ requestedEffort: "high" }]);
    expect(ignored).toEqual([expect.stringMatching(/reviewer effort omitted:.*'bare' declares/)]);
    // No new refusal for an unknown word on a knob-less route either: it is
    // omitted like any other, and the disclosure notes it is not a known word.
    ignored.length = 0;
    await expect(
      resolveExplicitReviewerPanel({ ...deps([bare]), onIgnoredSetting: (d) => ignored.push(d) }, [
        { harness: "bare", effort: "turbo" },
      ]),
    ).resolves.toMatchObject([{ requestedEffort: "turbo" }]);
    expect(ignored).toEqual([
      expect.stringContaining("'turbo' is outside the shared preference order (none < minimal"),
    ]);
  });

  it("preserves a known preference for resolution against the final reviewer model", async () => {
    // The union carries `ultra` (a sibling model advertises it); the named
    // reviewer model stops at `high`. The gate must speak for the model that
    // will actually review.
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high", "ultra"], {
        knownModels: ["m-small", "m-big"],
        modelEffortLevels: {
          "m-small": { levels: ["low", "medium", "high"], default: "medium" },
          "m-big": { levels: ["low", "medium", "high", "ultra"], default: "low" },
        },
      });
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-small", effort: "ultra" },
      ]),
    ).resolves.toMatchObject([{ requestedModel: "m-small", requestedEffort: "ultra" }]);
    // The SAME level on the model that advertises it passes.
    const specs = await resolveExplicitReviewerPanel(deps([codexish()]), [
      { harness: "codexish", model: "m-big", effort: "ultra" },
    ]);
    expect(specs[0]?.requestedEffort).toBe("ultra");
  });

  it("falls back to the harness ladder for a model with no recorded ladder: placeable is kept, a typo says so", async () => {
    const codexish = () =>
      reviewerAdapter("codexish", "openai", ["low", "medium", "high"], {
        knownModels: ["m-new"],
      });
    // `ultra` is listed by no ladder here; the shared preference order places it
    // above `high`, so the route can clamp it — the panel keeps the preference
    // instead of refusing the review (this was a refusal before 2026-10-05).
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-new", effort: "ultra" },
      ]),
    ).resolves.toMatchObject([{ requestedModel: "m-new", requestedEffort: "ultra" }]);
    // A word neither order places is still refused, naming the fallback ladder.
    await expect(
      resolveExplicitReviewerPanel(deps([codexish()]), [
        { harness: "codexish", model: "m-new", effort: "ulta" },
      ]),
    ).rejects.toThrow(/harness-wide advertised ladder — no per-model ladder recorded for 'm-new'/);
  });

  it("carries an explicit credential profile through model inventory into the reviewer spec", async () => {
    const profile: CredentialProfile = {
      profile_id: "review-a",
      harness_id: "cursor",
      display_name: "Review A",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-review-a",
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
    let seen: CredentialProfile | null | undefined;
    const adapter = reviewerAdapter("cursor", "cursor", ["low", "high"], {
      knownModels: ["grok-4.6"],
    });
    adapter.models = async (spec) => {
      seen = spec?.credentialProfile;
      return [{ id: "grok-4.6", label: null, context_window: null, routes: null }];
    };
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async () => profile,
      },
      [{ harness: "cursor", model: "grok-4.6", credentialProfileId: "review-a" }],
    );
    expect(seen?.profile_id).toBe("review-a");
    expect(specs[0]?.credentialProfile?.profile_id).toBe("review-a");
  });

  it("continues the canonical pool when an unpinned selected profile lacks the model", async () => {
    const first: CredentialProfile = {
      profile_id: "review-first",
      harness_id: "cursor",
      display_name: "Review first",
      credential_kind: "config_dir_login",
      isolation_locator: "/tmp/cursor-review-first",
      secret_ref: null,
      enabled: true,
      created_at: null,
    };
    const second: CredentialProfile = {
      ...first,
      profile_id: "review-second",
      display_name: "Review second",
      isolation_locator: "/tmp/cursor-review-second",
    };
    const adapter = reviewerAdapter("cursor", "cursor", ["low"], {
      knownModels: ["target-model"],
    });
    const inventoryCalls: string[] = [];
    adapter.models = async (spec) => {
      const id = spec?.credentialProfile?.profile_id ?? "default";
      inventoryCalls.push(id);
      return id === first.profile_id
        ? [{ id: "other-model", label: null, context_window: null, routes: null }]
        : [{ id: "target-model", label: null, context_window: null, routes: null }];
    };
    const resolverCalls: ReadonlySet<string>[] = [];
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async (input) => {
          resolverCalls.push(input.excludedProfileIds ?? new Set());
          return input.excludedProfileIds?.has(first.profile_id) ? second : first;
        },
      },
      [{ harness: "cursor", model: "target-model" }],
    );
    expect(specs[0]?.credentialProfile?.profile_id).toBe(second.profile_id);
    expect(specs[0]?.profilePinned).toBe(false);
    expect(inventoryCalls).toEqual([first.profile_id, second.profile_id]);
    expect([...(resolverCalls[1] ?? [])]).toEqual([first.profile_id]);
  });

  it("uses the local-session manifest route for OAuth profiles", async () => {
    const oauth: CredentialProfile = {
      profile_id: "claude-oauth",
      harness_id: "claude",
      display_name: "Claude OAuth",
      credential_kind: "oauth_token",
      isolation_locator: "/tmp/claude-oauth",
      secret_ref: "claude:oauth",
      enabled: true,
      created_at: null,
    };
    const adapter = reviewerAdapter("claude", "anthropic", ["high"], {
      knownModelEntries: [{ id: "subscription-model", routes: ["local_session"] }],
    });
    const specs = await resolveExplicitReviewerPanel(
      {
        ...deps([adapter]),
        resolveReviewerProfile: async () => oauth,
      },
      [{ harness: "claude", model: "subscription-model" }],
    );
    expect(specs[0]?.credentialProfile?.credential_kind).toBe("oauth_token");
  });

  it("fails an explicit pin loudly and discloses an unavailable auto family", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    const error = new HarnessUnavailableError("profile unavailable");
    await expect(
      resolveExplicitReviewerPanel(
        { ...deps([cursor]), resolveReviewerProfile: async () => Promise.reject(error) },
        [{ harness: "cursor", credentialProfileId: "missing" }],
      ),
    ).rejects.toBe(error);
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([cursor]),
        resolveReviewerProfile: async () => Promise.reject(error),
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual(["reviewer family 'cursor' skipped: profile unavailable"]);
  });

  it("does not silently drop an explicit pin when the account-pool owner is not wired", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    await expect(
      resolveExplicitReviewerPanel(deps([cursor]), [
        { harness: "cursor", credentialProfileId: "missing" },
      ]),
    ).rejects.toThrow(/account-pool owner is unavailable/);
  });

  it("refuses an explicit pin when the account-pool owner returns no identity", async () => {
    const cursor = reviewerAdapter("cursor", "cursor", ["low"]);
    await expect(
      resolveExplicitReviewerPanel(
        { ...deps([cursor]), resolveReviewerProfile: async () => null },
        [{ harness: "cursor", credentialProfileId: "missing" }],
      ),
    ).rejects.toThrow(/could not be resolved/);
  });
});

/**
 * The reviewer half of the advisory-inventory decision (INV-104). The explicit
 * panel's LIVE path used to make its own judgement — a set membership test and
 * an empty-inventory throw — so a stale bundled list refused an owner-chosen
 * reviewer model before a single token was spent. It now asks the same shared
 * question the run gate asks: can this list prove the model is absent?
 */
describe("reviewer panel with an advisory live inventory", () => {
  const STALE = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"];

  const nativeProfile = (id: string): CredentialProfile =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: `/profiles/${id}`,
    });

  /** A codex-shaped reviewer: a live producer scoped to the native route, and a
   * manifest that deliberately does NOT list the requested model — so only the
   * live branch can admit it, and a manifest substitution would fail loudly. */
  const liveAdapter = async (
    absence: "authoritative" | "advisory",
    list: readonly string[],
    calls: string[] = [],
  ): Promise<HarnessAdapter> => {
    const adapter = reviewerAdapter("codex", "openai", ["low", "high", "xhigh"], {
      knownModels: ["manifest-only-model"],
    });
    const manifest = await adapter.discover();
    manifest.capabilities.model_inventory_routes = ["local_session"];
    manifest.capabilities.model_inventory_absence = absence;
    adapter.discover = async () => manifest;
    adapter.models = async (spec) => {
      calls.push(spec?.credentialProfile?.profile_id ?? "default");
      return list.map((id) => ({ id, label: null, context_window: null, routes: null }));
    };
    return adapter;
  };

  /** The native account that makes the review route `local_session`, which is
   * what sends the panel down the live-inventory branch at all. It honors
   * exclusions like the real pool owner: a stub that kept handing back the same
   * account would spin the panel's re-selection loop forever instead of failing
   * when one of these guards is removed. */
  const panelDeps = (adapter: HarnessAdapter, profile = nativeProfile("first")) => ({
    ...deps([adapter]),
    resolveReviewerProfile: async (input: { excludedProfileIds?: ReadonlySet<string> }) =>
      input.excludedProfileIds?.has(profile.profile_id) ? null : profile,
  });

  it("resolves an explicit reviewer the stale list lacks, instead of refusing it", async () => {
    const calls: string[] = [];
    const specs = await resolveExplicitReviewerPanel(
      panelDeps(await liveAdapter("advisory", STALE, calls)),
      [{ harness: "codex", model: "gpt-6-astra", effort: "xhigh" }],
    );
    expect(calls).toEqual(["first"]); // the LIVE branch really ran
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedModel).toBe("gpt-6-astra");
    expect(specs[0]?.requestedEffort).toBe("xhigh");
  });

  it("resolves it on an EMPTY live answer too, and asks the source only once", async () => {
    const calls: string[] = [];
    const specs = await resolveExplicitReviewerPanel(
      panelDeps(await liveAdapter("advisory", [], calls)),
      [{ harness: "codex", model: "gpt-6-astra" }],
    );
    expect(specs).toHaveLength(1);
    // No second probe: the same source cannot answer a question it has already
    // shown it cannot answer, and the retry would hit the same cache entry.
    expect(calls).toEqual(["first"]);
  });

  it("an AUTHORITATIVE reviewer still refuses both cases with today's exact text", async () => {
    await expect(
      resolveExplicitReviewerPanel(panelDeps(await liveAdapter("authoritative", STALE)), [
        { harness: "codex", model: "gpt-6-astra", credentialProfileId: "first" },
      ]),
    ).rejects.toThrow(
      "reviewer harness 'codex' does not support requested model 'gpt-6-astra' on the review " +
        "route (available: gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.2); " +
        "run `claudexor models --harness codex`",
    );
    await expect(
      resolveExplicitReviewerPanel(panelDeps(await liveAdapter("authoritative", [])), [
        { harness: "codex", model: "gpt-6-astra", credentialProfileId: "first" },
      ]),
    ).rejects.toThrow(
      "reviewer harness 'codex' could not verify requested model 'gpt-6-astra' because its " +
        "model inventory call failed after retry: model inventory was empty; " +
        "run `claudexor models --harness codex`",
    );
  });

  it("keeps an inventory call FAILURE a failure: a thrown producer is not an answer", async () => {
    const adapter = await liveAdapter("advisory", STALE);
    adapter.models = async () => {
      throw new Error("transport exploded");
    };
    await expect(
      resolveExplicitReviewerPanel(panelDeps(adapter), [
        { harness: "codex", model: "gpt-6-astra" },
      ]),
    ).rejects.toThrow(/model inventory call failed after retry: transport exploded/);
  });

  it("never re-selects another account for a PINNED entry (INV-135 pins do not rotate)", async () => {
    const resolved: (string | null)[] = [];
    const pinnedDeps = {
      ...deps([await liveAdapter("authoritative", STALE)]),
      resolveReviewerProfile: async (input: { credentialProfileId: string | null }) => {
        resolved.push(input.credentialProfileId);
        return nativeProfile("pinned");
      },
    };
    await expect(
      resolveExplicitReviewerPanel(pinnedDeps, [
        { harness: "codex", model: "gpt-6-astra", credentialProfileId: "pinned" },
      ]),
    ).rejects.toThrow(/does not support requested model 'gpt-6-astra'/);
    expect(resolved).toEqual(["pinned"]);
  });

  it("an advisory miss forwards on the selected account, without walking the pool", async () => {
    const calls: string[] = [];
    const resolverCalls: number[] = [];
    const rotatingDeps = {
      ...deps([await liveAdapter("advisory", STALE, calls)]),
      resolveReviewerProfile: async (input: { excludedProfileIds?: ReadonlySet<string> }) => {
        resolverCalls.push(input.excludedProfileIds?.size ?? 0);
        return input.excludedProfileIds?.has("first") ? null : nativeProfile("first");
      },
    };
    const specs = await resolveExplicitReviewerPanel(rotatingDeps, [
      { harness: "codex", model: "gpt-6-astra" },
    ]);
    expect(specs[0]?.credentialProfile?.profile_id).toBe("first");
    // One account asked once: forwarding IS the decision, so there is nothing
    // to rotate away from. (An authoritative miss still excludes and retries —
    // "continues the canonical pool when an unpinned selected profile lacks the
    // model" above pins that path.)
    expect(calls).toEqual(["first"]);
    expect(resolverCalls).toEqual([0]);
  });

  it("leaves the AUTO panel's skip-at-zero-cost behaviour untouched", async () => {
    // Auto selection is a suggestion, not an owner statement, so it keeps its
    // own contract: a family whose inventory does not carry the model is
    // skipped for $0 (after the pool is walked) rather than spawned on a guess.
    // The owner decision was "do not refuse an EXPLICIT request", not "spawn
    // every auto family".
    const ignored: string[] = [];
    const autoDeps = (adapter: HarnessAdapter) => ({
      ...deps([adapter]),
      resolveReviewerProfile: async (input: { excludedProfileIds?: ReadonlySet<string> }) =>
        input.excludedProfileIds?.size ? null : nativeProfile("first"),
      onIgnoredSetting: (detail: string) => ignored.push(detail),
    });
    const specs = await resolveAutoReviewerPanel(autoDeps(await liveAdapter("advisory", STALE)), {
      reviewerModels: { openai: "gpt-6-astra" },
    });
    expect(specs).toEqual([]);
    expect(ignored).toEqual([
      expect.stringContaining("requested model 'gpt-6-astra' is unavailable"),
    ]);
    ignored.length = 0;
    const empty = await resolveAutoReviewerPanel(autoDeps(await liveAdapter("advisory", [])), {
      reviewerModels: { openai: "gpt-6-astra" },
    });
    expect(empty).toEqual([]);
    expect(ignored).toEqual([expect.stringContaining("inventory unavailable")]);
  });
});

describe("reviewer inventory route applicability", () => {
  it("resolves both API-key panels from manifest while a failed native inventory stays unavailable", async () => {
    const adapter = reviewerAdapter("generic", "openai", ["high"], { knownModels: ["api-model"] });
    const manifest = await adapter.discover();
    manifest.capabilities.model_inventory_routes = ["local_session"];
    adapter.discover = async () => manifest;
    const models = vi.fn(async () => []);
    adapter.models = models;
    const profile = CredentialProfile.parse({
      profile_id: "api",
      harness_id: "generic",
      display_name: "API",
      credential_kind: "api_key",
      secret_ref: "openai:api",
    });
    const d = { ...deps([adapter]), resolveReviewerProfile: async () => profile };
    const explicit = await resolveExplicitReviewerPanel(d, [
      { harness: "generic", model: "api-model", credentialProfileId: "api" },
    ]);
    expect(explicit).toHaveLength(1);
    const auto = await resolveAutoReviewerPanel(d, { reviewerModels: { openai: "api-model" } });
    expect(auto).toHaveLength(1);
    // #363: the same account is a pin only when the entry named it.
    expect(explicit[0]?.profilePinned).toBe(true);
    expect(auto[0]?.profilePinned).toBe(false);
    expect(models).not.toHaveBeenCalled();
    const nativeProfile = CredentialProfile.parse({
      ...profile,
      credential_kind: "config_dir_login",
      secret_ref: null,
      isolation_locator: "/profiles/native",
    });
    const nativeDeps = { ...d, resolveReviewerProfile: async () => nativeProfile };
    expect(
      await resolveAutoReviewerPanel(nativeDeps, { reviewerModels: { openai: "api-model" } }),
    ).toEqual([]);
    await expect(
      resolveExplicitReviewerPanel(nativeDeps, [
        { harness: "generic", model: "api-model", credentialProfileId: "api" },
      ]),
    ).rejects.toThrow(/inventory/);
    expect(models.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("reviewer manifest truth under the harness's absence declaration (INV-104)", () => {
  /** A claude-shaped reviewer with NO live producer: the manifest branch is the
   * only truth, and the hint list deliberately lacks the requested model. */
  const manifestAdapter = async (absence?: "advisory" | "authoritative") => {
    const adapter = reviewerAdapter("claude", "anthropic", ["high"], {
      knownModels: ["listed-model"],
    });
    if (absence) {
      const manifest = await adapter.discover();
      manifest.capabilities.model_inventory_absence = absence;
      adapter.discover = async () => manifest;
    }
    return adapter;
  };

  it("an ADVISORY harness's manifest branch forwards an explicit reviewer model its hints lack", async () => {
    const specs = await resolveExplicitReviewerPanel(deps([await manifestAdapter("advisory")]), [
      { harness: "claude", model: "claude-opus-5-5" },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.requestedModel).toBe("claude-opus-5-5");
  });

  it("an AUTHORITATIVE harness's manifest branch (declared or by omission) still refuses with today's exact text", async () => {
    for (const adapter of [await manifestAdapter(), await manifestAdapter("authoritative")]) {
      await expect(
        resolveExplicitReviewerPanel(deps([adapter]), [
          { harness: "claude", model: "claude-opus-5-5" },
        ]),
      ).rejects.toThrow(
        "reviewer harness 'claude' refused requested model 'claude-opus-5-5': " +
          'model "claude-opus-5-5" is not in the harness\'s manifest known-model list ' +
          "(listed-model); run `claudexor models --harness claude`",
      );
    }
  });

  it("the AUTO panel keeps skipping an unlisted family at zero cost, whatever the harness declares", async () => {
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      { ...deps([await manifestAdapter("advisory")]), onIgnoredSetting: (d) => ignored.push(d) },
      { reviewerModels: { anthropic: "claude-opus-5-5" } },
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual([
      expect.stringContaining("requested model 'claude-opus-5-5' is unavailable"),
    ]);
  });
});

it.each(["cursor-grok-4.6-xhigh", "gemini-3.7-flash-high"])(
  "preserves compound route %s; a separate effort beside it is omitted and disclosed, not refused",
  async (slug) => {
    const adapter = reviewerAdapter("compound", "openai", [], { knownModels: [slug] });
    expect(
      await resolveExplicitReviewerPanel(deps([adapter]), [{ harness: "compound", model: slug }]),
    ).toMatchObject([{ requestedModel: slug, requestedEffort: null }]);
    // The harness declares no effort controls, so the preference cannot be
    // applied here; the route id is forwarded exactly as written and the review
    // runs. (Selecting a sibling model variant from the preference is separate,
    // owner-decided follow-up work; this gate never rewrites a model id.)
    const ignored: string[] = [];
    expect(
      await resolveExplicitReviewerPanel(
        { ...deps([adapter]), onIgnoredSetting: (d) => ignored.push(d) },
        [{ harness: "compound", model: slug, effort: "low" }],
      ),
    ).toMatchObject([{ requestedModel: slug, requestedEffort: "low" }]);
    expect(ignored).toEqual([expect.stringContaining("declares no effort controls")]);
  },
);

/** A raw-api-shaped reviewer: authoritative, live on every route, with a TYPED
 * catalog read (#393) and declared routing variants (#145). */
describe("reviewer panels over a typed catalog read", () => {
  type Read = Awaited<ReturnType<NonNullable<HarnessAdapter["modelCatalog"]>>>;
  const typedAdapter = async (read: Read, calls: string[] = []): Promise<HarnessAdapter> => {
    const adapter = reviewerAdapter("openrouter", "unknown", []);
    const manifest = await adapter.discover();
    manifest.capabilities.model_routing_variants = [{ suffix: ":nitro", billing: "service_tier" }];
    manifest.capabilities.model_refused_variants = [
      { suffix: ":online", reason: "provider_web_search" },
    ];
    adapter.discover = async () => manifest;
    adapter.models = async () => (read.status === "listed" ? read.models : []);
    adapter.modelCatalog = async () => {
      calls.push("read");
      return read;
    };
    return adapter;
  };
  const listed = (...ids: string[]): Read => ({
    status: "listed",
    models: ids.map((id) => ({ id, label: null, context_window: null, routes: null })),
  });
  const failed: Read = {
    status: "unavailable",
    failure: { cause: "timeout", httpStatus: null, detail: "no answer within 15s" },
  };

  it("forwards an explicit reviewer model its unavailable read cannot verify, after one retry, and says so (decision A)", async () => {
    const calls: string[] = [];
    const disclosed: string[] = [];
    const specs = await resolveExplicitReviewerPanel(
      { ...deps([await typedAdapter(failed, calls)]), onIgnoredSetting: (d) => disclosed.push(d) },
      [{ harness: "openrouter", model: "vendor/m" }],
    );
    expect(specs[0]?.requestedModel).toBe("vendor/m");
    expect(disclosed).toEqual([
      "reviewer 'openrouter' model 'vendor/m': the live model catalog could not be read " +
        '(timeout; no answer within 15s), so model "vendor/m" could not be verified; it is sent ' +
        "unchanged on the same key and the provider accepts or refuses it",
    ]);
    expect(calls).toEqual(["read", "read"]);
  });

  it("refuses an explicit reviewer model, typed, when the endpoint rejected the key", async () => {
    const rejected: Read = {
      status: "unavailable",
      failure: { cause: "auth_rejected", httpStatus: 401, detail: "invalid key" },
    };
    const resolution = resolveExplicitReviewerPanel(deps([await typedAdapter(rejected)]), [
      { harness: "openrouter", model: "vendor/m" },
    ]);
    await expect(resolution).rejects.toMatchObject({
      code: "model_catalog_unavailable",
      category: "auth",
      retryable: false,
    });
    await expect(resolution).rejects.toThrow(
      "reviewer harness 'openrouter' refused requested model 'vendor/m': the live model catalog " +
        'could not be read (auth_rejected; HTTP 401: invalid key), so model "vendor/m" cannot be ' +
        "verified; the endpoint rejected the API key: replace it or check its access",
    );
  });

  it("refuses an explicit reviewer model absent from a SUCCESSFUL empty catalog without retrying", async () => {
    const calls: string[] = [];
    await expect(
      resolveExplicitReviewerPanel(deps([await typedAdapter(listed(), calls)]), [
        { harness: "openrouter", model: "vendor/m" },
      ]),
    ).rejects.toThrow(
      "reviewer harness 'openrouter' does not support requested model 'vendor/m' on the review route (available: )",
    );
    expect(calls).toEqual(["read"]);
  });

  it("admits a declared routing variant of a listed row and refuses :online", async () => {
    const adapter = await typedAdapter(listed("vendor/m"));
    const specs = await resolveExplicitReviewerPanel(deps([adapter]), [
      { harness: "openrouter", model: "vendor/m:nitro" },
    ]);
    expect(specs[0]?.requestedModel).toBe("vendor/m:nitro");
    for (const refusing of [adapter, await typedAdapter(failed)])
      await expect(
        resolveExplicitReviewerPanel(deps([refusing]), [
          { harness: "openrouter", model: "vendor/m:online" },
        ]),
      ).rejects.toThrow(
        "reviewer harness 'openrouter' refused requested model 'vendor/m:online': model " +
          '"vendor/m:online" carries the :online variant, which this harness refuses',
      );
  });

  it("the AUTO panel skips a family whose read failed, naming the failure, at zero cost", async () => {
    const ignored: string[] = [];
    const specs = await resolveAutoReviewerPanel(
      {
        ...deps([await typedAdapter(failed)]),
        harnessSettings: { openrouter: { default_model: "vendor/m" } },
        onIgnoredSetting: (detail) => ignored.push(detail),
      },
      {},
    );
    expect(specs).toEqual([]);
    expect(ignored).toEqual([
      "reviewer family 'openrouter' skipped: the live model catalog could not be read (timeout; no answer within 15s)",
    ]);
  });
});
