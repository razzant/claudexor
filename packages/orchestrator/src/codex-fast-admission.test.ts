import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger, rankHarnesses, RoutingPreflightError } from "@claudexor/budget";
import {
  CredentialProfile,
  GlobalConfig,
  HarnessModel,
  HarnessRunSpec,
  type HarnessEvent,
} from "@claudexor/schema";
import { prepareHarnessProcessing, type HarnessAdapter } from "@claudexor/core";
import { createClaudeAdapter } from "../../harness-claude/src/index.js";
import { createCursorAdapter } from "../../harness-cursor/src/index.js";
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

describe("An Ultrafast request no route offers continues on ordinary service with its reason", () => {
  const governed = (adapter: HarnessAdapter, account: CredentialProfile | null) => ({
    adapter,
    knownModels: [],
    modelInventory: {
      model_inventory_routes: ["local_session" as const],
      model_inventory_absence: "advisory" as const,
    },
    authRouteEstimate: "local_session" as const,
    quotaAdmission: { profile: account },
    settings: null,
    paidFallback: "allowed_within_cap" as const,
  });
  const ultra = (over: Partial<HarnessRunSpec> = {}) =>
    HarnessRunSpec.parse({
      session_id: "s",
      intent: "explain",
      prompt: "test",
      cwd: "/fixture",
      processing_preference: "ultrafast",
      processing_allow_paid: true,
      ...over,
    });
  const drain = async (adapter: HarnessAdapter, spec: HarnessRunSpec) => {
    const events: HarnessEvent[] = [];
    for await (const event of runModelGovernedRoute(
      governed(adapter, spec.credential_profile),
      spec,
    ))
      events.push(event);
    return events;
  };

  it("Codex: no tier on the wire where the account lacks it; the advertising account sends it", async () => {
    const f = fixture();
    await drain(
      f.adapter,
      ultra({ model_hint: "model", effort_hint: "high", credential_profile: profile("first") }),
    );
    expect(f.launches).toHaveLength(1);
    expect(f.args[0]).toContain('service_tier="default"');
    expect(f.args[0].join(" ")).not.toContain("ultrafast");
    expect(f.launches[0]?.processing).toMatchObject({
      requested: "ultrafast",
      submitted: "standard",
      submittedNative: "default",
      reason: "requested_mode_not_advertised; ordinary_service_requested",
    });
    await drain(
      f.adapter,
      ultra({ model_hint: "model", effort_hint: "high", credential_profile: profile("second") }),
    );
    expect(f.args[1]).toContain('service_tier="ultrafast"');
    expect(f.launches[1]?.processing).toMatchObject({
      requested: "ultrafast",
      submitted: "ultrafast",
      submittedNative: "ultrafast",
    });
  });

  it("Claude and Cursor: ordinary launch with the reason; Fast still launches Fast", async () => {
    const launched: { args: string[]; spec: HarnessRunSpec }[] = [];
    const completed = (sessionId: string): HarnessEvent => ({
      type: "completed",
      session_id: sessionId,
      ts: new Date().toISOString(),
    });
    const claude = createClaudeAdapter({
      detectVersion: async () => "2.1.89",
      probeReadonlyProfile: async () => ({ supported: true, missingFlags: [], detail: "ok" }),
      probeAuthStatus: async () => ({
        loggedIn: true,
        authed: true,
        authMethod: "claude.ai",
        probeError: null,
      }),
      anthropicApiKey: () => null,
      claudeOAuthToken: () => null,
      probeEffortLevels: async () => ({ levels: ["high"], live: true }),
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        launched.push({ args: options.args, spec: options.spec });
        yield completed(options.spec.session_id);
      },
    });
    const cursorModels = ["grok-4.7-high", "grok-4.7-high-fast"].map((id) =>
      HarnessModel.parse({ id }),
    );
    const cursor = createCursorAdapter({
      cursorApiKey: () => "fixture-key",
      smokeIsolatedApiKey: async () => ({ ok: true, detail: "fixture" }),
      listCursorModels: async () => cursorModels,
      runCliHarness: async function* (options): AsyncGenerator<HarnessEvent> {
        launched.push({ args: options.args, spec: options.spec });
        yield completed(options.spec.session_id);
      },
    });
    const claudeSpec = ultra({ auth_preference: "subscription" });
    const cursorSpec = ultra({ auth_preference: "api_key", model_hint: "grok-4.7-high" });
    await drain(claude, claudeSpec);
    await drain(cursor, cursorSpec);
    expect(launched).toHaveLength(2);
    expect(launched[0]!.args.join(" ")).toContain('"fastMode":false');
    expect(launched[0]!.spec.processing).toMatchObject({
      requested: "ultrafast",
      submitted: "standard",
      reason: "ultrafast_not_supported; ordinary_service_requested",
    });
    expect(launched[1]!.args[launched[1]!.args.indexOf("--model") + 1]).toBe("grok-4.7-high");
    expect(launched[1]!.spec.processing).toMatchObject({
      requested: "ultrafast",
      submitted: "standard",
      reason: "ultrafast_not_supported; ordinary_variant_selected",
    });
    for (const { args } of launched) expect(args.join(" ")).not.toContain("ultrafast");
    // Paired control: the same routes still launch Fast.
    await drain(claude, { ...claudeSpec, processing_preference: "fast" });
    await drain(cursor, { ...cursorSpec, processing_preference: "fast" });
    expect(launched[2]!.args.join(" ")).toContain('"fastMode":true');
    expect(launched[3]!.args).toContain("grok-4.7-high-fast");
  });

  it("an adapter without processing controls discloses unavailable control and still runs", async () => {
    const launches: HarnessRunSpec[] = [];
    const plain = {
      id: "plain",
      discover: async () => {
        throw new Error("not used");
      },
      doctor: async () => {
        throw new Error("not used");
      },
      async *run(spec: HarnessRunSpec): AsyncIterable<HarnessEvent> {
        launches.push(spec);
        yield { type: "completed", session_id: spec.session_id, ts: new Date().toISOString() };
      },
    } as unknown as HarnessAdapter;
    for (const preference of ["ultrafast", "fast"] as const) {
      const events = await drain(plain, ultra({ processing_preference: preference }));
      expect(events.find((event) => event.type === "status" && event.processing)).toMatchObject({
        processing: {
          requested: preference,
          submitted: null,
          reason: "processing_control_unavailable",
        },
      });
    }
    expect(launches).toHaveLength(2);
  });

  it("reviewer preparation keeps ordinary service with its reason where the account lacks the tier", async () => {
    const f = fixture();
    const review = (account: CredentialProfile) =>
      prepareReviewerRunSpec(
        f.adapter,
        HarnessRunSpec.parse({
          session_id: "review",
          intent: "review",
          prompt: "test",
          cwd: "/fixture",
          model_hint: "model",
          credential_profile: account,
          processing_preference: "ultrafast",
          processing_allow_paid: true,
        }),
      );
    expect((await review(profile("first"))).spec.processing).toMatchObject({
      submittedNative: "default",
      reason: "requested_mode_not_advertised; ordinary_service_requested",
    });
    expect((await review(profile("second"))).spec.processing).toMatchObject({
      submittedNative: "ultrafast",
    });
  });
});
