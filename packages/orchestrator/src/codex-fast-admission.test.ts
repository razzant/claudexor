import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger, rankHarnesses, RoutingPreflightError } from "@claudexor/budget";
import {
  CredentialProfile,
  GlobalConfig,
  HarnessRunSpec,
  type HarnessEvent,
} from "@claudexor/schema";
import { prepareHarnessProcessing } from "@claudexor/core";
import { prepareReviewerRunSpec } from "../../review/src/reviewerPreparation.js";
import {
  canonicalCodexProfileHome,
  clearCodexEffortCache,
  createCodexAdapter,
} from "../../harness-codex/src/index.js";
import { readModelListEfforts } from "../../harness-codex/src/effort-probe.js";
import { applyCodexRunProcessing } from "../../harness-codex/src/processing-session.js";
import { bindProcessingAdmission, reviewerProcessingAdmission } from "./processing-dispatch.js";
import {
  processingCostEvidence,
  prepareReviewerProcessing,
  reviewerProcessingCost,
} from "./processing-routing.js";
import { runModelGovernedRoute } from "./modelGovernance.js";
import type { RunInput } from "./orchestrator.js";

afterEach(() => clearCodexEffortCache());

function profile(id: string, api = false) {
  return CredentialProfile.parse({
    profile_id: id,
    harness_id: "codex",
    display_name: id,
    credential_kind: api ? "api_key" : "config_dir_login",
    ...(api
      ? { secret_ref: "openai:test-api" }
      : { isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, id) }),
  });
}

function fixture() {
  const launches: HarnessRunSpec[] = [];
  const args: string[][] = [];
  const probes: string[] = [];
  let login = true;
  const adapter = createCodexAdapter({
    detectVersion: async () => "codex-cli 0.156.1",
    hasApiKey: () => false,
    codexApiKey: () => {
      throw new Error("API fallback forbidden");
    },
    resolveProfileSecret: () => {
      throw new Error("API secrets forbidden");
    },
    probeLogin: async (_bin, options) => {
      probes.push(options?.codexHome ?? "default");
      return { authed: login, method: login ? "chatgpt" : "logged_out", probeError: null };
    },
    probeEfforts: async (_bin, env) =>
      readModelListEfforts([
        {
          id: "model",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: [{ id: env?.CODEX_HOME?.endsWith("/second") ? "ultrafast" : "priority" }],
        },
      ]),
    runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
      launches.push(options.spec);
      args.push(options.args);
      yield* options.parseEvent?.(
        { type: "thread.started", thread_id: "native" },
        options.spec.session_id,
      ) ?? [];
      yield {
        type: "completed",
        session_id: options.spec.session_id,
        ts: new Date().toISOString(),
      };
    },
  });
  return {
    adapter,
    launches,
    args,
    probes,
    logout: () => {
      login = false;
    },
  };
}

const prepInput = {
  cwd: "/fixture",
  model: "model",
  effort: "high",
  preference: "fast" as const,
  allowPaid: false,
};
const config = GlobalConfig.parse({ routing: { paid_fallback: "never" } });
const budget = { kind: "finite", maxUsd: 0 } as const;

describe("Codex Fast retains existing admission restrictions", () => {
  it.each(["api", "unknown"])(
    "never ranks or reserves the %s route as subscription allowance",
    async (route) => {
      const { adapter } = fixture();
      const prepared = await prepareHarnessProcessing(adapter, {
        ...prepInput,
        ...(route === "api" ? { credentialProfile: profile("api", true) } : {}),
      });
      const cost = processingCostEvidence(prepared, "unknown", [route])!;
      expect(cost.billing).toBe(route === "api" ? "metered" : "unknown");
      const ledger = new BudgetLedger(budget);
      expect(
        rankHarnesses([{ harnessId: "codex", available: true, costEvidence: cost }], {
          goal: "economy",
          paidFallback: "never",
          intent: "explain",
          qualityTiers: {},
          ledger,
        }),
      ).toEqual([]);
      expect(
        ledger.reserve({ taskId: "t", intent: "explain", harnessId: "codex", cost }).denied,
      ).toBe("finite_zero");
    },
  );

  it.each(["ultrafast", "scale", "future-premium"])(
    "keeps explicit %s unknown even on a subscription",
    async (tier) => {
      const { adapter } = fixture();
      const account = profile("explicit");
      mkdirSync(account.isolation_locator!, { recursive: true });
      writeFileSync(join(account.isolation_locator!, "config.toml"), `service_tier = "${tier}"\n`);
      const prepared = await prepareHarnessProcessing(adapter, {
        ...prepInput,
        preference: undefined,
        allowPaid: true,
        credentialProfile: account,
      });
      const cost = processingCostEvidence(prepared, "subscription_entitlement", [tier])!;
      expect(cost.billing).toBe("unknown");
      expect(
        rankHarnesses([{ harnessId: "codex", available: true, costEvidence: cost }], {
          goal: "economy",
          paidFallback: "never",
          intent: "explain",
          qualityTiers: {},
          ledger: new BudgetLedger(budget),
        }),
      ).toEqual([]);
    },
  );

  it.each(["api", "unknown", "second", "rebound"])(
    "reprepares and reprices a changed %s account before dispatch",
    async (next) => {
      const { adapter, launches } = fixture();
      const first = profile("first");
      const prepared = await prepareHarnessProcessing(adapter, {
        ...prepInput,
        credentialProfile: first,
      });
      expect(prepared.receipt.submittedNative).toBe("priority");
      const ledger = new BudgetLedger(budget);
      const lease = ledger.reserve({
        taskId: "t",
        intent: "explain",
        harnessId: "codex",
        cost: processingCostEvidence(prepared, "subscription_entitlement", ["first"]),
      }).lease!;
      const actualProfile =
        next === "unknown"
          ? null
          : next === "rebound"
            ? { ...profile("second"), profile_id: first.profile_id }
            : profile(next, next === "api");
      const spec = HarnessRunSpec.parse({
        session_id: "s",
        intent: "explain",
        prompt: "test",
        cwd: "/fixture",
        model_hint: "model",
        effort_hint: "high",
        credential_profile: actualProfile,
        processing_preference: "fast",
        processing_allow_paid: false,
        processing: prepared.receipt,
        processing_cost_basis: prepared.costBasis,
      });
      bindProcessingAdmission(spec, ledger, lease, "codex", "a01");
      const verify = vi.fn(async () => "passed" as const);
      const consume = async () => {
        for await (const _ of runModelGovernedRoute(
          {
            adapter,
            knownModels: [],
            modelInventory: {
              model_inventory_routes: ["local_session"],
              model_inventory_absence: "advisory",
            },
            authRouteEstimate:
              next === "api" ? "api_key" : next === "unknown" ? null : "local_session",
            quotaAdmission: { profile: actualProfile },
            settings: null,
            paidFallback: "never",
            billingVerificationForProfile: verify,
          },
          spec,
        )) {
          /* consume actual native boundary */
        }
      };
      if (next === "second" || next === "rebound") {
        await consume();
        expect(launches[0]?.processing).toMatchObject({
          requested: "fast",
          submittedNative: "default",
        });
        expect(verify).toHaveBeenCalledWith(actualProfile);
        expect(lease.cost.billing).toBe("subscription_entitlement");
      } else {
        await expect(consume()).rejects.toBeInstanceOf(RoutingPreflightError);
        expect(launches).toEqual([]);
      }
      // Even a carried included receipt cannot keep its old billing on an API route.
      const apiPrepared = applyCodexRunProcessing(
        { ...spec, processing: prepared.receipt, processing_cost_basis: prepared.costBasis },
        { models: {}, defaultModel: "model" },
        null,
        false,
      );
      expect(apiPrepared.processing_cost_basis?.kind).toBe("cash");
      expect(apiPrepared.processing?.submittedNative).toBe("default");
    },
  );

  it("still performs the exact-profile ChatGPT verification before native execution", async () => {
    const f = fixture();
    const account = profile("logged-out");
    const prepared = await prepareHarnessProcessing(f.adapter, {
      ...prepInput,
      credentialProfile: account,
    });
    f.logout();
    const events: HarnessEvent[] = [];
    for await (const event of f.adapter.run(
      HarnessRunSpec.parse({
        session_id: "s",
        intent: "explain",
        prompt: "test",
        cwd: "/fixture",
        model_hint: "model",
        credential_profile: account,
        processing_preference: "fast",
        processing_allow_paid: false,
        processing: prepared.receipt,
        processing_cost_basis: prepared.costBasis,
      }),
    ))
      events.push(event);
    expect(f.probes).toEqual([canonicalCodexProfileHome(account.isolation_locator!)]);
    expect(f.launches).toEqual([]);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("uses the same allowance for reviewer preparation and final native controls", async () => {
    const f = fixture();
    const account = profile("review");
    const reviewers = await prepareReviewerProcessing(
      [
        {
          adapter: f.adapter,
          providerFamily: "openai",
          credentialProfile: account,
          requestedModel: "model",
        },
      ],
      { repoRoot: "/fixture", processingPreference: "fast" } as RunInput,
      config,
      budget,
    );
    const ledger = new BudgetLedger(budget);
    const lease = ledger.reserve({
      taskId: "t",
      intent: "review",
      harnessId: "review-panel",
      cost: reviewerProcessingCost(reviewers),
    }).lease!;
    expect(lease).toBeDefined();
    const prepared = await prepareReviewerRunSpec(
      f.adapter,
      HarnessRunSpec.parse({
        session_id: "review",
        intent: "review",
        prompt: "test",
        cwd: "/fixture",
        model_hint: "model",
        credential_profile: account,
        processing_preference: "fast",
        processing_allow_paid: false,
      }),
    );
    reviewerProcessingAdmission(ledger, lease.lease_id, reviewers, "a01")(0, prepared.spec);
    for await (const _ of f.adapter.review!(prepared.spec)) {
      /* actual reviewer adapter */
    }
    expect(f.args[0]).toContain('service_tier="priority"');
    expect(f.launches[0]?.processing?.observed).toBe("unknown");
  });
});
