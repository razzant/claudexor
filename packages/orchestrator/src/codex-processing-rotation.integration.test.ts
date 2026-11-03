import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialProfile, type HarnessEvent, type HarnessRunSpec } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import { clearCodexEffortCache, createCodexAdapter } from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  clearCodexEffortCache();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

const reset = () => new Date(Date.now() + 3_600_000).toISOString();
let cases = 0;

/** A rotation keeps the first account's speed; the next account's own native
 * Fast setting never speeds the same work up (owner decision, Processing rule). */
describe("Codex account rotation retains the initially chosen speed", () => {
  it.each([
    { firstTier: undefined, secondTier: "fast", expectedNative: "default" },
    { firstTier: "fast", secondTier: undefined, expectedNative: "priority" },
  ])(
    "first=$firstTier second=$secondTier sends $expectedNative after rotation",
    async ({ firstTier, secondTier, expectedNative }) => {
      const root = mkdtempSync(join(tmpdir(), "codex-processing-rotation-"));
      roots.push(root);
      const homes = join(process.env.CLAUDEXOR_CONFIG_DIR!, "rotation-homes", `${++cases}`);
      const profiles = (["first", "second"] as const).map((id) => {
        const home = join(homes, id);
        mkdirSync(home, { recursive: true });
        const tier = id === "first" ? firstTier : secondTier;
        if (tier) writeFileSync(join(home, "config.toml"), `service_tier = "${tier}"\n`);
        return CredentialProfile.parse({
          profile_id: id,
          harness_id: "codex",
          display_name: id,
          credential_kind: "config_dir_login",
          isolation_locator: home,
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
        probeEfforts: async () =>
          readModelListEfforts([
            {
              id: "account-model",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              serviceTiers: [{ id: "ultrafast" }, { id: "priority" }],
            },
          ]),
        runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
          launches.push({ args: options.args, spec: options.spec });
          const first = options.spec.credential_profile?.profile_id === "first";
          const raw = first
            ? [
                { type: "thread.started", thread_id: "native-first" },
                {
                  type: "turn.failed",
                  error: { message: "usage limit reached", resets_at: reset() },
                },
              ]
            : [
                { type: "thread.started", thread_id: "native-second" },
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
      const result = await new Orchestrator({
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
      }).run({
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
      });
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(launches.map((launch) => launch.spec.credential_profile?.profile_id)).toEqual([
        "first",
        "second",
      ]);
      const rotated = launches[1]!;
      expect(rotated.args).toContain(`service_tier="${expectedNative}"`);
      expect(rotated.spec.processing).toMatchObject({
        requested: null,
        submittedNative: expectedNative,
        reason: "initial_processing_retained",
        source: "codex.service_tier",
      });
      expect(rotated.spec.processing_cost_basis).toMatchObject({
        kind: "included",
        debit: "unobserved",
      });
      // The first account's own choice and its provenance stay on its receipt.
      expect(launches[0]!.spec.processing).toMatchObject(
        firstTier
          ? { submittedNative: firstTier, source: "codex.managed_config" }
          : { submittedNative: "default", requested: null },
      );
      const telemetry = new ArtifactStore(root).readYaml<any>(
        join(result.runDir, "final", "telemetry.yaml"),
      );
      expect(telemetry.auth_route.profile_id).toBe("second");
      // The attempt record (projected as attemptExecution) discloses the retention.
      expect(telemetry.attempts[0].processing).toMatchObject({
        requested: null,
        submittedNative: expectedNative,
        reason: "initial_processing_retained",
      });
      const cash = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
        .filter((event) => event.type === "budget.cash")
        .at(-1)?.payload;
      expect(cash).toMatchObject({
        cash_knowledge: "unknown",
        controllable_cash_knowledge: "exact",
      });
    },
  );
});
