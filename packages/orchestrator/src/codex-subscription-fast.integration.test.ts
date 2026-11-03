import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BudgetLedger } from "@claudexor/budget";
import { CredentialProfile, type HarnessEvent, type HarnessRunSpec } from "@claudexor/schema";
import { ArtifactStore } from "@claudexor/artifact-store";
import {
  canonicalCodexProfileHome,
  clearCodexEffortCache,
  createCodexAdapter,
} from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { Orchestrator } from "./orchestrator.js";

const roots: string[] = [];
afterEach(() => {
  clearCodexEffortCache();
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("ordinary Codex Fast on subscription allowance", () => {
  it.each(
    [
      { tier: "fast", resume: false },
      { tier: "fast", resume: true },
      { tier: "priority", resume: false },
      { tier: "priority", resume: true },
    ].flatMap((input) => [
      { ...input, paidBudget: { kind: "unlimited" as const } },
      { ...input, paidBudget: { kind: "finite" as const, maxUsd: 0 } },
      { ...input, paidBudget: { kind: "finite" as const, maxUsd: 2 } },
    ]),
  )(
    "routes, dispatches and completes $tier with never/$paidBudget.kind $paidBudget.maxUsd, resume=$resume",
    async ({ tier, resume, paidBudget }) => {
      const root = mkdtempSync(join(tmpdir(), "codex-subscription-fast-"));
      roots.push(root);
      const home = join(process.env.CLAUDEXOR_CONFIG_DIR!, "fast-profile");
      mkdirSync(home, { recursive: true });
      const profile = CredentialProfile.parse({
        profile_id: "fast-account",
        harness_id: "codex",
        display_name: "Fast account",
        credential_kind: "config_dir_login",
        isolation_locator: home,
      });
      writeFileSync(
        join(process.env.CLAUDEXOR_CONFIG_DIR!, "config.yaml"),
        JSON.stringify({
          routing: { paid_fallback: "never" },
          credential_profiles: [profile],
        }),
      );
      const probedHomes: Array<string | undefined> = [];
      const launches: Array<{ args: string[]; spec: HarnessRunSpec }> = [];
      const reprice = vi.spyOn(BudgetLedger.prototype, "repriceReservedLease");
      const adapter = createCodexAdapter({
        detectVersion: async () => "codex-cli 0.156.1",
        hasApiKey: () => false,
        codexApiKey: () => {
          throw new Error("subscription must not consult an API fallback");
        },
        resolveProfileSecret: () => {
          throw new Error("subscription must not read API secrets");
        },
        probeLogin: async (_bin, options) => {
          probedHomes.push(options?.codexHome);
          return { authed: true, method: "chatgpt", probeError: null };
        },
        probeEfforts: async () =>
          readModelListEfforts([
            {
              id: "account-model",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              serviceTiers: [{ id: tier }],
            },
          ]),
        runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
          launches.push({ args: options.args, spec: options.spec });
          for (const raw of [
            { type: "thread.started", thread_id: "native-thread" },
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
          ])
            yield* options.parseEvent?.(raw, options.spec.session_id) ?? [];
          yield {
            type: "completed",
            session_id: options.spec.session_id,
            ts: new Date().toISOString(),
          };
        },
      });
      const events: HarnessEvent[] = [];
      const result = await new Orchestrator({
        registry: new Map([["codex", adapter]]),
        reviewers: [],
        quotaSnapshots: () => [
          {
            subject: {
              harness: "codex",
              credential_route: "vendor_native",
              subject_id: profile.profile_id,
              plan_label: "pro",
            },
            constraints: [],
            source: "codex_app_server",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          },
        ],
      }).run({
        repoRoot: root,
        workspaceKind: "directory",
        inPlace: true,
        mode: "agent",
        prompt: "Return a short answer",
        harnesses: ["codex"],
        review: false,
        processingPreference: "fast",
        models: { codex: "account-model" },
        effort: "high",
        authPreference: "subscription",
        paidBudget,
        web: "off",
        ...(resume
          ? {
              resumeSessions: {
                codex: { sessionId: "native-thread", profileId: profile.profile_id },
              },
            }
          : {}),
        onHarnessEvent: (event) => events.push(event),
      });
      // The unobserved allowance debit is separated from the work result.
      expect(result.lifecycle, result.summary).toBe("succeeded");
      expect(result.facts.reason).not.toBe("cost_unverifiable");
      expect(launches).toHaveLength(1);
      expect(launches[0]!.args).toContain(`service_tier="${tier}"`);
      expect(launches[0]!.args.includes("resume")).toBe(resume);
      expect(launches[0]!.args).toContain('model_reasoning_effort="high"');
      expect(launches[0]!.spec).toMatchObject({
        model_hint: "account-model",
        processing_allow_paid: false,
        credential_profile: { profile_id: profile.profile_id },
        processing: {
          requested: "fast",
          submitted: "fast",
          submittedNative: tier,
          observed: "unknown",
          observedNative: [],
        },
        processing_cost_basis: { kind: "included", nativeMode: tier, debit: "unobserved" },
      });
      expect(
        probedHomes.filter((seen) => seen === canonicalCodexProfileHome(home)).length,
      ).toBeGreaterThanOrEqual(3);
      expect(reprice).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ billing: "subscription_entitlement" }),
      );
      const telemetry = new ArtifactStore(root).readYaml<any>(
        join(result.runDir, "final", "telemetry.yaml"),
      );
      expect(telemetry.routing_rationale.entries[0]).toMatchObject({
        billing_knowledge: "subscription_entitlement",
        eligible: true,
      });
      expect(events.find((event) => event.type === "usage")?.usage?.cost_usd).toBeUndefined();
      expect(events.find((event) => event.type === "started")?.processing_cost_basis).toMatchObject(
        { kind: "included", debit: "unobserved" },
      );
      const cash = readFileSync(join(result.runDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
        .filter((event) => event.type === "budget.cash")
        .at(-1)?.payload;
      // Actual cash stays unknown, never inferred exact zero; the cap's part is known.
      expect(cash).toMatchObject({
        cash_spend_usd: 0,
        cash_knowledge: "unknown",
        controllable_cash_knowledge: "exact",
      });
      expect(telemetry.attempts[0].usage_cost.cashKnowledge).toBe("unknown");
      expect(events.find((event) => event.type === "started")?.processing?.observed).toBe(
        "unknown",
      );
    },
  );
});
