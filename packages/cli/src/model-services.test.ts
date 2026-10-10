import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CredentialUnusableLedger,
  DaemonClient,
  DaemonServer,
  ModelSubstitutionLedger,
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
  isModelOperation,
  type CredentialProfileStatus,
  type ModelCatalogEntry,
  type ModelInventoryAbsence,
} from "@claudexor/schema";
import type { ModelAdapter } from "@claudexor/core";
import { accountObservations } from "./account-observations.js";

beforeEach(() => accountObservations.invalidate());

import { createModelServices } from "./model-services.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
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
  } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-ms-")));
  const sql = await sqlFixture(root);
  const commands = sql.graph.commands;
  const quota = new QuotaRegistry(sql.graph.globalEvents);
  const unusable = new CredentialUnusableLedger();
  const clock = { now: Date.now() };
  const substitutions = new ModelSubstitutionLedger(() => new Date(clock.now));
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
    migrationGate: () => null,
    registry: new Map([["codex", { ...createCodexAdapter(), probeCredentialProfile: probe }]]),
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
  cleanups.push(async () => {
    services.close();
    await server.stop();
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = async (account: ModelCallRequest["account"] = { mode: "auto" }) => {
    const ref = resources().publishModel(
      Buffer.from(
        JSON.stringify(
          ModelCallRequest.parse({
            source: "codex",
            model: "test-model",
            account,
            messages: [{ role: "system", content: "own prompt" }],
          }),
        ),
      ),
    );
    const started = await services.routes.createModelOperation(ref, randomUUID());
    await vi.waitFor(async () =>
      expect(["queued", "running"]).not.toContain(
        (await services.routes.getModelOperation(started.id)).state,
      ),
    );
    return services.routes.getModelOperation(started.id);
  };
  return {
    root,
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
  it("retains a dispatched model refusal at model scope while an unqualified catalog remains usable", async () => {
    const f = await fixture();
    f.failures.a = "model_unavailable";
    f.failureContext.a = { httpStatus: 404, vendorCode: "model_not_found" };
    const failed = await f.run({ mode: "pin", profileId: "a" });
    expect(failed.problem?.code).toBe("model_unavailable");
    expect(f.unusable.live()).toMatchObject([
      { profile_id: "a", model: "test-model", code: "capability_refused" },
    ]);
    expect((await f.run()).dispatch.route?.credentialProfileId).toBe("b");
    await expect(f.services.routes.modelCatalog("codex", "a")).resolves.toMatchObject({
      credentialProfileId: "a",
    });
  });

  it("does not turn a generic pre-dispatch model preparation failure into an account restriction", async () => {
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
        cost: { knowledge: "unknown", billing: "unknown", source: "fixture", provenance: [] },
        appliedOptions: {},
        problem: { code: "model_unavailable", message: "preparation failed", retryable: false },
      }),
    );
    await f.run({ mode: "pin", profileId: "a" });
    expect(f.unusable.live()).toEqual([]);
    expect((await f.run({ mode: "pin", profileId: "a" })).state).toBe("succeeded");
  });

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
      const body = JSON.parse(await new Response(init.body).text());
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
    await vi.waitFor(async () =>
      expect((await f.services.routes.getModelOperation(started.id)).state).toBe("succeeded"),
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
    const readQuota = f.quota.read.bind(f.quota);
    vi.spyOn(f.quota, "read").mockImplementation(() => {
      const state = readQuota();
      return {
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
      };
    });
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
    const gc = f.services.withRetention(async (request) =>
      ControlGcReceipt.parse({
        dry_run: request.dry_run,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        policy: { runs_max_age_days: 30, reviews_max_age_days: 14, keep_last_runs_per_project: 1 },
        examined_runs: 0,
        kept: {},
        freed_bytes: 0,
      }),
    );
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
