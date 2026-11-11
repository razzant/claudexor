import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CredentialProfile,
  DecisionRecord,
  RunProcessingIntent,
  type HarnessEvent,
  type HarnessRunSpec,
} from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { clearCodexEffortCache, createCodexAdapter } from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { Orchestrator, type RunInput } from "./orchestrator.js";
import { retryProcessingIntent } from "./retry-processing-intent.js";

const roots: string[] = [];
afterEach(() => {
  clearCodexEffortCache();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

let cases = 0;
const reset = () => new Date(Date.now() + 3_600_000).toISOString();
type Account = "first" | "second";

/** Two subscription accounts whose own native setting, advertisement and limit
 * change between a run and its Exact Retry (owner decision: inherit initially,
 * then keep). Routing prefers `first`; an exhausted account rotates to `second`. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-exact-retry-"));
  roots.push(root);
  const homes = join(process.env.CLAUDEXOR_CONFIG_DIR!, "exact-retry-homes", `${++cases}`);
  const profiles = (["first", "second"] as const).map((id) => {
    mkdirSync(join(homes, id), { recursive: true });
    return CredentialProfile.parse({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(homes, id),
    });
  });
  writeFileSync(
    join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
    JSON.stringify({
      routing: { paid_fallback: "never" },
      credential_profiles: profiles,
      harnesses: { codex: { profile_policy: { limit_action: "rotate" } } },
    }),
  );
  const state = {
    tiers: { first: ["priority"], second: ["priority"] } as Record<Account, string[]>,
    exhausted: new Set<Account>(),
  };
  const configure = (id: Account, tier: string | undefined) => {
    rmSync(join(homes, id, "config.toml"), { force: true });
    if (tier) writeFileSync(join(homes, id, "config.toml"), `service_tier = "${tier}"\n`);
  };
  const launches: Array<{ args: string[]; spec: HarnessRunSpec }> = [];
  const adapter = createCodexAdapter({
    detectVersion: async () => "codex-cli 0.156.1",
    hasApiKey: () => false,
    codexApiKey: () => {
      throw new Error("subscription must not consult an API fallback");
    },
    resolveProfileSecret: () => {
      throw new Error("subscription must not read API secrets");
    },
    probeLogin: async () => ({ authed: true, method: "chatgpt", probeError: null }),
    probeEfforts: async (_bin, env) =>
      readModelListEfforts([
        {
          id: "account-model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: (state.tiers[env?.CODEX_HOME?.split("/").pop() as Account] ?? []).map(
            (id) => ({ id }),
          ),
        },
      ]),
    runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
      launches.push({ args: options.args, spec: options.spec });
      const account = options.spec.credential_profile?.profile_id as Account;
      const raw = state.exhausted.has(account)
        ? [
            { type: "thread.started", thread_id: `native-${launches.length}` },
            { type: "turn.failed", error: { message: "usage limit reached", resets_at: reset() } },
          ]
        : [
            { type: "thread.started", thread_id: `native-${launches.length}` },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: JSON.stringify({
                  work_report: { state: "completed", required_inputs: [] },
                  output: "Finished",
                }),
              },
            },
            { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } },
          ];
      for (const item of raw) yield* options.parseEvent?.(item, options.spec.session_id) ?? [];
      yield {
        type: "completed",
        session_id: options.spec.session_id,
        ts: new Date().toISOString(),
      };
    },
  });
  const orchestrator = new Orchestrator({
    registry: new Map([["codex", adapter]]),
    reviewers: [],
    quotaSnapshots: () =>
      profiles.map((profile) => ({
        subject: {
          harness: "codex",
          credential_route: "vendor_native" as const,
          subject_id: profile.profile_id,
          plan_label: "pro",
        },
        constraints: [],
        source: "codex_app_server",
        observed_at: new Date().toISOString(),
        freshness: "fresh" as const,
      })),
  });
  const store = new ArtifactStore(root);
  const run = async (extra: Partial<RunInput> = {}) => {
    // Each run probes the accounts afresh, as a new daemon command would.
    clearCodexEffortCache();
    const result = await orchestrator.run({
      repoRoot: root,
      workspaceKind: "directory",
      inPlace: true,
      mode: "agent",
      prompt: "Return a short answer",
      harnesses: ["codex"],
      review: false,
      models: { codex: "account-model" },
      effort: "high",
      authPreference: "subscription",
      paidBudget: { kind: "finite", maxUsd: 0 },
      web: "off",
      ...extra,
    });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    return result;
  };
  /** An Exact Retry of `source`, handed the intent the daemon runner reads. */
  const retry = (source: { runId: string; runDir: string }, extra: Partial<RunInput> = {}) =>
    run({
      retryOf: source.runId,
      processingIntent: retryProcessingIntent(store, source.runDir),
      ...extra,
    });
  const frozen = (runDir: string) =>
    RunProcessingIntent.parse(store.readYaml(join(runDir, "context", "processing_intent.yaml")))
      .harnesses["codex"];
  return { store, state, configure, launches, run, retry, frozen };
}

const fastIntent = { requested: null, submittedNative: "fast", source: "codex.managed_config" };

describe("Exact Retry keeps the speed its source run inherited", () => {
  it.each([
    {
      name: "initial Standard, account changed to Fast",
      initial: undefined,
      changed: "fast",
      tiers: ["priority"],
      native: "default",
      reason: "initial_processing_retained",
    },
    {
      name: "initial Fast, account changed to Standard",
      initial: "fast",
      changed: undefined,
      tiers: ["priority"],
      native: "priority",
      reason: "initial_processing_retained",
    },
    {
      name: "initial Fast, account no longer advertises Fast",
      initial: "fast",
      changed: undefined,
      tiers: [],
      native: "default",
      reason: "initial_processing_unavailable; ordinary_service_requested",
    },
  ])("$name", async ({ initial, changed, tiers, native, reason }) => {
    const { store, state, configure, launches, run, retry, frozen } = fixture();
    configure("first", initial);
    const source = await run();
    expect(launches[0]!.spec.processing).toMatchObject(
      initial
        ? { requested: null, submittedNative: initial, source: "codex.managed_config" }
        : { requested: null, submittedNative: "default" },
    );
    // The routing-time selection is frozen before any attempt.
    expect(frozen(source.runDir)).toEqual(launches[0]!.spec.processing);

    // F4: Codex subscription cash is unobserved, so the decision's total is
    // unknown while the cap-governed part stays an exact 0.
    const decision = DecisionRecord.parse(
      store.readYaml(join(source.runDir, "arbitration", "decision.yaml")),
    );
    expect(decision.budget_summary).toMatchObject({
      spend_usd: null,
      cash_usd: null,
      controllable_cash_usd: 0,
      estimated: true,
    });

    // The account's own setting and advertisement change before the retry.
    configure("first", changed);
    state.tiers.first = tiers;
    // An unadvertised inherited intent falls back like advisory Fast: never a refusal.
    await retry(source);
    const retried = launches.at(-1)!;
    expect(retried.args).toContain(`service_tier="${native}"`);
    expect(retried.spec.processing).toMatchObject({
      requested: null,
      submittedNative: native,
      reason,
      source: "codex.service_tier",
    });
    expect(retried.spec.processing_cost_basis).toMatchObject({
      kind: "included",
      debit: "unobserved",
    });
  });

  it("keeps the original Fast across a retry of a retry that fell back, without telemetry", async () => {
    const { state, configure, launches, run, retry, frozen } = fixture();
    configure("first", "fast");
    const source = await run();
    // The intent is the frozen routing-time record, not the terminal telemetry.
    rmSync(join(source.runDir, "final", "telemetry.yaml"));
    configure("first", undefined);
    state.tiers.first = [];
    const fellBack = await retry(source);
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      submittedNative: "default",
      reason: "initial_processing_unavailable; ordinary_service_requested",
    });
    // The retry records the original it kept, with its provenance, not its fallback.
    expect(frozen(fellBack.runDir)).toMatchObject(fastIntent);
    state.tiers.first = ["priority"];
    const restored = await retry(fellBack);
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      submittedNative: "priority",
      reason: "initial_processing_retained",
    });
    expect(frozen(restored.runDir)).toMatchObject(fastIntent);
  });

  it("keeps a rotated source's original Fast after its next account fell back", async () => {
    const { state, configure, launches, run, retry, frozen } = fixture();
    configure("first", "fast");
    state.tiers.second = [];
    state.exhausted.add("first");
    const source = await run();
    expect(launches.map((launch) => launch.spec.credential_profile?.profile_id)).toEqual([
      "first",
      "second",
    ]);
    expect(launches[1]!.spec.processing).toMatchObject({ submittedNative: "default" });
    expect(frozen(source.runDir)).toMatchObject(fastIntent);
    // Both accounts now advertise Fast while neither is configured for it.
    state.exhausted.clear();
    configure("first", undefined);
    state.tiers.second = ["priority"];
    await retry(source);
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      submittedNative: "priority",
      reason: "initial_processing_retained",
    });
  });

  it("restores the original on an account rotation inside the retry", async () => {
    const { state, configure, launches, run, retry } = fixture();
    configure("first", "fast");
    const source = await run();
    // The retry's routing account can no longer serve Fast and then runs out.
    configure("first", undefined);
    state.tiers.first = [];
    state.exhausted.add("first");
    const before = launches.length;
    await retry(source);
    const tries = launches.slice(before);
    expect(tries.map((launch) => launch.spec.credential_profile?.profile_id)).toEqual([
      "first",
      "second",
    ]);
    expect(tries[0]!.spec.processing).toMatchObject({ submittedNative: "default" });
    expect(tries[1]!.args).toContain('service_tier="priority"');
    expect(tries[1]!.spec.processing).toMatchObject({
      submittedNative: "priority",
      reason: "initial_processing_retained",
    });
  });

  it("serves an original `fast` through the adapter's ordinary Fast id", async () => {
    const { configure, launches, run, retry, frozen } = fixture();
    configure("first", "fast");
    const source = await run();
    // The account now names the other ordinary Fast id; the intent stays the original.
    // `fast` and `priority` are one ordinary Fast, so the account's own setting
    // serves it exactly as an identical spelling would (no catalog gate, no override).
    configure("first", "priority");
    const next = await retry(source);
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      submitted: "fast",
      submittedNative: "priority",
      reason: "native_explicit",
      source: "codex.managed_config",
    });
    expect(frozen(next.runDir)).toMatchObject(fastIntent);
  });

  it("keeps an original `fast` when the account spells ordinary Fast `priority` and advertises nothing", async () => {
    const { state, configure, launches, run, retry, frozen } = fixture();
    configure("first", "fast");
    const source = await run();
    configure("first", "priority");
    state.tiers.first = [];
    const next = await retry(source);
    // The alias is the same ordinary Fast: no silent drop to Standard.
    const spawned = launches.at(-1)!;
    expect(spawned.spec.processing).toMatchObject({
      submitted: "fast",
      submittedNative: "priority",
      reason: "native_explicit",
    });
    expect(spawned.args).toContain('service_tier="priority"');
    expect(frozen(next.runDir)).toMatchObject(fastIntent);
  });

  it("lets a frozen advisory preference outrank the inherited intent", async () => {
    const { configure, launches, run, retry } = fixture();
    configure("first", "fast");
    const source = await run();
    // The account still says Fast; the source's own preference (replayed by
    // Exact Retry from its TaskContract) decides instead.
    await retry(source, { processingPreference: "standard" });
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      requested: "standard",
      submittedNative: "default",
    });
  });

  it("lets a new command choose a new initial intent", async () => {
    const { configure, launches, run } = fixture();
    configure("first", undefined);
    await run();
    configure("first", "fast");
    // No Exact Retry intent: the current account setting is inherited afresh.
    await run();
    expect(launches.at(-1)!.spec.processing).toMatchObject({
      requested: null,
      submittedNative: "fast",
      source: "codex.managed_config",
    });
  });
});
