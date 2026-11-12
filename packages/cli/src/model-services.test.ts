import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialGeneration,
  CredentialUnusableLedger,
  DaemonClient,
  DaemonServer,
  ModelSubstitutionLedger,
  ModelCapabilityLedger,
  PreProgressRefusalLedger,
  QuotaRegistry,
} from "@claudexor/daemon";
import { createCodexAdapter, createCodexModelAdapter } from "@claudexor/harness-codex";
import {
  ControlGcReceipt,
  ControlProblem,
  CredentialProfile,
  GlobalConfig,
  ModelCallRequest,
  ModelCallResult,
  QuotaAbsence,
  QuotaSnapshot,
  REOPENING_UNKNOWN_COOLDOWN_ID,
  ControlAccountRoutingEvidenceResponse,
  ControlModelOperationDetail,
  isModelOperation,
  type CredentialProfileStatus,
  type ModelCatalogEntry,
  type ModelInventoryAbsence,
} from "@claudexor/schema";
import {
  SharedRead,
  DOCTOR_TTL_MS,
  observeHarnessProgram,
  programObservationPublisher,
  invalidateProgramObservations,
  bindCredentialMutationWindow,
  type HarnessAdapter,
  type ModelAdapter,
} from "@claudexor/core";
import { createCredentialProfilesService } from "./accounts-services.js";
import { updateGlobalConfig } from "@claudexor/config";
import { accountObservations } from "./account-observations.js";

beforeEach(() => accountObservations.invalidate());

import { ModelLoginReadiness } from "./model-login-readiness.js";
import { createModelServices } from "./model-services.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
import { requestBodyText } from "../../harness-codex/src/test-support/request-body.js";

const cleanups: Array<() => Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

function model(id = "test-model"): ModelCatalogEntry {
  return {
    id,
    label: null,
    isDefault: true,
    contextWindow: 272000,
    maxContextWindow: 872000,
    maxOutputTokens: null,
    inputModalities: ["text"],
    reasoningEfforts: ["medium"],
    defaultReasoningEffort: "medium",
    supportedOptions: [],
  };
}

async function fixture(
  options: {
    lazy?: boolean;
    adapter?: ModelAdapter;
    inventoryAbsence?: ModelInventoryAbsence;
    nativeAdapter?: HarnessAdapter;
  } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-ms-")));
  const sql = await sqlFixture(root);
  const commands = sql.graph.commands;
  const quota = new QuotaRegistry(sql.graph.globalEvents);
  const unusable = new CredentialUnusableLedger();
  const clock = { now: Date.now() };
  const substitutions = new ModelSubstitutionLedger(() => new Date(clock.now));
  const capabilities = new ModelCapabilityLedger(unusable.credentials, () => clock.now);
  const refusals = new PreProgressRefusalLedger(
    () => new Date(clock.now),
    () => false,
    unusable.credentials,
  );
  // The model each account's terminal response discloses; absent = the requested one.
  const served: Record<string, string | null> = {};
  // Accounts whose terminal response ran out of room rather than completing.
  const incomplete = new Set<string>();
  const resources = vi.fn(() => sql.graph.resources);
  const profiles = ["a", "b"].map((id) =>
    CredentialProfile.parse({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(root, id),
    }),
  );
  const cfg = GlobalConfig.parse({ credential_profiles: profiles });
  const catalogModels: Record<string, ModelCatalogEntry[]> = { a: [model()], b: [model()] };
  const failures: Record<string, string> = {};
  // The vendor-shaped `context` each account's typed refusal carries. A
  // vendor-named reset by default; a test that means a different vendor fact
  // (an HTTP status, say) declares it per account, as the live producer does.
  const vendorReset = { resetsAt: new Date(Date.now() + 60000).toISOString() };
  const failureContext: Record<string, Record<string, unknown>> = {};
  const probe = vi.fn<(profile: CredentialProfile) => Promise<CredentialProfileStatus>>(
    async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: profile.harness_id,
      availability: "available" as const,
      verification: "passed" as const,
      verification_source: "local_store" as const,
      detail: "test profile ready",
      last_verified_at: null,
    }),
  );
  const catalog = vi.fn<ModelAdapter["catalog"]>(async ({ profile }) => ({
    source: "codex",
    credentialProfileId: profile.profile_id,
    accountFingerprint: profile.profile_id,
    observedAt: new Date().toISOString(),
    sourceProgram: null,
    provenance: "fixture exact catalog",
    clientVersion: "0.156.1",
    clientVersionSource: "verified_transport",
    models: catalogModels[profile.profile_id]!,
  }));
  const invoke = vi.fn<ModelAdapter["invoke"]>(async (request, context) => {
    expect(context.catalog).toMatchObject({
      source: "codex",
      credentialProfileId: context.profile.profile_id,
      accountFingerprint: context.profile.profile_id,
    });
    const route = {
      source: "codex",
      credentialProfileId: context.profile.profile_id,
      accountFingerprint: context.profile.profile_id,
      model: request.model,
    };
    await context.onDispatch(route);
    const code = failures[context.profile.profile_id];
    return ModelCallResult.parse({
      outcome: code
        ? "failed"
        : incomplete.has(context.profile.profile_id)
          ? "incomplete"
          : "completed",
      message: code ? null : { role: "assistant", content: "own model reply" },
      route:
        context.profile.profile_id in served
          ? { ...route, model: served[context.profile.profile_id] }
          : route,
      usage: code ? {} : { input_tokens: 5, output_tokens: 3 },
      cost: {
        knowledge: "unknown",
        billing: "unknown",
        source: "fixture",
        provenance: ["fixture"],
      },
      appliedOptions: {},
      problem: code
        ? {
            code,
            message: "fixture refusal",
            retryable: false,
            context: failureContext[context.profile.profile_id] ?? vendorReset,
          }
        : null,
    });
  });
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\cx-ms-${randomUUID()}` : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const services = createModelServices({
    commands,
    resourceQueries: commands.queries,
    resources,
    client,
    quota: () => quota,
    config: () => cfg,
    unusable,
    substitutions,
    capabilities,
    refusals,
    migrationGate: () => null,
    // These provider/readiness stubs read no native program; program-observation tests own that boundary.
    registry: new Map([
      [
        "codex",
        options.nativeAdapter ?? {
          ...createCodexAdapter(),
          program: undefined,
          probeCredentialProfile: probe,
        },
      ],
    ]),
    sources: [
      {
        adapter: options.adapter ?? {
          id: "codex",
          inventoryAbsence: options.inventoryAbsence,
          catalog,
          invoke,
        },
        label: "Codex",
        credentialHarness: "codex",
      },
    ],
  });
  const agentRunner = vi.fn(async () => ({ lifecycle: "succeeded" }));
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands,
    runner: (params, context) =>
      isModelOperation(params) ? services.operations.execute(params, context) : agentRunner(),
    onCommandTerminal: (record) => services.operations.onCommandTerminal(record),
  });
  if (!options.lazy) await server.start();
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => {
    services.close();
    await server.stop();
    await sql.close();
  });
  const run = async (
    account: ModelCallRequest["account"] = { mode: "auto" },
    changes: Partial<ModelCallRequest> = {},
    captureRoutingEvidence = true,
  ) => {
    const ref = resources().publishModel(
      Buffer.from(
        JSON.stringify(
          ModelCallRequest.parse({
            source: "codex",
            model: "test-model",
            account,
            messages: [{ role: "system", content: "own prompt" }],
            ...changes,
          }),
        ),
      ),
    );
    // A routing-aware host asks for routing evidence; strict legacy shapes are tested separately.
    const started = await services.routes.createModelOperation(
      ref,
      randomUUID(),
      undefined,
      undefined,
      undefined,
      captureRoutingEvidence ? true : undefined,
    );
    // Dispatch waits on the store's durable barrier (one flusher pass, 200 ms cadence);
    // vitest's 1 s default is too tight for that on a contended host.
    await vi.waitFor(
      async () =>
        expect(["queued", "running"]).not.toContain(
          (await services.routes.getModelOperation(started.id)).state,
        ),
      { timeout: 10_000 },
    );
    return services.routes.getModelOperation(started.id);
  };
  return {
    root,
    capabilities,
    refusals,
    routingStatus: createCredentialProfilesService(() => quota, {
      ...sql.graph.accounts,
      capabilities,
      refusals,
    }).accountRoutingEvidence,
    services,
    resources,
    profiles,
    cfg,
    catalogModels,
    failures,
    failureContext,
    catalog,
    invoke,
    probe,
    quota,
    unusable,
    substitutions,
    served,
    incomplete,
    clock,
    client,
    agentRunner,
    run,
  };
}

describe("production model service composition", () => {
  it("model operations and catalog selection judge each window at the decision (#457)", async () => {
    const f = await fixture();
    f.cfg.harnesses.codex = GlobalConfig.parse({
      harnesses: {
        codex: {
          profile_policy: {
            limit_action: "rotate",
            rotation_eligible: [],
            headroom_threshold: 0.9,
          },
        },
      },
    }).harnesses.codex!;
    // A three-minute-old reading: the short window reset a minute ago, the
    // weekly window is current at 95% against the 90% reserve.
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    f.quota.upsert({
      subject: {
        harness: "codex",
        credential_route: "vendor_native",
        plan_label: null,
        subject_id: "a",
      },
      source: "codex_app_server",
      observed_at: at(-3 * 60_000),
      freshness: "fresh",
      constraints: [
        {
          id: "codex:primary",
          label: "5h",
          used_ratio: 1,
          window_seconds: 18_000,
          resets_at: at(-60_000),
          cooldown_until: null,
        },
        {
          id: "codex:secondary",
          label: "weekly",
          used_ratio: 0.95,
          window_seconds: 604_800,
          resets_at: at(3 * 86_400_000),
          cooldown_until: null,
        },
      ],
    });
    // Display keeps aggregate aging; selection does not lose the weekly reserve.
    expect(f.quota.read().snapshots[0]?.freshness).toBe("stale");
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem).toMatchObject({
      code: "subscription_window_exhausted",
      context: { refusal_basis: "owner_reserve", constraint_id: "codex:secondary" },
    });
    expect(pinned.dispatch.state).toBe("not_started");
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
    expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("b");
    expect(f.invoke.mock.calls.every(([, context]) => context.profile.profile_id === "b")).toBe(
      true,
    );
  });

  it.each(["model_unavailable", "model_capability_refused"])(
    "retains a dispatched %s with explicit model_not_found at model scope",
    async (code) => {
      const f = await fixture();
      f.failures.a = code;
      f.failureContext.a = { httpStatus: 404, vendorCode: "model_not_found" };
      const failed = await f.run({ mode: "pin", profileId: "a" });
      expect(failed.problem?.code).toBe(code);
      expect(f.unusable.live()).toMatchObject([
        { profile_id: "a", model: "test-model", code: "capability_refused" },
      ]);
      expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
      await expect(f.services.routes.modelCatalog("codex", "a")).resolves.toMatchObject({
        credentialProfileId: "a",
      });
    },
  );

  it.each(["model_unavailable", "model_capability_refused"])(
    "does not turn a pre-dispatch %s into an account restriction",
    async (code) => {
      const f = await fixture();
      f.invoke.mockImplementationOnce(async (request, context) =>
        ModelCallResult.parse({
          outcome: "failed",
          message: null,
          route: {
            source: "codex",
            credentialProfileId: context.profile.profile_id,
            accountFingerprint: context.profile.profile_id,
            model: request.model,
          },
          usage: {},
          cost: {
            knowledge: "unknown",
            billing: "unknown",
            source: "fixture",
            provenance: ["fixture"],
          },
          appliedOptions: {},
          problem: {
            code,
            message: "preparation failed",
            retryable: false,
            context: { vendorCode: "model_not_found", generationStarted: false },
          },
        }),
      );
      const refused = await f.run({ mode: "pin", profileId: "a" });
      // The guard is reached: the intended problem arrives without a dispatch.
      expect(refused.problem?.code).toBe(code);
      expect(refused.dispatch.state).toBe("not_started");
      expect(f.unusable.live()).toEqual([]);
      expect((await f.run({ mode: "pin", profileId: "a" })).state).toBe("succeeded");
    },
  );

  it.each(["late_failure", "late_success", "concurrent_success"] as const)(
    "retains operation results without allowing %s to overwrite newer account evidence",
    async (scenario) => {
      const f = await fixture();
      if (scenario === "late_failure") {
        f.failures.a = "auth_required";
        f.failureContext.a = { httpStatus: 401 };
      }
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const active = new Promise<void>((resolve) => {
        started = resolve;
      });
      const invoke = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementationOnce(async (request, context) => {
        const result = await invoke(request, context);
        started();
        await gate;
        return result;
      });
      const pending = f.run({ mode: "pin", profileId: "a" });
      await active;
      if (scenario !== "concurrent_success") f.unusable.clearSubject("codex", "a");
      if (scenario !== "late_failure")
        f.unusable.record({
          harness_id: "codex",
          profile_id: "a",
          credential_route: "vendor_native",
          model: null,
          code: "auth_revoked",
          source: "attempt_stream",
          detail: "newer refusal",
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      release();
      const result = await pending;
      expect(result.state).toBe(scenario === "late_failure" ? "failed" : "succeeded");
      if (scenario === "late_failure") {
        expect(result.problem?.code).toBe("auth_required");
        expect(f.unusable.live()).toEqual([]);
        expect(f.quota.read().snapshots).toEqual([]);
      } else expect(f.unusable.live()).toMatchObject([{ detail: "newer refusal" }]);
      expect(f.invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("binds a catalog refusal before its RPC, so a later login cannot be poisoned", async () => {
    const f = await fixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.catalog.mockImplementationOnce(async () => {
      started();
      await gate;
      throw Object.assign(new Error("vendor refusal"), {
        problem: ControlProblem.parse({
          code: "auth_required",
          message: "vendor refusal",
          retryable: false,
        }),
      });
    });
    const pending = f.services.routes.modelCatalog("codex", "a");
    const settled = pending.catch((error: unknown) => error);
    await active;
    f.unusable.clearSubject("codex", "a");
    release();
    expect(await settled).toMatchObject({ problem: { code: "auth_required" } });
    expect(f.unusable.live()).toEqual([]);
    expect(f.invoke).not.toHaveBeenCalled();
    await expect(f.services.routes.modelCatalog("codex", "a")).resolves.toMatchObject({
      credentialProfileId: "a",
    });
  });

  it("preserves raw Ultra preference order through catalog parsing into the only generation", async () => {
    const provider = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method !== "POST")
        return Response.json({
          models: [
            {
              slug: "test-model",
              supported_reasoning_levels: ["low", "max", "ultra"].map((effort) => ({ effort })),
              multi_agent_version: "v2",
              multi_agent_reasoning_effort: "low",
            },
          ],
        });
      const body = JSON.parse(await requestBodyText(init));
      expect(body.reasoning.effort).toBe("max");
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "test-model",
            output: [],
            reasoning: { effort: "max" },
          },
        })}\n\n`,
      );
    });
    const adapter = createCodexModelAdapter({
      fetch: provider,
      now: () => 1900000000000,
      clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "fixture",
            id_token: `fixture.${Buffer.from('{"sub":"fixture"}').toString("base64url")}.signature`,
            access_token: `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`,
          },
        }),
    });
    const f = await fixture({ adapter });
    // The real adapter validates its managed home, unlike the fixture's fake
    // adapter. Keep both profile and auth resolution under this test's root.
    process.env.CLAUDEXOR_CONFIG_DIR = f.root;
    const request = ModelCallRequest.parse({
      source: "codex",
      model: "test-model",
      account: { mode: "pin", profileId: "a" },
      messages: [{ role: "user", content: "test" }],
      options: { reasoningEffort: "ultra" },
    });
    const ref = f.resources().publishModel(Buffer.from(JSON.stringify(request)));
    const started = await f.services.routes.createModelOperation(
      ref,
      randomUUID(),
      undefined,
      true,
    );
    await vi.waitFor(
      async () =>
        expect((await f.services.routes.getModelOperation(started.id)).state).toBe("succeeded"),
      { timeout: 10_000 },
    );
    const result = ModelCallResult.parse(
      JSON.parse((await f.services.routes.readModelResult(started.id)).bytes.toString()),
    );
    expect(result).toMatchObject({
      outcome: "completed",
      effortResolution: {
        requested: "ultra",
        submitted: "max",
        observed: "max",
        resolution: "downward",
      },
    });
    expect(provider.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
    expect(f.agentRunner).not.toHaveBeenCalled();
  });

  it("enumerates distinct enabled account inventories without selecting the inference account", async () => {
    const f = await fixture({ lazy: true });
    f.catalogModels.a = [model("only-a")];
    f.catalogModels.b = [
      {
        ...model("only-b"),
        contextWindow: 1000000,
        processing: {
          modes: ["standard", "fast"],
          nativeModes: [{ mode: "fast", id: "priority" }],
          defaultNativeMode: "auto",
          eligible: true,
          source: "fixture",
          observedAt: "2026-09-12T00:00:00.000Z",
        },
      },
    ];
    const view = await f.services.routes.modelAccountCatalog("codex");
    expect(view.partial).toBe(false);
    expect(
      view.accounts.map((row) => [
        row.credentialProfileId,
        row.catalog?.models[0]?.id,
        row.catalog?.models[0]?.contextWindow,
      ]),
    ).toEqual([
      ["a", "only-a", 272000],
      ["b", "only-b", 1000000],
    ]);
    expect(view.accounts[1]?.catalog?.models[0]?.processing?.nativeModes).toEqual([
      { mode: "fast", id: "priority" },
    ]);
    expect(
      view.accounts.every((row) => row.availability === "available" && row.problem === null),
    ).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
    f.catalog.mockClear();
    const pinned = await f.services.routes.modelAccountCatalog("codex", "b");
    expect(pinned.accounts.map((row) => row.credentialProfileId)).toEqual(["b"]);
    expect(f.catalog).not.toHaveBeenCalled();
    f.cfg.credential_profiles[1]!.enabled = false;
    await expect(f.services.routes.modelAccountCatalog("codex", "b")).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    expect(
      (await f.services.routes.modelAccountCatalog("codex")).accounts.map(
        (row) => row.credentialProfileId,
      ),
    ).toEqual(["a"]);
  });

  it("keeps partial inventory failures separate from missing authentication and preserves observation time", async () => {
    const f = await fixture({ lazy: true });
    const observedAt = "2026-09-10T00:00:00.000Z";
    f.catalog.mockImplementation(async ({ profile }) => {
      if (profile.profile_id === "b") throw new Error("network failed");
      return {
        source: "codex",
        credentialProfileId: "a",
        accountFingerprint: "a",
        observedAt,
        sourceProgram: null,
        provenance: "existing_cache",
        clientVersion: null,
        clientVersionSource: null,
        models: [model()],
      };
    });
    const partial = await f.services.routes.modelAccountCatalog("codex");
    expect(partial.partial).toBe(true);
    expect(partial.accounts[0]?.catalog).toMatchObject({
      observedAt,
      sourceProgram: null,
      provenance: "existing_cache",
    });
    expect(partial.accounts[1]).toMatchObject({
      credentialProfileId: "b",
      availability: "unknown",
      catalog: null,
      problem: { code: "model_catalog_unavailable" },
    });
    expect(f.unusable.live()).toEqual([]);
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (profile) =>
      profile.profile_id === "b"
        ? { ...(await original(profile)), availability: "unavailable", verification: "failed" }
        : original(profile),
    );
    f.catalog.mockClear();
    accountObservations.invalidate(); // Explicit credential-state invalidation.
    const missing = await f.services.routes.modelAccountCatalog("codex");
    expect(missing.accounts[1]).toMatchObject({
      credentialProfileId: "b",
      availability: "unavailable",
      catalog: null,
      problem: { code: "auth_unavailable" },
    });
    expect(f.catalog).toHaveBeenCalledTimes(1);
  });

  it("retains quota-exhausted account catalogs without admitting an inference", async () => {
    const f = await fixture({ lazy: true });
    const resetsAt = new Date(Date.now() + 60000).toISOString();
    f.quota.ingest("codex", {
      type: "error",
      ts: new Date().toISOString(),
      session_id: "quota",
      credential_profile_id: "b",
      credential_route: "vendor_native",
      rate_limit: { resets_at: resetsAt, retry_delay_ms: null },
    });
    const view = await f.services.routes.modelAccountCatalog("codex");
    expect(view.accounts[1]).toMatchObject({
      availability: "unavailable",
      problem: { code: "subscription_window_exhausted" },
      catalog: { credentialProfileId: "b" },
    });
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("constructs without creating the ResourceStore or probing accounts in recovery", async () => {
    const f = await fixture({ lazy: true });
    expect(f.resources).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(await f.services.routes.modelSources()).toEqual({
      sources: [{ id: "codex", label: "Codex", credentialHarness: "codex" }],
    });
    expect(f.resources).not.toHaveBeenCalled();
    await expect(f.services.routes.modelCatalog("claude")).rejects.toMatchObject({
      code: "model_source_unavailable",
    });
  });

  it("catalog omission uses Auto and pin reads only its exact account, without a union", async () => {
    const f = await fixture();
    f.catalogModels.a = [model("only-a")];
    f.catalogModels.b = [model("only-b")];
    expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("a");
    const catalog = await f.services.routes.modelCatalog("codex", "b");
    expect(catalog.models.map((entry) => entry.id)).toEqual(["only-b"]);
    expect(catalog.models[0]?.maxContextWindow).toBe(872000);
    await expect(f.services.routes.modelCatalog("codex", "absent")).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    f.profiles[1]!.enabled = false;
    f.cfg.credential_profiles[1]!.enabled = false;
    await expect(f.services.routes.modelCatalog("codex", "b")).rejects.toMatchObject({
      code: "model_account_unavailable",
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("model-aware Auto discovery finds a recovered compatible account without borrowing capacity", async () => {
    const f = await fixture();
    f.catalogModels.a = [model("only-a")];
    f.catalogModels.b = [{ ...model("test-model"), maxContextWindow: 500000 }];
    expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("a");
    f.catalog.mockClear();
    const catalog = await f.services.routes.modelCatalog("codex", undefined, "test-model");
    expect(f.catalog.mock.calls.map(([input]) => input.profile.profile_id)).toEqual(["a", "b"]);
    expect(catalog.credentialProfileId).toBe("b");
    expect(catalog.accountFingerprint).toBe("b");
    expect(catalog.models).toEqual(f.catalogModels.b);
    await expect(f.services.routes.modelCatalog("codex", "a", "test-model")).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.resources).not.toHaveBeenCalled();
  });

  it("keeps a usable preferred account and dispatches model commands before Agent normalization", async () => {
    const f = await fixture();
    const done = await f.run({ mode: "auto", preferredProfileId: "b" });
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.agentRunner).not.toHaveBeenCalled();
    expect(await f.client.list({ page: { limit: 200, state: null, cursor: null } })).toEqual([]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const read = await f.services.routes.readModelResult(done.id);
    expect(JSON.parse(read.bytes.toString()).message.content).toBe("own model reply");
    expect((await f.services.routes.getModelOperation(done.id)).response.state).toBe("ready");
    await f.services.routes.acknowledgeModelResult(done.id, read.sha256);
    expect(f.resources().listModelResources()).toEqual([]);
  });

  it("uses the same resolver to skip a preferred account lacking this model before any inference", async () => {
    const f = await fixture();
    f.catalogModels.b = [model("different")];
    const done = await f.run({ mode: "auto", preferredProfileId: "b" });
    expect(done.dispatch.route?.credentialProfileId).toBe("a");
    expect(f.catalog.mock.calls.map(([context]) => context.profile.profile_id)).toEqual(["b", "a"]);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const pinned = await f.run({ mode: "pin", profileId: "b" });
    expect(pinned.problem?.code).toBe("model_unavailable");
    // The first gate a pinned caller hits names the declared client version
    // too (issue #339): the version filter, not the account, decided the list.
    expect(pinned.problem?.message).toContain("client_version 0.156.1");
    expect(pinned.dispatch.state).toBe("not_started");
    f.catalogModels.a = [];
    const unsupported = await f.run();
    expect(unsupported.problem?.code).toBe("model_unavailable");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["auto", "pin"] as const)(
    "advisory %s admits an explicit unlisted model without borrowing another account",
    async (mode) => {
      const f = await fixture({ inventoryAbsence: "advisory" });
      f.catalogModels.a = [];
      f.failures.b = "subscription_window_exhausted";
      await f.run({ mode: "pin", profileId: "b" });
      f.catalog.mockClear();
      f.invoke.mockClear();
      const done = await f.run(mode === "pin" ? { mode, profileId: "a" } : { mode });
      expect(done.state).toBe("succeeded");
      expect(done.dispatch.route?.credentialProfileId).toBe("a");
      expect(f.catalog).toHaveBeenCalledTimes(1);
      expect(f.invoke).toHaveBeenCalledTimes(1);
      expect(f.invoke.mock.calls[0]![0].model).toBe("test-model");
      const catalog = await f.services.routes.modelCatalog("codex", "a", "test-model", true);
      expect(catalog.models).toEqual([]);
      expect(catalog.admission).toEqual({
        requestedModel: "test-model",
        inventoryAbsence: "advisory",
      });
      expect(await f.services.routes.modelCatalog("codex", "a", "test-model")).not.toHaveProperty(
        "admission",
      );
    },
  );

  it("advisory requested-model observation and generation still obey model-scoped quota", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.catalogModels.a = [];
    f.failures.a = "subscription_window_exhausted";
    await f.run({ mode: "pin", profileId: "a" });
    // Display and admission reads see the same model-scoped windows.
    const scoped = <T extends { snapshots: QuotaSnapshot[] }>(state: T): T => ({
      ...state,
      snapshots: state.snapshots.map((row) => ({
        ...row,
        constraints: row.constraints.map((constraint) => ({
          ...constraint,
          applies_to_models: ["test-model"],
          applies_to_model_prefixes: [],
          applies_to_unspecified_model: false,
        })),
      })),
    });
    const readQuota = f.quota.read.bind(f.quota);
    const readAdmission = f.quota.readAdmission.bind(f.quota);
    vi.spyOn(f.quota, "read").mockImplementation(() => scoped(readQuota()));
    vi.spyOn(f.quota, "readAdmission").mockImplementation(() => scoped(readAdmission()));
    const other = await f.services.routes.modelCatalog("codex", "a", "other-model", true);
    expect(other.admission?.requestedModel).toBe("other-model");
    const blocked = await f.run({ mode: "pin", profileId: "a" });
    expect(blocked.problem?.code).toBe("subscription_window_exhausted");
    expect(blocked.dispatch.state).toBe("not_started");
    await expect(
      f.services.routes.modelCatalog("codex", "a", "test-model", true),
    ).rejects.toMatchObject({ code: "subscription_window_exhausted" });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const sibling = await f.services.routes.modelCatalog("codex", undefined, "test-model", true);
    expect(sibling.credentialProfileId).toBe("b");
    expect(sibling.admission?.requestedModel).toBe("test-model");
  });

  it("an authoritative source preserves catalog absence beside unrelated quota", async () => {
    const f = await fixture();
    f.failures.b = "subscription_window_exhausted";
    await f.run({ mode: "pin", profileId: "b" });
    f.invoke.mockClear();
    f.catalogModels.a = [];
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "unavailable", resetsAt: null },
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("catalog failure plus genuine quota retains unavailability without a whole-request reset", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.failures.b = "subscription_window_exhausted";
    await f.run({ mode: "pin", profileId: "b" });
    f.invoke.mockClear();
    f.catalog.mockRejectedValue(
      Object.assign(new Error("catalog offline"), {
        problem: ControlProblem.parse({
          code: "catalog_unavailable",
          message: "catalog offline",
          retryable: true,
        }),
      }),
    );
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "unavailable", resetsAt: null },
    });
    expect(done.dispatch.state).toBe("not_started");
    expect(f.invoke).not.toHaveBeenCalled();
    await expect(
      f.services.routes.modelCatalog("codex", "a", "test-model", true),
    ).rejects.toMatchObject({ problem: { code: "catalog_unavailable" } });
  });

  it("records confirmed quota in the shared registry; the next Auto operation rotates but pin refuses", async () => {
    const f = await fixture();
    f.failures.a = "subscription_window_exhausted";
    const first = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(first.problem?.code).toBe("subscription_window_exhausted");
    expect(f.quota.read().snapshots[0]?.subject.subject_id).toBe("a");
    const next = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem?.code).toBe("subscription_window_exhausted");
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("states a served-model mismatch as a typed fact; the next Auto operation prefers other accounts", async () => {
    const f = await fixture();
    const result = async (id: string) =>
      JSON.parse((await f.services.routes.readModelResult(id)).bytes.toString());
    f.served.a = "other-model";
    const first = await f.run();
    // One generation, an unchanged outcome and a fact the caller can act on.
    expect(first.state).toBe("succeeded");
    expect(first.dispatch.route).toMatchObject({ credentialProfileId: "a", model: "other-model" });
    expect(await result(first.id)).toMatchObject({
      outcome: "completed",
      message: { content: "own model reply" },
      modelMismatch: { requested: "test-model", observed: "other-model" },
    });
    expect(f.substitutions.live()).toMatchObject([
      {
        harness_id: "codex",
        profile_id: "a",
        requested_model: "test-model",
      },
    ]);
    const next = await f.run();
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    expect(await result(next.id)).not.toHaveProperty("modelMismatch");
    // A preferred account and a pin are resolved before the ordering.
    f.clock.now += 60_000;
    const preferred = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(preferred.dispatch.route?.credentialProfileId).toBe("a");
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.dispatch.route?.credentialProfileId).toBe("a");
    expect(f.invoke).toHaveBeenCalledTimes(4);
  });

  it("takes turns through a fully substituting pool and restores the order when observations expire", async () => {
    const f = await fixture();
    f.served.a = f.served.b = "other-model";
    const chosen: Array<string | undefined> = [];
    for (let i = 0; i < 4; i += 1) {
      f.clock.now += 60_000;
      const done = await f.run();
      expect(done.state).toBe("succeeded");
      chosen.push(done.dispatch.route?.credentialProfileId);
    }
    // Never refused: a marked account is still selected, oldest observation first.
    expect(chosen).toEqual(["a", "b", "a", "b"]);
    f.clock.now += 31 * 60_000;
    expect(f.substitutions.live()).toEqual([]);
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("a");
  });

  it("states the mismatch on an incomplete terminal response too", async () => {
    // An answer that ran out of room was still produced by the other model.
    const f = await fixture();
    f.served.a = "other-model";
    f.incomplete.add("a");
    const run = await f.run({ mode: "pin", profileId: "a" });
    expect(
      JSON.parse((await f.services.routes.readModelResult(run.id)).bytes.toString()),
    ).toMatchObject({
      outcome: "incomplete",
      modelMismatch: { requested: "test-model", observed: "other-model" },
    });
    expect(f.substitutions.live()).toMatchObject([
      { profile_id: "a", requested_model: "test-model" },
    ]);
  });

  it("records no mismatch without a known, different model on a terminal response", async () => {
    const f = await fixture();
    f.served.a = null;
    const unknown = await f.run({ mode: "pin", profileId: "a" });
    expect(
      JSON.parse((await f.services.routes.readModelResult(unknown.id)).bytes.toString()),
    ).not.toHaveProperty("modelMismatch");
    f.served.a = "other-model";
    f.failures.a = "provider_failed";
    f.failureContext.a = {};
    const failed = await f.run({ mode: "pin", profileId: "a" });
    expect(failed.state).toBe("failed");
    expect(
      JSON.parse((await f.services.routes.readModelResult(failed.id)).bytes.toString()),
    ).not.toHaveProperty("modelMismatch");
    expect(f.substitutions.live()).toEqual([]);
  });

  it("names the requested model on a failure beside, never instead of, the observed one (#649)", async () => {
    const f = await fixture();
    const stored = async (id: string) =>
      ModelCallResult.parse(
        JSON.parse((await f.services.routes.readModelResult(id)).bytes.toString()),
      );
    // A pinned non-capability HTTP failure: no capability decoration names it.
    f.failures.a = "provider_failed";
    f.failureContext.a = { httpStatus: 503 };
    f.served.a = null;
    const unobserved = await f.run({ mode: "pin", profileId: "a" });
    expect(unobserved).toMatchObject({
      state: "failed",
      dispatch: { state: "response_received", route: { credentialProfileId: "a", model: null } },
      problem: {
        code: "provider_failed",
        context: { httpStatus: 503, requestedModel: "test-model" },
      },
    });
    expect((await stored(unobserved.id)).problem).toEqual(unobserved.problem);
    // A failed terminal that disclosed another model keeps it as the observed route model.
    f.served.a = "other-model";
    const substituted = await f.run({ mode: "pin", profileId: "a" });
    expect(substituted).toMatchObject({
      dispatch: { route: { model: "other-model" } },
      problem: { context: { requestedModel: "test-model" } },
    });
    expect(await stored(substituted.id)).not.toHaveProperty("modelMismatch");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("states a mismatch on an incomplete answer unchanged while its problem names the request (#649)", async () => {
    const f = await fixture({
      adapter: {
        id: "codex",
        catalog: async ({ profile }) => ({
          source: "codex",
          credentialProfileId: profile.profile_id,
          accountFingerprint: profile.profile_id,
          observedAt: new Date().toISOString(),
          sourceProgram: null,
          provenance: "fixture exact catalog",
          clientVersion: "0.156.1",
          clientVersionSource: "verified_transport",
          models: [model()],
        }),
        invoke: async (request, context) => {
          const route = {
            source: "codex",
            credentialProfileId: context.profile.profile_id,
            accountFingerprint: context.profile.profile_id,
            model: request.model,
          };
          await context.onDispatch(route);
          return ModelCallResult.parse({
            outcome: "incomplete",
            message: { role: "assistant", content: "partial reply" },
            route: { ...route, model: "other-model" },
            usage: { input_tokens: 5, output_tokens: 3 },
            cost: {
              knowledge: "unknown",
              billing: "unknown",
              source: "fixture",
              provenance: ["f"],
            },
            appliedOptions: {},
            problem: { code: "provider_incomplete", message: "ran out of room", retryable: false },
          });
        },
      },
    });
    const done = await f.run({ mode: "pin", profileId: "a" });
    expect(done).toMatchObject({
      state: "interrupted",
      dispatch: { state: "response_received", route: { model: "other-model" } },
      problem: { code: "provider_incomplete", context: { requestedModel: "test-model" } },
    });
    expect(
      ModelCallResult.parse(
        JSON.parse((await f.services.routes.readModelResult(done.id)).bytes.toString()),
      ),
    ).toMatchObject({
      outcome: "incomplete",
      route: { model: "other-model" },
      modelMismatch: { requested: "test-model", observed: "other-model" },
      problem: done.problem,
    });
  });

  it("names the requested model on refusals before any dispatch, with no route (#649)", async () => {
    const f = await fixture();
    const unknownPin = await f.run({ mode: "pin", profileId: "missing" });
    expect(unknownPin).toMatchObject({
      state: "failed",
      dispatch: { state: "not_started", route: null },
      response: { state: "absent" },
      problem: { code: "model_account_unavailable", context: { requestedModel: "test-model" } },
    });
    f.catalog.mockRejectedValueOnce(
      Object.assign(new Error("catalog unavailable"), {
        problem: ControlProblem.parse({
          code: "catalog_unavailable",
          message: "catalog unavailable",
          retryable: false,
        }),
      }),
    );
    const catalogRefusal = await f.run({ mode: "pin", profileId: "a" }, { model: "other-model" });
    expect(catalogRefusal).toMatchObject({
      dispatch: { state: "not_started", route: null },
      problem: {
        code: "catalog_unavailable",
        context: { source: "codex", credentialProfileId: "a", requestedModel: "other-model" },
      },
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("types an all-quota pool before catalog polling or another generation", async () => {
    const f = await fixture();
    f.failures.a = f.failures.b = "subscription_window_exhausted";
    await f.run({ mode: "pin", profileId: "a" });
    await f.run({ mode: "pin", profileId: "b" });
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "subscription_window_exhausted",
      context: { poolCause: "quota", resetsAt: expect.any(String) },
    });
    expect(done.dispatch.state).toBe("not_started");
    await expect(f.services.routes.modelCatalog("codex")).rejects.toMatchObject({
      problem: { code: "subscription_window_exhausted", context: { poolCause: "quota" } },
    });
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.catalog).toHaveBeenCalledTimes(2);
  });

  it.each(["empty", "disabled"])(
    "keeps an %s pool unavailable instead of inventing quota or logout",
    async (kind) => {
      const f = await fixture();
      if (kind === "empty") f.cfg.credential_profiles = [];
      else
        f.cfg.credential_profiles.forEach((profile) => {
          profile.enabled = false;
        });
      const done = await f.run();
      expect(done.problem).toMatchObject({
        code: "credential_pool_exhausted",
        context: { poolCause: "unavailable", resetsAt: null },
      });
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["auth_required", "auth_required", "auth_required", "auth"],
    ["auth_required", "subscription_window_exhausted", "credential_pool_exhausted", "mixed"],
  ])("preserves the proved pool causes %s + %s", async (a, b, expectedCode, poolCause) => {
    const f = await fixture();
    f.failures.a = a;
    f.failures.b = b;
    // Declare the vendor fact that accompanies each code on the live route: a
    // rejected credential arrives as HTTP 401, a spent window as a reset time.
    for (const [id, code] of [
      ["a", a],
      ["b", b],
    ] as const)
      f.failureContext[id] =
        code === "auth_required"
          ? { httpStatus: 401 }
          : { resetsAt: new Date(Date.now() + 60000).toISOString() };
    await f.run({ mode: "pin", profileId: "a" });
    await f.run({ mode: "pin", profileId: "b" });
    const done = await f.run();
    expect(done.problem).toMatchObject({ code: expectedCode, context: { poolCause } });
    expect(done.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not let a final catalog refusal relabel a mixed pool as all-auth or all-quota", async () => {
    const f = await fixture();
    f.catalog.mockImplementation(async (context) => {
      throw Object.assign(new Error("catalog refusal"), {
        problem: ControlProblem.parse({
          code:
            context.profile.profile_id === "a" ? "auth_required" : "subscription_window_exhausted",
          message: "catalog refusal",
          retryable: false,
        }),
      });
    });
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "mixed" },
    });
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(["catalog_unavailable"])(
    "types a pool that lost every catalog to %s as unavailable, not as spent quota",
    async (code) => {
      const f = await fixture();
      f.catalog.mockRejectedValue(
        Object.assign(new Error("catalog refusal"), {
          problem: ControlProblem.parse({ code, message: "catalog refusal", retryable: false }),
        }),
      );
      const done = await f.run();
      expect(done.problem).toMatchObject({
        code: "credential_pool_exhausted",
        context: { poolCause: "unavailable" },
      });
      expect(f.catalog).toHaveBeenCalledTimes(2);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("tells the owner the pool is unavailable, without a reset, when the network dies", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValue(
      // The shape the live adapter throws when the catalog fetch itself fails:
      // a retryable catalog_unavailable carrying no vendor context at all.
      Object.assign(new Error("network is unreachable"), {
        problem: ControlProblem.parse({
          code: "catalog_unavailable",
          message: "The selected Codex account's catalog could not be reached.",
          retryable: true,
          context: {},
        }),
      }),
    );
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      message: "No managed account can currently serve this model request",
      context: { poolCause: "unavailable", resetsAt: null },
    });
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("preserves existing vendor-poller auth proof for Auto and pin without another probe generation", async () => {
    const f = await fixture();
    const read = f.quota.read.bind(f.quota);
    vi.spyOn(f.quota, "read").mockImplementation(() => ({
      ...read(),
      absences: f.profiles.map((profile) =>
        QuotaAbsence.parse({
          subject: {
            harness: "codex",
            subject_id: profile.profile_id,
            credential_route: "vendor_native",
          },
          reason: "auth_revoked",
          observed_at: new Date().toISOString(),
          detail: "fixture vendor refusal",
        }),
      ),
    }));
    expect((await f.run()).problem).toMatchObject({
      code: "auth_required",
      context: { poolCause: "auth" },
    });
    expect((await f.run({ mode: "pin", profileId: "a" })).problem?.code).toBe("auth_required");
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps unproven profile failure distinct from a sibling's confirmed auth failure", async () => {
    const f = await fixture();
    f.failureContext.a = { httpStatus: 401 };
    f.failures.a = "auth_required";
    await f.run({ mode: "pin", profileId: "a" });
    const original = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (profile) =>
      profile.profile_id === "b"
        ? { ...(await original(profile)), availability: "unknown", verification: "not_run" }
        : original(profile),
    );
    const done = await f.run();
    expect(done.problem).toMatchObject({
      code: "credential_pool_exhausted",
      context: { poolCause: "unavailable" },
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(["rate_limited", "auth_refresh_failed"])(
    "records the vendor-named reset for a typed %s without reinterpreting it as logout",
    async (code) => {
      const f = await fixture();
      f.failures.a = code;
      const done = await f.run({ mode: "pin", profileId: "a" });
      expect(done.problem?.code).toBe(code);
      expect(f.quota.read().snapshots[0]?.subject.subject_id).toBe("a");
      expect(f.unusable.live()).toEqual([]);
    },
  );

  it("writes no cooldown when a rate limit arrives without a vendor reset or delay", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), {
        problem: ControlProblem.parse({
          code: "rate_limited",
          message: "rate limited",
          retryable: true,
        }),
      }),
    );
    const done = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.quota.read().snapshots).toEqual([]);
    expect(f.unusable.live()).toEqual([]);
  });

  it("a Codex usage refusal with no reopening keeps raw-model demand off the account until its own recheck, whatever a read says (#318)", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0, shouldAdvanceTime: true });
    try {
      const f = await fixture();
      const refusedAt = Date.now();
      // The Codex adapter's typed refusal, through the daemon's own ingest.
      f.quota.ingest("codex", {
        type: "status",
        session_id: "earlier-run",
        ts: new Date().toISOString(),
        credential_route: "vendor_native",
        credential_profile_id: "a",
        rate_limit: {
          applies_to_request_kinds: ["text"],
          resets_at: null,
          retry_delay_ms: null,
          reopening: "unknown",
        },
      });
      const refusal = () =>
        f.quota
          .read()
          .snapshots.flatMap((snapshot) => snapshot.constraints)
          .filter((constraint) => constraint.id === REOPENING_UNKNOWN_COOLDOWN_ID);
      const [kept] = refusal();
      const recheck = Date.parse(kept!.cooldown_until!);
      // The existing bounded default: five minutes from the refusal, no vendor time.
      expect(recheck - refusedAt).toBeGreaterThanOrEqual(5 * 60_000);
      expect(recheck - Date.now()).toBeLessThanOrEqual(5 * 60_000);
      vi.setSystemTime(recheck - 60_000);
      // A Refresh's newer recognized read with nothing measured retires nothing.
      f.quota.upsert({
        subject: {
          harness: "codex",
          credential_route: "vendor_native",
          plan_label: null,
          subject_id: "a",
        },
        constraints: [],
        source: "codex_app_server",
        observed_at: new Date().toISOString(),
        freshness: "fresh",
      });
      expect(refusal()).toEqual([kept]);
      const early = await f.run({ mode: "pin", profileId: "a" });
      expect(early.dispatch.state).toBe("not_started");
      // Typed, with no invented reset, and naming the requested model (#649).
      expect(early.problem).toMatchObject({
        code: "vendor_limit_rejected",
        context: { resetsAt: null, requestedModel: "test-model" },
      });
      // Auto demand meanwhile is served by the other account, never by "a".
      expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
      expect(f.invoke.mock.calls.map(([, context]) => context.profile.profile_id)).toEqual(["b"]);
      vi.setSystemTime(recheck);
      const due = await f.run({ mode: "pin", profileId: "a" });
      expect(due.state).toBe("succeeded");
      expect(due.dispatch.route?.credentialProfileId).toBe("a");
      expect(f.invoke.mock.calls.map(([, context]) => context.profile.profile_id)).toEqual([
        "b",
        "a",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a status-less provider failure without a cooldown or a verdict", async () => {
    const f = await fixture();
    f.failureContext.a = {};
    f.failures.a = "provider_failed";
    const done = await f.run({ mode: "pin", profileId: "a" });
    expect(done.problem?.code).toBe("provider_failed");
    expect(f.quota.read().snapshots).toEqual([]);
    expect(f.unusable.live()).toEqual([]);
  });

  it("condemns a credential only on the adapter's confirmed auth loss, not on a bare 401", async () => {
    const f = await fixture();
    // The adapter emits this code precisely because a 401 on a token whose
    // freshness it could not confirm is no proof that a new login is needed.
    f.failureContext.a = { httpStatus: 401 };
    f.failures.a = "auth_refresh_failed";
    await f.run({ mode: "pin", profileId: "a" });
    expect(f.unusable.live()).toEqual([]);
    expect(f.quota.read().snapshots).toEqual([]);
    const g = await fixture();
    g.failureContext.a = { httpStatus: 401 };
    g.failures.a = "auth_required";
    await g.run({ mode: "pin", profileId: "a" });
    expect(g.unusable.live()).toMatchObject([
      { profile_id: "a", code: "auth_revoked", model: null, detail: "authentication_failed" },
    ]);
    expect(g.quota.read().snapshots).toEqual([]);
  });

  it("shares confirmed auth loss with existing Agent account readiness", async () => {
    const f = await fixture();
    f.failureContext.a = { httpStatus: 401 };
    f.failures.a = "auth_required";
    await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(f.unusable.live()[0]).toMatchObject({
      harness_id: "codex",
      profile_id: "a",
      code: "auth_revoked",
    });
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem).toMatchObject({
      code: "auth_required",
      context: { credentialProfileId: "a" },
    });
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      (await f.run({ mode: "auto", preferredProfileId: "a" })).dispatch.route?.credentialProfileId,
    ).toBe("b");
  });

  it.each(["auth_required", "subscription_window_exhausted"])(
    "rotates a confirmed catalog %s before inference, while preserving strict pin",
    async (code) => {
      const f = await fixture();
      const original = f.catalog.getMockImplementation()!;
      // The vendor fact each refusal carries on the live route: a rejected
      // sign-in arrives as HTTP 401 with no reset time, a spent window names one.
      const vendorFact =
        code === "auth_required"
          ? { httpStatus: 401 }
          : { resetsAt: new Date(Date.now() + 60000).toISOString() };
      f.catalog.mockImplementation(async (context) => {
        if (context.profile.profile_id === "a")
          throw Object.assign(new Error("catalog refused"), {
            problem: ControlProblem.parse({
              code,
              message: "catalog refused",
              retryable: false,
              context: vendorFact,
            }),
          });
        return original(context);
      });
      const done = await f.run({ mode: "auto", preferredProfileId: "a" });
      expect(done.state).toBe("succeeded");
      expect(done.dispatch.route?.credentialProfileId).toBe("b");
      expect(f.invoke).toHaveBeenCalledTimes(1);
      const g = await fixture();
      g.catalog.mockRejectedValueOnce(
        Object.assign(new Error("catalog refused"), {
          problem: ControlProblem.parse({ code, message: "catalog refused", retryable: false }),
        }),
      );
      const pinned = await g.run({ mode: "pin", profileId: "a" });
      expect(pinned.problem).toMatchObject({
        code,
        context: { source: "codex", credentialProfileId: "a" },
      });
      expect(pinned.dispatch.state).toBe("not_started");
      expect(g.catalog).toHaveBeenCalledTimes(1);
      expect(g.invoke).not.toHaveBeenCalled();
    },
  );

  it("advances to a healthy sibling on a catalog refusal outside the rotation codes", async () => {
    const f = await fixture();
    const original = f.catalog.getMockImplementation()!;
    f.catalog.mockImplementation(async (context) => {
      if (context.profile.profile_id === "a")
        throw Object.assign(new Error("catalog unavailable"), {
          problem: ControlProblem.parse({
            code: "catalog_unavailable",
            message: "catalog unavailable",
            retryable: false,
          }),
        });
      return original(context);
    });
    const done = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit pin strict on a catalog refusal outside the rotation codes", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValueOnce(
      Object.assign(new Error("catalog unavailable"), {
        problem: ControlProblem.parse({
          code: "catalog_unavailable",
          message: "catalog unavailable",
          retryable: false,
        }),
      }),
    );
    const pinned = await f.run({ mode: "pin", profileId: "a" });
    expect(pinned.problem).toMatchObject({
      code: "catalog_unavailable",
      context: { source: "codex", credentialProfileId: "a" },
    });
    expect(pinned.dispatch.state).toBe("not_started");
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("does not turn local verification failure into a confirmed sign-in requirement", async () => {
    const f = await fixture();
    f.unusable.record({
      harness_id: "codex",
      profile_id: "a",
      code: "verification_failed",
      source: "local_probe",
      model: null,
      detail: "probe failed",
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    const result = await f.run({ mode: "pin", profileId: "a" });
    expect(result.state).toBe("failed");
    expect(result.problem?.code).not.toBe("auth_required");
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("preserves a catalog authentication refusal when every Auto account needs sign-in", async () => {
    const f = await fixture();
    f.catalog.mockRejectedValue(
      Object.assign(new Error("login required"), {
        problem: ControlProblem.parse({
          code: "auth_required",
          message: "login required",
          retryable: false,
        }),
      }),
    );
    const done = await f.run();
    expect(done.problem?.code).toBe("auth_required");
    expect(f.catalog).toHaveBeenCalledTimes(2);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "bounds catalog quota rejection without reset, even if evidence recording fails (%s)",
    async (brokenEvidence) => {
      const f = await fixture();
      f.catalog.mockRejectedValue(
        Object.assign(new Error("quota refused"), {
          problem: ControlProblem.parse({
            code: "subscription_window_exhausted",
            message: "quota refused",
            retryable: true,
          }),
        }),
      );
      if (brokenEvidence)
        vi.spyOn(f.quota, "ingest").mockImplementation(() => {
          throw new Error("journal unavailable");
        });
      const done = await f.run({ mode: "auto", preferredProfileId: "a" });
      expect(done.problem?.code).toBe("subscription_window_exhausted");
      expect(f.catalog.mock.calls.map(([context]) => context.profile.profile_id)).toEqual([
        "a",
        "b",
      ]);
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses a catalog for another account and never borrows an API-key row", async () => {
    const f = await fixture();
    const catalog = await f.services.routes.modelCatalog("codex", "b");
    f.catalog.mockResolvedValueOnce(catalog);
    expect((await f.run({ mode: "pin", profileId: "a" })).problem?.code).toBe(
      "model_catalog_identity_mismatch",
    );
    f.cfg.credential_profiles.push(
      CredentialProfile.parse({
        profile_id: "paid",
        harness_id: "codex",
        display_name: "Paid",
        credential_kind: "api_key",
        secret_ref: "openai:paid",
      }),
    );
    expect((await f.run({ mode: "pin", profileId: "paid" })).problem?.code).toBe(
      "model_account_unavailable",
    );
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps legacy GC receipt shape and exposes model cleanup only on request", async () => {
    const f = await fixture();
    const cancel = vi.fn(async () => {});
    const hasMore = () => true;
    const gc = f.services.withRetention(
      Object.assign(
        async (request: { dry_run: boolean }) =>
          ControlGcReceipt.parse({
            dry_run: request.dry_run,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            policy: {
              runs_max_age_days: 30,
              reviews_max_age_days: 14,
              keep_last_runs_per_project: 1,
            },
            examined_runs: 0,
            kept: {},
            freed_bytes: 0,
          }),
        { cancel, hasMore },
      ),
    );
    await gc.cancel!();
    expect(cancel).toHaveBeenCalledOnce();
    expect(gc.hasMore).toBe(hasMore);
    const reconcile = vi
      .spyOn(f.services.operations, "reconcileResources")
      .mockReturnValue({ released: ["model-ref"], errors: ["cleanup pending"] });
    const legacy = await gc({ dry_run: true });
    expect(legacy).not.toHaveProperty("model_payloads");
    expect(legacy.errors).toEqual(["cleanup pending"]);
    const detailed = await gc({ dry_run: false, model_payload_report: true });
    expect(detailed.model_payloads).toEqual({
      released: ["model-ref"],
      errors: ["cleanup pending"],
    });
    expect(reconcile.mock.calls).toEqual([[true], [false]]);
  });

  it("aborts in-flight catalog work when the daemon starts its graceful close", async () => {
    const f = await fixture();
    f.catalog.mockImplementationOnce(
      async ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("catalog cancelled")), {
            once: true,
          });
        }),
    );
    const catalog = f.services.routes.modelCatalog("codex").catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.catalog).toHaveBeenCalled());
    f.services.close();
    expect(await catalog).toMatchObject({ message: "catalog cancelled" });
    expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe("account/model capability routing", () => {
  const refusal = {
    generationStarted: false,
    capabilityKind: "model_not_supported",
    capabilityEvidence: "provider_text",
    providerReason:
      "The 'test-model' model is not supported when using Codex with a ChatGPT account.",
  };
  async function refusing() {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.failures.a = "model_capability_refused";
    f.failureContext.a = refusal;
    return f;
  }
  it.each([
    { capabilityKind: "model_not_supported", capabilityEvidence: "provider_text" },
    { capabilityKind: "model_not_found", capabilityEvidence: "provider_text" },
    {
      capabilityKind: "model_not_supported",
      capabilityEvidence: "provider_code",
      vendorCode: "model_not_supported",
    },
  ])("only demotes capability evidence without explicit model_not_found: %j", async (context) => {
    const f = await refusing();
    f.failureContext.a = { ...refusal, ...context };
    await f.run();
    expect(f.capabilities.live()).toMatchObject([{ profile_id: "a", state: "provisional" }]);
    expect(f.unusable.live()).toEqual([]);
  });
  it("prefers a listed account over a preferred advisory miss, retaining all-miss fallback", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.catalogModels.a = [];
    const first = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(first.dispatch.route?.credentialProfileId).toBe("b");
    expect(first.routing?.selectionReason).toBe("listed");
    f.catalogModels.b = [];
    const fallback = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(fallback.dispatch.route?.credentialProfileId).toBe("a");
    expect(fallback.routing?.selectionReason).toBe("unlisted_fallback");
  });
  it("marks immediately, yields a preferred account, and confirms only a correlated successful retry", async () => {
    const f = await refusing();
    const first = await f.run();
    expect(first.problem).toMatchObject({
      code: "model_capability_refused",
      retryable: false,
      context: {
        retryOnOtherAccount: true,
        accountMode: "auto",
        credentialProfileId: "a",
        requestedModel: "test-model",
        operationId: first.id,
      },
    });
    expect(f.capabilities.live()[0]?.state).toBe("provisional");
    expect(f.unusable.live()).toEqual([]);
    const second = await f.run(
      { mode: "auto", preferredProfileId: "a" },
      { retryOfOperationId: first.id },
    );
    expect(second.state).toBe("succeeded");
    expect(second.dispatch.route?.credentialProfileId).toBe("b");
    expect(second.routing?.differentialOutcome).toBe("confirmed");
    expect(f.capabilities.live()[0]?.state).toBe("confirmed");
    expect(
      (await f.run({ mode: "auto", preferredProfileId: "a" })).dispatch.route?.credentialProfileId,
    ).toBe("b");
    delete f.failures.a;
    expect(
      (await f.run({ mode: "auto" }, { model: "different-model" })).dispatch.route
        ?.credentialProfileId,
    ).toBe("a");
    expect(f.capabilities.live()).toHaveLength(1);
  });
  it("an equivalent refusal returns the original problem and retains both provisional marks", async () => {
    const f = await refusing();
    f.failures.b = "model_capability_refused";
    f.failureContext.b = { ...refusal, providerReason: "B cannot serve this model either" };
    const first = await f.run();
    const second = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    expect(second.problem).toMatchObject({
      code: first.problem!.code,
      message: first.problem!.message,
      context: {
        credentialProfileId: "a",
        retryOnOtherAccount: false,
        differentialOutcome: "equivalent_refusal",
        accountsTried: [{ credentialProfileId: "a" }, { credentialProfileId: "b" }],
      },
    });
    expect(f.capabilities.live()).toMatchObject([
      { profile_id: "a", state: "provisional", provider_reason: refusal.providerReason },
      {
        profile_id: "b",
        state: "provisional",
        provider_reason: "B cannot serve this model either",
      },
    ]);
    // Both also order last for Agent runs of this model, through the shared observation.
    expect(
      f.refusals
        .live()
        .map((row) => row.profile_id)
        .sort(),
    ).toEqual(["a", "b"]);
    const third = await f.run({ mode: "auto" }, { retryOfOperationId: second.id });
    expect(third.problem?.code).toBe("model_retry_invalid");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it("a pin never rotates or creates a mark, and no alternative means retryOnOtherAccount=false", async () => {
    const f = await refusing();
    const pin = await f.run({ mode: "pin", profileId: "a" });
    expect(pin.problem?.context).toMatchObject({
      retryOnOtherAccount: false,
      accountMode: "pin",
      accountsTried: [{ credentialProfileId: "a" }],
    });
    expect(pin.routing?.selectionReason).toBe("pinned");
    expect(f.capabilities.live()).toEqual([]);
    f.cfg.credential_profiles[1]!.enabled = false;
    expect((await f.run()).problem?.context.retryOnOtherAccount).toBe(false);
    expect(f.invoke.mock.calls.map(([, ctx]) => ctx.profile.profile_id)).toEqual(["a", "a"]);
  });
  it("withholds the retry signal when history continuation is bound to the refusing account", async () => {
    const withHistory = (credentialProfileId: string): Partial<ModelCallRequest> => ({
      messages: [
        { role: "user", content: "earlier question" },
        {
          role: "assistant",
          content: "earlier answer",
          nativeContinuation: {
            route: {
              source: "codex",
              credentialProfileId,
              accountFingerprint: null,
              model: "earlier-model",
            },
            format: "codex.responses.v1",
            payload: [],
          },
        },
        { role: "user", content: "next question" },
      ],
    });
    const f = await refusing();
    const blocked = await f.run({ mode: "auto" }, withHistory("a"));
    expect(blocked.problem?.context).toMatchObject({
      credentialProfileId: "a",
      retryOnOtherAccount: false,
      retryBlockedBy: "native_continuation",
    });
    expect(blocked.routing?.differentialOutcome).toBe("provisional");
    expect(f.capabilities.live()).toMatchObject([{ profile_id: "a", state: "provisional" }]);
    const retry = await f.run(
      { mode: "auto" },
      { ...withHistory("a"), retryOfOperationId: blocked.id },
    );
    expect(retry.problem?.code).toBe("model_retry_invalid");
    expect(f.invoke).toHaveBeenCalledTimes(1);

    // Predicate-only: this mocked adapter accepts history bound to b on account a.
    // The real Codex transport rejects such history locally with
    // invalid_continuation, so only the blocking predicate is checked here; a
    // top-level turn continuation resets on a new route and never blocks.
    const open = await refusing();
    const elsewhere = await open.run(
      { mode: "auto" },
      {
        ...withHistory("b"),
        nativeContinuation: {
          route: {
            source: "codex",
            credentialProfileId: "a",
            accountFingerprint: null,
            model: "test-model",
          },
          format: "codex.turn.v1",
          payload: { turnState: "turn-state" },
        },
      },
    );
    expect(elsewhere.problem?.context.retryOnOtherAccount).toBe(true);
    expect(elsewhere.problem?.context).not.toHaveProperty("retryBlockedBy");
  });
  it("keeps a history-bound preferred account first while it is unmarked, even when unlisted", async () => {
    const bound = (credentialProfileId: string): Partial<ModelCallRequest> => ({
      messages: [
        { role: "user", content: "earlier question" },
        {
          role: "assistant",
          content: "earlier answer",
          nativeContinuation: {
            route: {
              source: "codex",
              credentialProfileId,
              accountFingerprint: null,
              model: "test-model",
            },
            format: "codex.responses.v1",
            payload: [],
          },
        },
        { role: "user", content: "next question" },
      ],
    });
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.catalogModels.a = [];
    const kept = await f.run({ mode: "auto", preferredProfileId: "a" }, bound("a"));
    expect(kept.dispatch.route?.credentialProfileId).toBe("a");
    expect(kept.routing?.selectionReason).toBe("preferred");
    // Without bound history, or bound to another account, listed-first still applies.
    const unbound = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(unbound.dispatch.route?.credentialProfileId).toBe("b");
    expect(unbound.routing?.selectionReason).toBe("listed");
    const elsewhere = await f.run({ mode: "auto", preferredProfileId: "a" }, bound("b"));
    expect(elsewhere.dispatch.route?.credentialProfileId).toBe("b");
    // A marked preferred account yields even when the history is bound to it.
    f.failures.a = "model_capability_refused";
    f.failureContext.a = refusal;
    const refused = await f.run({ mode: "auto", preferredProfileId: "a" }, bound("a"));
    expect(refused.problem?.context).toMatchObject({
      retryOnOtherAccount: false,
      retryBlockedBy: "native_continuation",
    });
    const moved = await f.run({ mode: "auto", preferredProfileId: "a" }, bound("a"));
    expect(moved.dispatch.route?.credentialProfileId).toBe("b");
    expect(moved.routing?.selectionReason).toBe("listed");
  });
  it("names one stable mark episode until success clears it", async () => {
    const f = await refusing();
    const first = await f.run();
    const started = f.capabilities.live()[0]!.observed_at;
    expect(first.problem?.context).toMatchObject({
      alternativeRemains: true,
      modelMarks: [{ credentialProfileId: "a", since: started, state: "provisional" }],
    });
    // A later refusal of the same mark (only "a" is left) renews it, not the episode.
    f.cfg.credential_profiles[1]!.enabled = false;
    f.clock.now += 60_000;
    const renewed = await f.run();
    expect(renewed.dispatch.route?.credentialProfileId).toBe("a");
    expect(renewed.problem?.context).toMatchObject({
      alternativeRemains: false,
      modelMarks: [{ credentialProfileId: "a", since: started }],
    });
    // Success ends the episode; the next refusal starts a new one.
    delete f.failures.a;
    expect((await f.run()).state).toBe("succeeded");
    expect(f.capabilities.live()).toEqual([]);
    f.failures.a = "model_capability_refused";
    f.clock.now += 60_000;
    const again = await f.run();
    const restarted = (again.problem?.context.modelMarks as Array<{ since: string }>)[0]!.since;
    expect(restarted).not.toBe(started);
    expect(restarted).toBe(f.capabilities.live()[0]!.observed_at);
  });
  it("lists every live mark of the model and says when no unmarked account is left", async () => {
    const f = await refusing();
    f.failures.b = "model_capability_refused";
    f.failureContext.b = { ...refusal, providerReason: "B cannot serve this model either" };
    const first = await f.run();
    f.clock.now += 1_000;
    const second = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    const marks = Object.fromEntries(
      f.capabilities.live().map((m) => [m.profile_id, m.observed_at]),
    );
    expect(marks.a).not.toBe(marks.b);
    expect(second.problem?.context).toMatchObject({ alternativeRemains: false });
    expect(
      [...(second.problem?.context.modelMarks as Array<Record<string, unknown>>)].sort((x, y) =>
        String(x.credentialProfileId).localeCompare(String(y.credentialProfileId)),
      ),
    ).toMatchObject([
      { credentialProfileId: "a", since: marks.a, providerReason: refusal.providerReason },
      {
        credentialProfileId: "b",
        since: marks.b,
        providerReason: "B cannot serve this model either",
      },
    ]);
    // Later helpers that land on a marked fallback report the same set.
    const later = await f.run();
    expect(
      (later.problem?.context.modelMarks as Array<{ since: string }>).map((m) => m.since).sort(),
    ).toEqual([marks.a, marks.b].sort());
  });
  const unrecognized = { httpStatus: 400, vendorCode: "invalid_request_error" };
  it("demotes any refusing account at once, offers one retry, and confirms a mark only when another account serves", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.failures.a = "invalid_request";
    f.failureContext.a = unrecognized;
    const first = await f.run();
    expect(first.problem).toMatchObject({
      code: "invalid_request",
      context: {
        capabilityKind: "unclassified",
        generationStarted: false,
        retryOnOtherAccount: true,
        accountMode: "auto",
        credentialProfileId: "a",
        operationId: first.id,
        accountsTried: [
          {
            credentialProfileId: "a",
            capabilityKind: "unclassified",
            providerReason: "fixture refusal (invalid_request_error)",
          },
        ],
      },
    });
    // Structural diagnostics only, and the context never repeats the message.
    expect(first.problem?.context).not.toHaveProperty("markObservedAt");
    expect(first.problem?.context).not.toHaveProperty("providerReason");
    expect(f.capabilities.live()).toEqual([]);
    expect(f.refusals.live()).toMatchObject([{ profile_id: "a", requested_model: "test-model" }]);
    const second = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    expect(second.state).toBe("succeeded");
    expect(second.dispatch.route?.credentialProfileId).toBe("b");
    expect(second.routing?.differentialOutcome).toBe("confirmed");
    expect(f.capabilities.live()).toMatchObject([
      {
        profile_id: "a",
        state: "confirmed",
        provider_reason: "fixture refusal (invalid_request_error)",
      },
    ]);
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
    expect(f.unusable.live()).toEqual([]);
  });
  it("marks nothing when the other account refuses too, yet both accounts order last for the model", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.failures.a = "invalid_request";
    f.failureContext.a = unrecognized;
    f.failures.b = "invalid_request";
    f.failureContext.b = { ...unrecognized };
    const first = await f.run();
    const second = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    expect(second.problem).toMatchObject({
      code: "invalid_request",
      context: {
        credentialProfileId: "b",
        retryOnOtherAccount: false,
        differentialOutcome: "inconclusive",
        retryOfOperationId: first.id,
        accountsTried: [{ credentialProfileId: "a" }, { credentialProfileId: "b" }],
      },
    });
    expect(second.routing?.differentialOutcome).toBe("inconclusive");
    expect(f.capabilities.live()).toEqual([]);
    expect(
      f.refusals
        .live()
        .map((row) => row.profile_id)
        .sort(),
    ).toEqual(["a", "b"]);
    const third = await f.run({ mode: "auto" }, { retryOfOperationId: second.id });
    expect(third.problem?.code).toBe("model_retry_invalid");
  });
  it("orders a recently refusing listed account after an unlisted one, and success clears it", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.catalogModels.b = [];
    f.failures.a = "invalid_request";
    f.failureContext.a = unrecognized;
    const first = await f.run();
    expect(first.dispatch.route?.credentialProfileId).toBe("a");
    const next = await f.run();
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    expect(next.routing?.selectionReason).toBe("unlisted_fallback");
    delete f.failures.a;
    f.cfg.credential_profiles[1]!.enabled = false;
    expect((await f.run()).state).toBe("succeeded");
    expect(f.refusals.live()).toEqual([]);
  });
  it("tries a recently refusing account before one that cannot serve the model", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.failures.a = "model_capability_refused";
    f.failureContext.a = refusal;
    f.cfg.credential_profiles[1]!.enabled = false;
    await f.run();
    expect(f.capabilities.live()).toMatchObject([{ profile_id: "a" }]);
    f.cfg.credential_profiles[1]!.enabled = true;
    // B lists the model and serves it, but one request of its was refused.
    f.failures.b = "invalid_request";
    f.failureContext.b = unrecognized;
    const refused = await f.run();
    expect(refused.dispatch.route?.credentialProfileId).toBe("b");
    // A refusal-only alternative grants no retry; B itself has no mark, so this is
    // not "every account is marked" for a host.
    expect(refused.problem?.context).toMatchObject({
      retryOnOtherAccount: false,
      alternativeRemains: false,
      modelMarks: [{ credentialProfileId: "a" }],
    });
    delete f.failures.b;
    const next = await f.run();
    expect(next.state).toBe("succeeded");
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    expect(f.refusals.live().map((row) => row.profile_id)).toEqual(["a"]);
  });
  it("keeps a refusal-only account as an alternative for alternativeRemains", async () => {
    const f = await refusing();
    f.refusals.record({ harness_id: "codex", profile_id: "b", requested_model: "test-model" });
    const refused = await f.run();
    expect(refused.dispatch.route?.credentialProfileId).toBe("a");
    expect(refused.problem?.context).toMatchObject({
      retryOnOtherAccount: false,
      alternativeRemains: true,
    });
  });
  it("does not let an older in-flight refusal undo a newer request's service", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.cfg.credential_profiles[1]!.enabled = false;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementationOnce(async (request, context) => {
      started();
      await gate;
      f.failures.a = "invalid_request";
      f.failureContext.a = unrecognized;
      const result = await invoke(request, context);
      delete f.failures.a;
      return result;
    });
    const older = f.run();
    await active;
    expect((await f.run()).state).toBe("succeeded");
    release();
    expect((await older).problem?.code).toBe("invalid_request");
    expect(f.refusals.live()).toEqual([]);
  });
  it.each([
    ["HTTP 403", "provider_refused", { httpStatus: 403 }],
    ["an unrecognized HTTP 404", "invalid_request", { httpStatus: 404 }],
    ["HTTP 413", "invalid_request", { httpStatus: 413 }],
    ["HTTP 422 naming no parameter", "invalid_request", { httpStatus: 422 }],
  ] as const)(
    "treats %s before generation as a refusal that may be the account's",
    async (_n, code, context) => {
      const f = await fixture({ inventoryAbsence: "advisory" });
      f.failures.a = code;
      f.failureContext.a = { ...context };
      const done = await f.run();
      expect(done.problem?.context).toMatchObject({
        capabilityKind: "unclassified",
        retryOnOtherAccount: true,
      });
      expect(f.refusals.live()).toMatchObject([{ profile_id: "a" }]);
    },
  );
  it("grants no retry onto an account that answered with another model, yet counts it as left", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.served.b = "other-model";
    const substituted = await f.run({ mode: "auto", preferredProfileId: "b" });
    expect(substituted.dispatch.route).toMatchObject({
      credentialProfileId: "b",
      model: "other-model",
    });
    delete f.served.b;
    f.failures.a = "model_capability_refused";
    f.failureContext.a = refusal;
    const refused = await f.run();
    expect(refused.dispatch.route?.credentialProfileId).toBe("a");
    expect(refused.problem?.context).toMatchObject({
      retryOnOtherAccount: false,
      alternativeRemains: true,
    });
  });
  it("orders a listed account that answered with another model after an unlisted one", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.catalogModels.b = [];
    f.served.a = "other-model";
    const first = await f.run();
    expect(first.dispatch.route).toMatchObject({ credentialProfileId: "a", model: "other-model" });
    const next = await f.run();
    expect(next.dispatch.route?.credentialProfileId).toBe("b");
    expect(next.routing?.selectionReason).toBe("unlisted_fallback");
  });
  it.each([
    ["a pinned account", "invalid_request", { httpStatus: 400 }, { mode: "pin", profileId: "a" }],
    ["sign-in", "auth_required", { httpStatus: 401 }, { mode: "auto" }],
    ["a rate limit", "rate_limited", { httpStatus: 429 }, { mode: "auto" }],
    ["quota", "subscription_window_exhausted", { httpStatus: 400 }, { mode: "auto" }],
    ["a server failure", "provider_failed", { httpStatus: 503 }, { mode: "auto" }],
    ["a stream error", "invalid_request", {}, { mode: "auto" }],
    [
      "an exceeded context",
      "invalid_request",
      { httpStatus: 400, vendorCode: "context_length_exceeded" },
      { mode: "auto" },
    ],
    [
      "a named request parameter",
      "invalid_request",
      { httpStatus: 400, parameter: "temperature" },
      { mode: "auto" },
    ],
    ["an unsupported parameter", "unsupported_parameter", { httpStatus: 400 }, { mode: "auto" }],
    ["the processing fallback", "processing_unavailable", { httpStatus: 400 }, { mode: "auto" }],
    ["sign-in by its code alone", "auth_required", { httpStatus: 400 }, { mode: "auto" }],
    ["sign-in by its status alone", "invalid_request", { httpStatus: 401 }, { mode: "auto" }],
    ["a rate limit by its code alone", "rate_limited", { httpStatus: 400 }, { mode: "auto" }],
    ["a rate limit by its status alone", "invalid_request", { httpStatus: 429 }, { mode: "auto" }],
    ["a timeout", "invalid_request", { httpStatus: 408 }, { mode: "auto" }],
    ["a conflict", "invalid_request", { httpStatus: 409 }, { mode: "auto" }],
    ["a revoked sign-in by its code alone", "auth_revoked", { httpStatus: 400 }, { mode: "auto" }],
    [
      "an invalid continuation by its code alone",
      "invalid_continuation",
      { httpStatus: 400 },
      { mode: "auto" },
    ],
  ] as const)(
    "keeps %s out of the unrecognized-refusal path",
    async (_name, code, context, account) => {
      const f = await fixture({ inventoryAbsence: "advisory" });
      f.failures.a = code;
      f.failureContext.a = { ...context };
      f.cfg.credential_profiles[1]!.enabled = false;
      const done = await f.run(account as ModelCallRequest["account"]);
      expect(done.problem?.code).toBe(code);
      expect(done.problem?.context).not.toHaveProperty("retryOnOtherAccount");
      expect(f.refusals.live()).toEqual([]);
      expect(f.capabilities.live()).toEqual([]);
    },
  );
  it("keeps the 4.4.0 strict shapes for clients that ask for no routing evidence", async () => {
    const f = await refusing();
    const legacy = await f.run({ mode: "auto" }, {}, false);
    // Capability facts in problem.context stay ungated: the retry grant needs no flag.
    expect(legacy.problem?.context.retryOnOtherAccount).toBe(true);
    expect(legacy).not.toHaveProperty("routing");
    expect(() =>
      ControlModelOperationDetail.omit({ routing: true }).strict().parse(legacy),
    ).not.toThrow();
    const { bytes } = await f.services.routes.readModelResult(legacy.id);
    const result = JSON.parse(bytes.toString("utf8"));
    expect(result).not.toHaveProperty("routing");
    expect(() => ModelCallResult.omit({ routing: true }).strict().parse(result)).not.toThrow();
    const evidence = await f.routingStatus();
    expect(evidence).not.toHaveProperty("capabilities");
    expect(() =>
      ControlAccountRoutingEvidenceResponse.omit({ capabilities: true }).strict().parse(evidence),
    ).not.toThrow();
    // Only a client that asks receives the field (its rows are covered by the HTTP consumer test).
    expect(await f.routingStatus({ capabilities: true })).toHaveProperty("capabilities");
    const routed = await f.run();
    expect(routed.routing?.selectionReason).toBeDefined();
  });
  it.each(["provisional", "confirmed", "probe_due", "probing"])(
    "does not offer a fresh retry when the only alternative is %s",
    async (state) => {
      const f = await refusing();
      f.failures.b = "model_capability_refused";
      f.failureContext.b = refusal;
      const prior = await f.run({ mode: "auto", preferredProfileId: "b" });
      if (state === "confirmed") f.capabilities.settleRetry(prior.id, "confirmed");
      if (state === "probe_due" || state === "probing") f.clock.now += 4 * 60 * 60_000;
      if (state === "probing") {
        const catalog = await f.catalog({
          profile: f.profiles[1]!,
          signal: new AbortController().signal,
        });
        expect(
          f.capabilities.reserve(
            f.capabilities.bind("codex", catalog, "test-model"),
            "other-probe",
          ),
        ).toBe(true);
      }
      expect(f.capabilities.state("codex", "b", "test-model")).toBe(state);
      const first = await f.run({ mode: "auto", preferredProfileId: "a" });
      expect(first.problem?.context.retryOnOtherAccount).toBe(false);
      expect(first.dispatch.route?.credentialProfileId).toBe("a");
      expect(f.invoke).toHaveBeenCalledTimes(2);
    },
  );
  it("allows a marked account as the last fallback instead of disabling it", async () => {
    const f = await refusing();
    await f.run();
    f.cfg.credential_profiles[1]!.enabled = false;
    const next = await f.run();
    expect(next.dispatch.route?.credentialProfileId).toBe("a");
    expect(next.routing?.selectionReason).toBe("marked_fallback");
    expect(f.profiles[0]!.enabled).toBe(true);
  });
  it.each(["invalid_request", "unsupported_parameter", "transport_unknown"])(
    "does not mark or suggest a capability retry for %s",
    async (code) => {
      const f = await fixture();
      f.failures.a = code;
      f.failureContext.a = {};
      const result = await f.run();
      expect(result.problem?.code).toBe(code);
      expect(result.problem?.context.retryOnOtherAccount).toBeUndefined();
      expect(f.capabilities.live()).toEqual([]);
    },
  );
  it("does not mark a refusal after output or on an unknown outcome", async () => {
    const f = await refusing();
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (req, ctx) => ({
      ...(await invoke(req, ctx)),
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cached_input_tokens: null,
        cache_write_tokens: null,
        reasoning_tokens: null,
      },
    }));
    await f.run();
    expect(f.capabilities.live()).toEqual([]);
    f.invoke.mockImplementation(async (req, ctx) => ({
      ...(await invoke(req, ctx)),
      outcome: "unknown",
    }));
    await f.run();
    expect(f.capabilities.live()).toEqual([]);
  });
  it("reads existing pre-progress refusal memory and clears it on service", async () => {
    const f = await fixture();
    f.refusals.record({ harness_id: "codex", profile_id: "a", requested_model: "test-model" });
    const first = await f.run();
    expect(first.dispatch.route?.credentialProfileId).toBe("b");
    expect(first.routing?.poolEvents.length).toBeGreaterThan(0);
    await f.run({ mode: "pin", profileId: "a" });
    expect(f.refusals.live()).toEqual([]);
  });
  it("probes after four hours and clears on observed catalog change before expiry", async () => {
    const f = await refusing();
    await f.run();
    f.clock.now += 4 * 60 * 60_000;
    delete f.failures.a;
    const probe = await f.run();
    expect(probe.dispatch.route?.credentialProfileId).toBe("a");
    expect(probe.routing?.selectionReason).toBe("probe");
    expect(f.capabilities.live()).toEqual([]);
    f.failures.a = "model_capability_refused";
    await f.run();
    delete f.failures.a;
    f.catalogModels.a = [model(), model("new-model")];
    // The refusal's own observation orders a after b, so b serves; the next read of
    // a's changed catalog clears the mark, and a serves once it is the only account.
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
    f.cfg.credential_profiles[1]!.enabled = false;
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("a");
    expect(f.capabilities.live()).toEqual([]);
    expect(f.refusals.live()).toEqual([]);
  });
  it.each(["disabled", "unmarked", "marked"])(
    "a concurrent call still dispatches while a probes and b is %s",
    async (other) => {
      const f = await refusing();
      await f.run();
      f.clock.now += 4 * 60 * 60_000;
      if (other === "disabled") f.cfg.credential_profiles[1]!.enabled = false;
      if (other === "marked") {
        f.failures.b = "model_capability_refused";
        f.failureContext.b = refusal;
        await f.run({ mode: "auto", preferredProfileId: "b" });
        delete f.failures.b;
      }
      const invoke = f.invoke.getMockImplementation()!;
      let signalStarted!: () => void;
      let finishProbe!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
      f.invoke.mockImplementationOnce(async (req, ctx) => {
        const result = await invoke(req, ctx);
        signalStarted();
        await finish;
        return result;
      });
      const probe = f.run();
      await started;
      try {
        expect(f.capabilities.state("codex", "a", "test-model")).toBe("probing");
        delete f.failures.a;
        const concurrent = await f.run();
        expect(concurrent.state).toBe("succeeded");
        expect(concurrent.dispatch.route?.credentialProfileId).toBe(
          other === "disabled" ? "a" : "b",
        );
        expect(concurrent.routing?.selectionReason).toBe(
          other === "unmarked" ? "listed" : "marked_fallback",
        );
      } finally {
        finishProbe();
        await probe;
      }
      // The older probe's refusal cannot resurrect evidence cleared by newer service.
      if (other === "disabled") expect(f.capabilities.live()).toEqual([]);
    },
  );
  it("uses an unmarked advisory miss before a listed expired mark on a correlated retry", async () => {
    const f = await refusing();
    f.cfg.credential_profiles.push({
      ...f.profiles[1]!,
      profile_id: "c",
      isolation_locator: join(f.root, "c"),
    });
    f.catalogModels.c = [];
    f.failures.b = "model_capability_refused";
    f.failureContext.b = refusal;
    await f.run({ mode: "auto", preferredProfileId: "b" });
    f.clock.now += 4 * 60 * 60_000;
    const first = await f.run({ mode: "auto", preferredProfileId: "a" });
    expect(first.dispatch.route?.credentialProfileId).toBe("a");
    expect(f.capabilities.state("codex", "b", "test-model")).toBe("probe_due");
    // The retry signal must scan past B's expired row to find clean C.
    expect(first.problem?.context.retryOnOtherAccount).toBe(true);
    const retry = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    expect(retry.dispatch.route?.credentialProfileId).toBe("c");
    expect(retry.routing?.selectionReason).toBe("unlisted_fallback");
    expect(f.capabilities.state("codex", "b", "test-model")).toBe("probe_due");
  });
  it("reads the marks after discovery, so a mark a sibling's catalog change clears is not reported", async () => {
    const f = await fixture({ inventoryAbsence: "advisory" });
    f.cfg.credential_profiles.push({
      ...f.profiles[1]!,
      profile_id: "c",
      isolation_locator: join(f.root, "c"),
    });
    f.catalogModels.c = [model()];
    // C is marked while it is the only account.
    f.cfg.credential_profiles[0]!.enabled = false;
    f.cfg.credential_profiles[1]!.enabled = false;
    f.failures.c = "model_capability_refused";
    f.failureContext.c = refusal;
    await f.run();
    expect(f.capabilities.live()).toMatchObject([{ profile_id: "c" }]);
    delete f.failures.c;
    f.cfg.credential_profiles[0]!.enabled = true;
    f.cfg.credential_profiles[1]!.enabled = true;
    f.failures.a = "invalid_request";
    f.failureContext.a = unrecognized;
    f.failures.b = "model_capability_refused";
    f.failureContext.b = refusal;
    const first = await f.run();
    expect(first.dispatch.route?.credentialProfileId).toBe("a");
    expect(first.problem?.context.retryOnOtherAccount).toBe(true);
    // C's catalog changes before the retry leg's discovery reads it.
    f.catalogModels.c = [model(), model("new-model")];
    const second = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
    expect(second.dispatch.route?.credentialProfileId).toBe("b");
    expect(second.problem?.context).toMatchObject({
      alternativeRemains: true,
      modelMarks: [{ credentialProfileId: "b" }],
    });
    expect(second.problem?.context.modelMarks).toHaveLength(1);
    expect(f.capabilities.live().map((mark) => mark.profile_id)).toEqual(["b"]);
  });
  it("keeps a received success when capability evidence maintenance fails", async () => {
    const f = await fixture();
    vi.spyOn(f.capabilities, "served").mockImplementation(() => {
      throw new Error("evidence failed");
    });
    const result = await f.run();
    expect(result.state).toBe("succeeded");
    expect(result.routing?.selectionReason).toBe("listed");
  });
  it("serves while a login holds the credential window and keeps earlier marks", async () => {
    const f = await refusing();
    const first = await f.run();
    expect(first.problem?.context.retryOnOtherAccount).toBe(true);
    expect(f.capabilities.live()).toMatchObject([{ profile_id: "a", state: "provisional" }]);
    delete f.failures.a;
    bindCredentialMutationWindow(() => true);
    try {
      // A retry signalled before the window stays claimable; nothing settles.
      const retry = await f.run({ mode: "auto" }, { retryOfOperationId: first.id });
      expect(retry.state).toBe("succeeded");
      expect(retry.dispatch.route?.credentialProfileId).toBe("b");
      expect(retry.routing?.differentialOutcome).toBeUndefined();
      const auto = await f.run();
      expect(auto.state).toBe("succeeded");
      expect(auto.dispatch.route?.credentialProfileId).toBe("b");
      const pinned = await f.run({ mode: "pin", profileId: "a" });
      expect(pinned.state).toBe("succeeded");
      expect(pinned.dispatch.route?.credentialProfileId).toBe("a");
      // Unknown generations record and forget nothing.
      expect(f.capabilities.live()).toMatchObject([{ profile_id: "a", state: "provisional" }]);
    } finally {
      bindCredentialMutationWindow(null);
    }
    expect(f.capabilities.state("codex", "a", "test-model")).toBe("provisional");
  });
  it("does not dispatch a catalog observed across a credential mutation", async () => {
    const f = await fixture();
    const catalog = f.catalog.getMockImplementation()!;
    f.catalog.mockImplementation(async (context) => {
      const result = await catalog(context);
      f.capabilities.credentials.clearSubject("codex", context.profile.profile_id);
      return result;
    });
    expect((await f.run()).problem?.code).toBe("auth_changed");
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("reaches serving C after A and B refuse equivalently through the real Codex adapter", async () => {
    const posts: string[] = [];
    const reason =
      "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
    const adapter = createCodexModelAdapter({
      clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
      readAuthFile: async (path) => {
        const id = basename(dirname(path));
        const jwt = (value: unknown) =>
          `fixture.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: id,
            access_token: jwt({ exp: 2100000000 }),
            id_token: jwt({
              sub: id,
              "https://api.openai.com/auth": { chatgpt_plan_type: id === "c" ? "pro" : "free" },
            }),
          },
        });
      },
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ models: [{ slug: "gpt-6.1-sol" }] });
        const id = new Headers(init.headers).get("chatgpt-account-id")!;
        posts.push(id);
        if (id !== "c") return Response.json({ detail: reason }, { status: 400 });
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "served by C" }] }], usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`,
        );
      },
    });
    const f = await fixture({ adapter });
    f.cfg.credential_profiles.push({
      ...f.profiles[1]!,
      profile_id: "c",
      isolation_locator: join(f.root, "c"),
    });
    process.env.CLAUDEXOR_CONFIG_DIR = f.root;
    updateGlobalConfig(() => f.cfg);
    for (const [id, used] of [
      ["a", 0.01],
      ["b", 0.02],
      ["c", 0.4],
    ] as const)
      f.quota.upsert(
        QuotaSnapshot.parse({
          subject: {
            harness: "codex",
            subject_id: id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          constraints: [
            {
              id: "five_hour",
              label: "5h",
              used_ratio: used,
              window_seconds: 18000,
              resets_at: null,
              cooldown_until: null,
            },
          ],
          source: "codex_app_server",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        }),
      );
    const first = await f.run({ mode: "auto" }, { model: "gpt-6.1-sol" });
    expect(first.problem?.context).toMatchObject({
      credentialProfileId: "a",
      retryOnOtherAccount: true,
    });
    const retry = await f.run(
      { mode: "auto" },
      { model: "gpt-6.1-sol", retryOfOperationId: first.id },
    );
    expect(retry.problem).toMatchObject({
      code: first.problem!.code,
      message: first.problem!.message,
      context: {
        credentialProfileId: "a",
        providerReason: reason,
        retryOnOtherAccount: false,
        differentialOutcome: "equivalent_refusal",
        accountsTried: [
          { credentialProfileId: "a", providerReason: reason },
          { credentialProfileId: "b", providerReason: reason },
        ],
      },
    });
    expect(retry.routing?.differentialOutcome).toBe("equivalent_refusal");
    expect(f.capabilities.live()).toMatchObject([
      { profile_id: "a", state: "provisional" },
      { profile_id: "b", state: "provisional" },
    ]);
    const third = await f.run({ mode: "auto" }, { model: "gpt-6.1-sol" });
    expect(third.state).toBe("succeeded");
    expect(third.dispatch.route?.credentialProfileId).toBe("c");
    expect(third.routing?.selectionReason).toBe("listed");
    expect(posts).toEqual(["a", "b", "c"]);
    expect(f.unusable.live()).toEqual([]);
    expect(f.cfg.credential_profiles.every((profile) => profile.enabled)).toBe(true);
  });
  it("serves the real Codex HTTP refusal through daemon operations, receipts and Accounts status", async () => {
    const posts: Array<{ account: string; body: unknown }> = [];
    const adapter = createCodexModelAdapter({
      clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
      now: () => Date.now(),
      readAuthFile: async (path) => {
        const id = basename(dirname(path));
        const jwt = (value: unknown) =>
          `fixture.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
        return JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: id,
            access_token: jwt({ exp: 2100000000 }),
            id_token: jwt({
              sub: id,
              "https://api.openai.com/auth": { chatgpt_plan_type: id === "a" ? "free" : "pro" },
            }),
          },
        });
      },
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ models: [{ slug: "gpt-6.1-sol" }] });
        const account = new Headers(init.headers).get("chatgpt-account-id")!;
        posts.push({ account, body: JSON.parse(await requestBodyText(init)) });
        if (account === "a")
          return Response.json(
            {
              detail:
                "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
            },
            { status: 400 },
          );
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-6.1-sol", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "served by B" }] }], usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`,
        );
      },
    });
    const f = await fixture({ adapter });
    process.env.CLAUDEXOR_CONFIG_DIR = f.root;
    updateGlobalConfig(() => f.cfg);
    for (const [id, used] of [
      ["a", 0.01],
      ["b", 0.4],
    ] as const)
      f.quota.upsert(
        QuotaSnapshot.parse({
          subject: {
            harness: "codex",
            subject_id: id,
            credential_route: "vendor_native",
            plan_label: null,
          },
          constraints: [
            {
              id: "five_hour",
              label: "5h",
              used_ratio: used,
              window_seconds: 18000,
              resets_at: null,
              cooldown_until: null,
            },
          ],
          source: "codex_app_server",
          observed_at: new Date().toISOString(),
          freshness: "fresh",
        }),
      );
    const { DaemonControlApiServer } = await import("../../control-api/src/daemon-server.js");
    const api = new DaemonControlApiServer({
      token: "fixture-control",
      daemon: f.client,
      services: { ...f.services.routes, accountRoutingEvidence: f.routingStatus },
    });
    const address = await api.start();
    cleanups.push(() => api.stop());
    const endpoint = `http://${address.host}:${address.port}/v2`;
    const headers = {
      Authorization: "Bearer fixture-control",
      "X-Claudexor-Protocol-Major": "3",
      "Content-Type": "application/json",
    };
    const run = async (account: ModelCallRequest["account"], retryOfOperationId?: string) => {
      const input = ModelCallRequest.parse({
        source: "codex",
        model: "gpt-6.1-sol",
        account,
        messages: [{ role: "user", content: "hello" }],
        ...(retryOfOperationId ? { retryOfOperationId } : {}),
      });
      const request = f.resources().publishModel(Buffer.from(JSON.stringify(input)));
      const response = await fetch(`${endpoint}/model-operations?captureRoutingEvidence=true`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ request }),
      });
      expect(response.ok).toBe(true);
      const started = (await response.json()) as { id: string };
      await vi.waitFor(
        async () =>
          expect(["queued", "running"]).not.toContain(
            (await f.services.routes.getModelOperation(started.id)).state,
          ),
        { timeout: 10000 },
      );
      const inspected = await fetch(`${endpoint}/model-operations/${started.id}`, { headers });
      return (await inspected.json()) as Awaited<ReturnType<typeof f.run>>;
    };
    const first = await run({ mode: "auto" });
    expect(first.problem).toMatchObject({
      code: "model_capability_refused",
      context: {
        httpStatus: 400,
        credentialProfileId: "a",
        requestedModel: "gpt-6.1-sol",
        generationStarted: false,
        retryOnOtherAccount: true,
        accountMode: "auto",
        accountsTried: [
          {
            credentialProfileId: "a",
            providerReason:
              "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
          },
        ],
        nextStep: expect.any(String),
      },
    });
    expect(posts.map((p) => p.account)).toEqual(["a"]);
    const second = await run({ mode: "auto" }, first.id);
    expect(second.state).toBe("succeeded");
    expect(second.dispatch.route?.credentialProfileId).toBe("b");
    expect(second.routing?.differentialOutcome).toBe("confirmed");
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    const status = ControlAccountRoutingEvidenceResponse.parse(
      await (
        await fetch(`${endpoint}/accounts/routing-evidence?includeCapabilities=true`, { headers })
      ).json(),
    );
    expect(status.capabilities).toMatchObject([
      {
        profile_id: "a",
        requested_model: "gpt-6.1-sol",
        state: "confirmed",
        provider_reason: expect.any(String),
        observed_at: expect.any(String),
        expires_at: expect.any(String),
      },
    ]);
    const third = await run({ mode: "auto" });
    expect(third.dispatch.route?.credentialProfileId).toBe("b");
    expect(third.routing?.selectionReason).toBe("listed");
    const pin = await run({ mode: "pin", profileId: "a" });
    expect(pin.problem?.context.retryOnOtherAccount).toBe(false);
    expect(pin.routing?.selectionReason).toBe("pinned");
    expect(posts.map((p) => p.account)).toEqual(["a", "b", "b", "a"]);
    expect(f.unusable.live()).toEqual([]);
    expect(f.profiles.every((p) => p.enabled)).toBe(true);
  });
});

async function readinessFixture() {
  const root = mkdtempSync(join(process.env.CLAUDEXOR_CONFIG_DIR!, "readiness-"));
  const home = join(root, "profile");
  mkdirSync(home);
  writeFileSync(join(home, "auth.json"), "fixture login identity");
  writeFileSync(join(home, "config.toml"), "fixture settings");
  const bin = join(root, "codex");
  writeFileSync(bin, "#!/bin/sh\necho codex 0.156.1\n", { mode: 0o755 });
  const previous = process.env.CLAUDEXOR_CODEX_BIN;
  process.env.CLAUDEXOR_CODEX_BIN = bin;
  const clock = { now: Date.now(), mutating: false };
  const profile = CredentialProfile.parse({
    profile_id: "ready",
    harness_id: "codex",
    display_name: "Ready",
    credential_kind: "config_dir_login",
    isolation_locator: home,
  });
  const probe = vi.fn(
    async (
      candidate: CredentialProfile,
      _signal?: AbortSignal,
    ): Promise<CredentialProfileStatus> => ({
      profile_id: candidate.profile_id,
      harness_id: candidate.harness_id,
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      last_verified_at: new Date(clock.now).toISOString(),
    }),
  );
  const adapter = { ...createCodexAdapter(), probeCredentialProfile: probe };
  const publishProgram = async () => {
    const observed = await observeHarnessProgram(adapter.program, undefined, undefined, {
      probe: false,
    });
    programObservationPublisher(adapter.program!)({ ...observed.selection!, version: "0.156.1" });
  };
  await publishProgram();
  const credentials = new CredentialGeneration(() => clock.mutating);
  const owner = new ModelLoginReadiness(credentials);
  const call = (signal = new AbortController().signal) => owner.probe(profile, adapter, signal);
  cleanups.push(async () => {
    owner.close();
  });
  removals.push(() => {
    if (previous === undefined) delete process.env.CLAUDEXOR_CODEX_BIN;
    else process.env.CLAUDEXOR_CODEX_BIN = previous;
    invalidateProgramObservations("codex");
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    bin,
    profile,
    probe,
    adapter,
    clock,
    credentials,
    owner,
    call,
    publishProgram,
  };
}

describe("admission-grade login readiness", () => {
  it.each(["auth.json", "config.toml", "program", "profile", "generation", "login_window"])(
    "reuses unchanged positive probes, but probes once after %s changes",
    async (change) => {
      const f = await readinessFixture();
      const first = await f.call();
      expect(await f.call()).toEqual(first);
      expect(f.probe).toHaveBeenCalledTimes(1);
      if (change === "auth.json" || change === "config.toml")
        writeFileSync(join(f.home, change), "changed fixture identity");
      if (change === "program") {
        writeFileSync(f.bin, "#!/bin/sh\necho codex 0.156.1 # replaced\n");
        await f.publishProgram();
      }
      if (change === "profile") f.profile.display_name = "Renamed";
      if (change === "generation") f.credentials.clearSubject("codex", "ready");
      if (change === "login_window") f.clock.mutating = true;
      await f.call();
      expect(f.probe).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "negative",
    "unknown",
    "failed",
    "undated",
    "stale",
    "unknown_program",
    "unknown_files",
    "unknown_generation",
  ])("never reuses %s readiness", async (basis) => {
    const f = await readinessFixture();
    const raw = f.probe.getMockImplementation()!;
    f.probe.mockImplementation(async (profile, signal) => ({
      ...(await raw(profile, signal)),
      ...(basis === "negative" ? { availability: "unavailable" as const } : {}),
      ...(basis === "unknown" ? { availability: "unknown" as const } : {}),
      ...(basis === "failed" ? { verification: "failed" as const } : {}),
      ...(basis === "undated" ? { last_verified_at: null } : {}),
      ...(basis === "stale" ? { stale: true } : {}),
    }));
    if (basis === "unknown_program") f.adapter.program = undefined;
    if (basis === "unknown_generation") f.clock.mutating = true;
    if (basis === "unknown_files") rmSync(join(f.home, "auth.json"));
    await f.call();
    await f.call();
    expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it("expires from the physical probe date; hits never extend it", async () => {
    const f = await readinessFixture();
    const date = vi.spyOn(Date, "now").mockImplementation(() => f.clock.now);
    try {
      const first = await f.call();
      f.clock.now += DOCTOR_TTL_MS - 1;
      expect((await f.call()).last_verified_at).toBe(first.last_verified_at);
      expect(f.probe).toHaveBeenCalledTimes(1);
      f.clock.now += 2;
      expect((await f.call()).last_verified_at).not.toBe(first.last_verified_at);
      expect(f.probe).toHaveBeenCalledTimes(2);
    } finally {
      date.mockRestore();
    }
  });
  it("shares a raw probe, keeps the remaining reader, and cancels when all leave", async () => {
    const f = await readinessFixture();
    const raw = f.probe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.probe.mockImplementationOnce(async (profile, signal) => {
      await gate;
      return raw(profile, signal);
    });
    const one = new AbortController(),
      two = new AbortController();
    const a = f.call(one.signal).catch((e) => e),
      b = f.call(two.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
    // Both readers have completed their asynchronous file identity reads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    one.abort();
    await a;
    expect(f.probe.mock.calls[0]![1]!.aborted).toBe(false);
    two.abort();
    await b;
    expect(f.probe.mock.calls[0]![1]!.aborted).toBe(true);
    release();
    await f.call();
    expect(f.probe).toHaveBeenCalledTimes(2);
    await f.call();
    expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it("a generation change ends a pending probe, asks once more under the new identity, and never retains the late answer", async () => {
    const f = await readinessFixture();
    const raw = f.probe.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.probe.mockImplementationOnce(async (profile, signal) => {
      await gate;
      return { ...(await raw(profile, signal)), detail: "late answer" };
    });
    const pending = f.call().catch((e) => e);
    await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
    f.credentials.clearSubject("codex", "ready");
    expect(await pending).toMatchObject({ availability: "available", verification: "passed" });
    expect(f.probe.mock.calls[0]![1]!.aborted).toBe(true);
    expect(f.probe).toHaveBeenCalledTimes(2);
    release();
    expect((await f.call()).detail).not.toBe("late answer");
    await f.call();
    expect(f.probe).toHaveBeenCalledTimes(2);
  });
  it("uses readiness on repeated selection, reads the catalog each time, and overlays vendor revocation without probing", async () => {
    const ready = await readinessFixture();
    const f = await fixture({ lazy: true, nativeAdapter: ready.adapter });
    f.cfg.credential_profiles[0]!.isolation_locator = ready.home;
    await f.services.routes.modelCatalog("codex", "a");
    await f.services.routes.modelCatalog("codex", "a");
    expect(ready.probe).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(2);
    const beforeRevocation = f.quota.read();
    vi.spyOn(f.quota, "read").mockReturnValue({
      ...beforeRevocation,
      absences: [
        QuotaAbsence.parse({
          subject: { harness: "codex", credential_route: "vendor_native", subject_id: "a" },
          reason: "auth_revoked",
          observed_at: new Date().toISOString(),
          detail: "fixture revocation",
        }),
      ],
    });
    await expect(f.services.routes.modelCatalog("codex", "a")).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(ready.probe).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(2);
  });
  it.each(["unchanged", "changed"])(
    "a pin admits a probe answer whose login identity was %s during the probe",
    async (identity) => {
      const ready = await readinessFixture();
      const f = await fixture({ lazy: true, nativeAdapter: ready.adapter });
      f.cfg.credential_profiles[0]!.isolation_locator = ready.home;
      const raw = ready.probe.getMockImplementation()!;
      ready.probe.mockImplementationOnce(async (profile, signal) => {
        if (identity === "changed") writeFileSync(join(ready.home, "auth.json"), "refreshed");
        return raw(profile, signal);
      });
      expect((await f.services.routes.modelCatalog("codex", "a")).credentialProfileId).toBe("a");
      await f.services.routes.modelCatalog("codex", "a");
      // Only an answer under one unchanged identity is reused.
      expect(ready.probe).toHaveBeenCalledTimes(identity === "changed" ? 2 : 1);
    },
  );
  it.each(["claude", "codex"])(
    "a %s program change ends only that harness's in-flight probes and positives",
    async (harness) => {
      const f = await readinessFixture();
      const raw = f.probe.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let abortedWhileRunning: boolean | undefined;
      f.probe.mockImplementationOnce(async (profile, signal) => {
        await gate;
        abortedWhileRunning = signal!.aborted;
        return raw(profile, signal);
      });
      const pending = f.call().catch((e) => e);
      await vi.waitFor(() => expect(f.probe).toHaveBeenCalledTimes(1));
      invalidateProgramObservations(harness);
      await f.publishProgram();
      release();
      // Ended or not, the caller is answered: a Codex change by one probe under the new identity.
      expect(await pending).toMatchObject({ availability: "available" });
      await vi.waitFor(() => expect(abortedWhileRunning).toBe(harness === "codex"));
      await f.call();
      expect(f.probe).toHaveBeenCalledTimes(harness === "codex" ? 2 : 1);
      invalidateProgramObservations(harness);
      await f.publishProgram();
      await f.call();
      expect(f.probe).toHaveBeenCalledTimes(harness === "codex" ? 3 : 1);
    },
  );
  it.each(["its login window closes", "its caller leaves"])(
    "a pinned probe in flight when %s",
    async (event) => {
      const ready = await readinessFixture();
      const f = await fixture({ lazy: true, nativeAdapter: ready.adapter });
      f.cfg.credential_profiles[0]!.isolation_locator = ready.home;
      const raw = ready.probe.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let abortedWhileRunning: boolean | undefined;
      ready.probe.mockImplementationOnce(async (profile, signal) => {
        await gate;
        abortedWhileRunning = signal!.aborted;
        return raw(profile, signal);
      });
      let loginWindow = true;
      bindCredentialMutationWindow(() => loginWindow);
      try {
        const caller = new AbortController();
        const pending = f.services.routes
          .modelCatalog("codex", "a", undefined, false, caller.signal)
          .catch((e) => e);
        await vi.waitFor(() => expect(ready.probe).toHaveBeenCalledTimes(1));
        if (event === "its caller leaves") caller.abort(new Error("caller left"));
        else {
          loginWindow = false;
          f.unusable.noteCredentialChange();
        }
        release();
        const result = await pending;
        await vi.waitFor(() => expect(abortedWhileRunning).toBe(true));
        // A lifecycle is answered by one more probe under the new identity; a
        // departed caller ends its probe as before, with no second one.
        expect(result).toMatchObject(
          event === "its caller leaves" ? { message: "caller left" } : { credentialProfileId: "a" },
        );
        expect(ready.probe).toHaveBeenCalledTimes(event === "its caller leaves" ? 1 : 2);
      } finally {
        bindCredentialMutationWindow(null);
      }
    },
  );
});

describe("fresh decisions after catalog waits", () => {
  it.each(["unchanged", "quota", "refusal", "disabled"])(
    "rechecks %s evidence after waiting",
    async (change) => {
      const f = await fixture({ lazy: true });
      const raw = f.catalog.getMockImplementation()!;
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const active = new Promise<void>((resolve) => {
        started = resolve;
      });
      const reads = new SharedRead<Awaited<ReturnType<ModelAdapter["catalog"]>>>();
      const physical = vi.fn(async (context: Parameters<ModelAdapter["catalog"]>[0]) => {
        if (context.profile.profile_id === "a") {
          started();
          await gate;
        }
        return raw(context);
      });
      f.catalog.mockImplementation((context) =>
        reads.read(
          context.profile.profile_id,
          JSON.stringify([context.profile, context.credentialGeneration]),
          context.signal,
          (signal) => physical({ ...context, signal }),
        ),
      );
      const pending = Promise.all([
        f.services.routes.modelCatalog("codex", undefined, "test-model"),
        f.services.routes.modelCatalog("codex", undefined, "test-model"),
      ]);
      await active;
      await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(2));
      expect(physical).toHaveBeenCalledTimes(1);
      if (change === "refusal")
        f.refusals.record({ harness_id: "codex", profile_id: "a", requested_model: "test-model" });
      if (change === "disabled") f.cfg.credential_profiles[0]!.enabled = false;
      if (change === "quota")
        f.quota.upsert(
          QuotaSnapshot.parse({
            subject: { harness: "codex", credential_route: "vendor_native", subject_id: "a" },
            constraints: [
              {
                id: "session",
                label: "Session",
                window_seconds: null,
                used_ratio: 1,
                resets_at: new Date(Date.now() + 60000).toISOString(),
              },
            ],
            source: "codex_app_server",
            observed_at: new Date().toISOString(),
            freshness: "fresh",
          }),
        );
      release();
      expect((await pending).map((result) => result.credentialProfileId)).toEqual(
        change === "unchanged" ? ["a", "a"] : ["b", "b"],
      );
    },
  );
  const unavailable = () =>
    Object.assign(new Error("transport limit"), {
      problem: ControlProblem.parse({
        code: "catalog_unavailable",
        message: "catalog transport limit",
        retryable: true,
      }),
    });
  const spent = (harness: string, subject: string, resetsAt = Date.now() + 60_000) =>
    QuotaSnapshot.parse({
      subject: { harness, credential_route: "vendor_native", subject_id: subject },
      constraints: [
        {
          id: "session",
          label: "Session",
          window_seconds: null,
          used_ratio: 1,
          resets_at: new Date(resetsAt).toISOString(),
        },
      ],
      source: harness === "codex" ? "codex_app_server" : "claude_oauth_usage",
      observed_at: new Date().toISOString(),
      freshness: "fresh",
    });
  const reads = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.catalog.mock.calls.map(([context]) => context.profile.profile_id);
  it.each(["unchanged", "changed"])(
    "typed catalog transport failure moves Auto to its next candidate while facts are %s",
    async (facts) => {
      const f = await fixture({ lazy: true });
      f.catalog.mockImplementationOnce(async () => {
        if (facts === "changed") f.quota.upsert(spent("claude", "work"));
        throw unavailable();
      });
      expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("b");
      expect(reads(f)).toEqual(["a", "b"]);
      expect((await f.services.routes.modelCatalog("codex")).credentialProfileId).toBe("a");
    },
  );
  it.each(["claude quota", "account b quota", "account b refusal", "account b disabled"])(
    "keeps a read account and reads it once when %s changes during its read",
    async (change) => {
      const f = await fixture({ lazy: true });
      const raw = f.catalog.getMockImplementation()!;
      f.catalog.mockImplementationOnce(async (context) => {
        if (change === "claude quota") f.quota.upsert(spent("claude", "work"));
        if (change === "account b quota") f.quota.upsert(spent("codex", "b"));
        if (change === "account b refusal")
          f.refusals.record({
            harness_id: "codex",
            profile_id: "b",
            requested_model: "test-model",
          });
        if (change === "account b disabled") f.cfg.credential_profiles[1]!.enabled = false;
        return raw(context);
      });
      const selected = await f.services.routes.modelCatalog("codex", undefined, "test-model");
      expect(selected.credentialProfileId).toBe("a");
      expect(reads(f)).toEqual(["a"]);
    },
  );
  it.each(["nothing", "its quota exhausted", "its harness disabled"])(
    "a pin with %s during its read gets the typed outcome of an immediate repeat",
    async (change) => {
      const f = await fixture({ lazy: true });
      const raw = f.catalog.getMockImplementation()!;
      f.catalog.mockImplementationOnce(async (context) => {
        if (change === "its quota exhausted") f.quota.upsert(spent("codex", "a"));
        if (change === "its harness disabled")
          f.cfg.harnesses.codex = GlobalConfig.parse({
            harnesses: { codex: { enabled: false } },
          }).harnesses.codex!;
        return raw(context);
      });
      const outcome = async () => {
        const result = await f.services.routes.modelCatalog("codex", "a").catch((e) => e);
        const { code, message, problem, credentialProfileId } = result;
        return { code, message, problem, credentialProfileId };
      };
      const first = await outcome();
      expect(first).toEqual(await outcome());
      expect(first).toMatchObject(
        change === "nothing"
          ? { credentialProfileId: "a" }
          : change === "its harness disabled"
            ? { code: "model_source_unavailable" }
            : {
                code: "subscription_window_exhausted",
                problem: { context: { resetsAt: expect.any(String) } },
              },
      );
    },
  );
  it.each(["a and b", "b"])(
    "after a catalog refusal, final quota facts blocking %s give the outcome of an immediate repeat",
    async (blocked) => {
      const f = await fixture({ lazy: true });
      const raw = f.catalog.getMockImplementation()!;
      const resetsAt = Date.now() + 3_600_000;
      f.catalog.mockImplementation(async (context) => {
        if (context.profile.profile_id === "a") throw unavailable();
        for (const id of blocked === "b" ? ["b"] : ["a", "b"])
          f.quota.upsert(spent("codex", id, resetsAt));
        return raw(context);
      });
      const first = await f.services.routes.modelCatalog("codex").catch((e) => e);
      const repeat = await f.services.routes.modelCatalog("codex").catch((e) => e);
      expect(first.problem).toEqual(repeat.problem);
      expect(first.problem).toMatchObject(
        blocked === "b"
          ? { code: "credential_pool_exhausted", context: { poolCause: "unavailable" } }
          : {
              code: "subscription_window_exhausted",
              context: { poolCause: "quota", resetsAt: new Date(resetsAt).toISOString() },
            },
      );
    },
  );
  it.each(["bare managed secret", "default subject", "row"])(
    "a %s change during a named row's catalog read ends it only for that row",
    async (change) => {
      const f = await fixture({ lazy: true });
      const raw = f.catalog.getMockImplementation()!;
      let physical!: AbortSignal;
      f.catalog.mockImplementationOnce(async (context) => {
        physical = context.signal;
        if (change === "bare managed secret") f.unusable.clearDefaultSubjects();
        if (change === "default subject") f.unusable.clearSubject("codex", null);
        if (change === "row") f.unusable.clearSubject("codex", "a");
        return raw(context);
      });
      const result = await f.services.routes.modelCatalog("codex", "a").catch((e) => e);
      expect(physical.aborted).toBe(change === "row");
      expect(result).toMatchObject(
        change === "row" ? { code: "auth_changed" } : { credentialProfileId: "a" },
      );
    },
  );
  it("passes catalog cancellation and shutdown to raw work", async () => {
    const f = await fixture({ lazy: true });
    let received!: AbortSignal;
    f.catalog.mockImplementationOnce(async ({ signal }) => {
      received = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const controller = new AbortController();
    const pending = f.services.routes
      .modelCatalog("codex", "a", undefined, false, controller.signal)
      .catch((e) => e);
    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    await pending;
    expect(received.aborted).toBe(true);
    await expect(f.services.routes.modelCatalog("codex", "a")).resolves.toMatchObject({
      credentialProfileId: "a",
    });
    f.catalog.mockImplementationOnce(async ({ signal }) => {
      received = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const stopped = f.services.routes.modelCatalog("codex", "a").catch((e) => e);
    await vi.waitFor(() => expect(received.aborted).toBe(false));
    f.services.close();
    await stopped;
    expect(received.aborted).toBe(true);
  });
});

it("shutdown ends a durable operation's pending catalog independently of its creating connection", async () => {
  const f = await fixture();
  let entered!: () => void, physical!: AbortSignal;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.catalog.mockImplementationOnce(async ({ signal }) => {
    physical = signal;
    entered();
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("catalog stopped")), { once: true }),
    );
  });
  const operation = f.run({ mode: "pin", profileId: "a" });
  await active;
  expect(physical.aborted).toBe(false);
  f.services.close();
  expect(physical.aborted).toBe(true);
  expect((await operation).dispatch.state).toBe("not_started");
  expect(f.invoke).not.toHaveBeenCalled();
});

it("keeps preparation timing inspection opt-in and exposes measured selection phases", async () => {
  const f = await fixture();
  const done = await f.run();
  expect(done).not.toHaveProperty("preparation");
  const timed = await f.services.routes.getModelOperation(done.id, true);
  expect(timed.preparation!.steps).toMatchObject({
    payloadRead: { count: 1 },
    payloadParse: { count: 1 },
    admission: { count: 1 },
    loginProbe: { count: 2 },
    catalogRead: { count: 1 },
    selection: { count: 1 },
    reserve: { count: 1 },
  });
  expect(timed.preparation!.totalMs).toBeGreaterThanOrEqual(
    timed.preparation!.steps.catalogRead!.totalMs,
  );
});

it("counts reused login readiness apart from physical probes", async () => {
  const ready = await readinessFixture();
  const f = await fixture({ nativeAdapter: ready.adapter });
  f.cfg.credential_profiles[0]!.isolation_locator = ready.home;
  const steps = async () => {
    const done = await f.run({ mode: "pin", profileId: "a" });
    return (await f.services.routes.getModelOperation(done.id, true)).preparation!.steps;
  };
  const probed = await steps();
  expect(probed.loginProbe).toMatchObject({ count: 1 });
  expect(probed).not.toHaveProperty("loginReady");
  const reused = await steps();
  expect(reused.loginReady).toMatchObject({ count: 1 });
  expect(reused).not.toHaveProperty("loginProbe");
});
