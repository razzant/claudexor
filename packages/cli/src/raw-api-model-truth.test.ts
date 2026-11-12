import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonFacadeClient } from "@claudexor/control-api";
import type { HarnessAdapter, ModelCatalogObservation } from "@claudexor/core";
import { createFakeHarness } from "@claudexor/harness-fake";
import {
  ControlHarnessAccountModelsResponse,
  ControlHarnessModelsResponse,
  ControlSettingsUpdateRequest,
  CredentialProfile,
  GlobalConfig,
} from "@claudexor/schema";
import { accountObservations } from "./account-observations.js";
import {
  OPENROUTER_REFUSED_VARIANTS,
  OPENROUTER_ROUTING_VARIANTS,
  buildRegistry,
  checkHarnessModel,
  harnessAccountModels,
  harnessModels,
} from "./registry.js";
import { noProjectRepoRoot } from "@claudexor/util";
import { assertSettingsPatchValid, settingsControlServices } from "./settings-service.js";

const ORIGINAL_ENV = { ...process.env };

function routerAnswers(answer: () => Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const catalog = (data: unknown[]) =>
  routerAnswers(() => new Response(JSON.stringify({ data }), { status: 200 }));

beforeEach(() => {
  accountObservations.invalidate();
  process.env.CLAUDEXOR_OPENROUTER_BASE_URL = "https://router.test/api/v1";
  process.env.OPENROUTER_API_KEY = "sk-router";
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("the openrouter registry instance over its typed catalog (#393, #145, #146)", () => {
  it("declares its routing variants once, in the registry, and the manifest carries them", async () => {
    const manifest = await buildRegistry({ includeFakes: false }).get("openrouter")!.discover();
    expect(manifest.capabilities.model_routing_variants).toEqual(OPENROUTER_ROUTING_VARIANTS);
    expect(OPENROUTER_ROUTING_VARIANTS.map((variant) => variant.suffix)).toEqual([
      ":nitro",
      ":floor",
      ":exacto",
    ]);
    expect(manifest.capabilities.model_refused_variants).toEqual(OPENROUTER_REFUSED_VARIANTS);
    expect(OPENROUTER_REFUSED_VARIANTS).toEqual([
      { suffix: ":online", reason: "provider_web_search" },
    ]);
  });

  it("answers a FAILED read as a typed problem, never as an empty catalog, and forwards the model unverified", async () => {
    routerAnswers(() => new Response("upstream down", { status: 503 }));
    const listing = await harnessModels("openrouter", "/repo", false);
    expect(ControlHarnessModelsResponse.strict().parse(listing)).toEqual({
      harnessId: "openrouter",
      models: [],
      source: "api",
      sourceProgram: null,
      verifiedAgainst: null,
      problem: {
        code: "model_catalog_unavailable",
        message: "the live model catalog could not be read (http_status; HTTP 503: upstream down)",
        retryable: true,
        fieldErrors: {},
        requiredActions: [],
        evidenceRefs: [],
        context: { cause: "http_status", httpStatus: 503 },
      },
    });
    // Settings write / doctor / catalog share this verdict (decision A): the
    // explicit model is admitted unverified, never claimed absent or listed.
    const { check } = await checkHarnessModel("openrouter", "vendor/m", "/repo");
    expect(check).toEqual({
      status: "ok",
      unverified: true,
      message:
        "the live model catalog could not be read (http_status; HTTP 503: upstream down), so " +
        'model "vendor/m" could not be verified; it is sent unchanged on the same key and the ' +
        "provider accepts or refuses it",
    });
    // The declared refused variant still refuses on the same failed read.
    expect((await checkHarnessModel("openrouter", "vendor/m:online", "/repo")).check).toMatchObject(
      { status: "rejected", refusedVariant: { suffix: ":online" } },
    );
  });

  it("admits a settings write an unavailable catalog cannot verify with its note; a rejected key refuses typed", async () => {
    const patch = ControlSettingsUpdateRequest.parse({
      harnesses: { openrouter: { defaultModel: "vendor/m" } },
    });
    const current = { goal: "auto" as const, qualityTiers: {}, harnesses: {} };
    routerAnswers(() => new Response("upstream down", { status: 503 }));
    const notes: string[] = [];
    await assertSettingsPatchValid(patch, current, notes);
    expect(notes).toEqual([
      "harness 'openrouter' defaultModel 'vendor/m' (truth source: api): the live model catalog " +
        'could not be read (http_status; HTTP 503: upstream down), so model "vendor/m" could not ' +
        "be verified; it is sent unchanged on the same key and the provider accepts or refuses it",
    ]);
    routerAnswers(() => new Response("bad key", { status: 401 }));
    const write = assertSettingsPatchValid(patch, current);
    await expect(write).rejects.toMatchObject({
      code: "model_catalog_unavailable",
      status: 409,
      retryable: false,
      context: { cause: "auth_rejected", httpStatus: 401 },
    });
    await expect(write).rejects.toThrow(
      "harness 'openrouter' refused defaultModel 'vendor/m' (truth source: api): the live model " +
        "catalog could not be read (auth_rejected; HTTP 401: bad key), so model " +
        '"vendor/m" cannot be verified',
    );
    // A model a readable catalog does not list keeps the ordinary invalid_request refusal.
    catalog([{ id: "vendor/other" }]);
    await expect(assertSettingsPatchValid(patch, current)).rejects.toMatchObject({
      code: "invalid_request",
      status: 400,
    });
  });

  it("answers POST /settings over real HTTP: persisted with the note on 503, typed 409 on 401", async () => {
    // The catalog is a LOCAL endpoint; the settings write goes through the
    // daemon's own problem projection, as the app and CLI receive it.
    let status = 503;
    const catalogServer = createServer((_req, res) => {
      res.statusCode = status;
      res.end(status === 401 ? "bad key" : "upstream down");
    });
    await new Promise<void>((ready) => catalogServer.listen(0, "127.0.0.1", ready));
    const catalogPort = (catalogServer.address() as AddressInfo).port;
    process.env.CLAUDEXOR_OPENROUTER_BASE_URL = `http://127.0.0.1:${catalogPort}/api/v1`;
    const server = new DaemonControlApiServer({
      token: "fixture",
      daemon: {} as DaemonFacadeClient,
      services: settingsControlServices(noProjectRepoRoot(), undefined, () => {}),
    });
    const { host, port } = await server.start();
    const write = () =>
      fetch(`http://${host}:${port}/v2/settings`, {
        method: "POST",
        headers: { authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" },
        body: JSON.stringify({ harnesses: { openrouter: { defaultModel: "vendor/m" } } }),
      });
    try {
      const unavailable = await write();
      expect(unavailable.status).toBe(200);
      const saved = (await unavailable.json()) as {
        harnesses: Record<string, { defaultModel: string | null }>;
        notes: string[];
      };
      expect(saved.harnesses.openrouter.defaultModel).toBe("vendor/m");
      expect(saved.notes).toEqual([
        expect.stringContaining('model "vendor/m" could not be verified; it is sent unchanged'),
      ]);
      status = 401;
      const rejected = await write();
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        code: "model_catalog_unavailable",
        retryable: false,
        context: { cause: "auth_rejected", httpStatus: 401 },
      });
    } finally {
      await server.stop();
      await new Promise((closed) => catalogServer.close(closed));
    }
  });

  it("distinguishes an auth status in the typed problem", async () => {
    routerAnswers(() => new Response("bad key", { status: 401 }));
    const listing = await harnessModels("openrouter", "/repo", false);
    expect(listing.problem).toMatchObject({
      retryable: false,
      context: { cause: "auth_rejected", httpStatus: 401 },
    });
  });

  it("surfaces model metadata through the listing and judges ids with the declared variants", async () => {
    catalog([
      {
        id: "vendor/m",
        context_length: 65536,
        architecture: { input_modalities: ["text", "image"] },
        top_provider: { max_completion_tokens: 8192 },
      },
      { id: "vendor/free:free" },
    ]);
    const listing = await harnessModels("openrouter", "/repo", false);
    expect(listing.problem).toBeUndefined();
    // The declared suffixes travel with the rows they resolve to (#146).
    expect(listing.routingVariants).toEqual(OPENROUTER_ROUTING_VARIANTS);
    expect(listing.models[0]).toEqual({
      id: "vendor/m",
      label: null,
      context_window: 65536,
      routes: null,
      input_modalities: ["text", "image"],
      max_output_tokens: 8192,
    });
    const judge = async (model: string) =>
      (await checkHarnessModel("openrouter", model, "/repo")).check;
    expect(await judge("vendor/m")).toEqual({ status: "ok", message: null });
    for (const model of [
      "vendor/m:nitro",
      "vendor/m:floor",
      "vendor/m:exacto",
      "vendor/free:free:nitro",
      "vendor/free:nitro:free",
    ])
      expect(await judge(model), model).toMatchObject({ status: "ok", unverified: true });
    for (const model of [
      "vendor/m:online",
      "vendor/m:unknownsuffix",
      "vendor/m:free:nitro",
      "vendor/m:nitro:free",
    ])
      expect((await judge(model)).status, model).toBe("rejected");
  });

  it("refuses a model absent from a SUCCESSFUL empty catalog with an accurate reason", async () => {
    catalog([]);
    const { check } = await checkHarnessModel("openrouter", "vendor/m", "/repo");
    expect(check).toEqual({
      status: "rejected",
      message:
        'model "vendor/m" is not in the harness\'s live model inventory (the catalog lists no models)',
    });
  });

  it("leaves a generic compatible endpoint on exact membership", async () => {
    process.env.OPENAI_API_KEY = "sk-generic";
    process.env.CLAUDEXOR_RAWAPI_BASE_URL = "https://generic.test/v1";
    catalog([{ id: "vendor/m" }]);
    const manifest = await buildRegistry({ includeFakes: false }).get("raw-api")!.discover();
    expect(manifest.capabilities.model_routing_variants).toBeUndefined();
    expect((await checkHarnessModel("raw-api", "vendor/m:nitro", "/repo")).check.status).toBe(
      "rejected",
    );
  });
});

describe("account rows over a typed catalog read (#393)", () => {
  function fixture(read: ModelCatalogObservation) {
    const harnessId = "fake-success";
    const profile = CredentialProfile.parse({
      profile_id: "key-a",
      harness_id: harnessId,
      display_name: "Key A",
      credential_kind: "config_dir_login",
      isolation_locator: "/catalog-fixture/key-a",
    });
    const modelCatalog = vi.fn(async () => read);
    const adapter: HarnessAdapter = {
      ...createFakeHarness(harnessId),
      models: async () => (read.status === "listed" ? read.models : []),
      modelCatalog,
      probeCredentialProfile: async (p) => ({
        profile_id: p.profile_id,
        harness_id: harnessId,
        availability: "available",
        verification: "passed",
        verification_source: "local_store",
        last_verified_at: null,
      }),
    };
    return {
      modelCatalog,
      input: {
        harnessId,
        cwd: "/catalog-fixture",
        config: GlobalConfig.parse({ credential_profiles: [profile] }),
        quota: { snapshots: [], absences: [] },
        registry: new Map([[harnessId, adapter]]),
      },
    };
  }

  it("keeps a failed read's typed cause on the row instead of an empty catalog", async () => {
    const f = fixture({
      status: "unavailable",
      failure: { cause: "network", httpStatus: null, detail: "ECONNRESET" },
    });
    const response = ControlHarnessAccountModelsResponse.parse(await harnessAccountModels(f.input));
    expect(response.partial).toBe(true);
    expect(response.accounts[0]).toMatchObject({
      credentialProfileId: "key-a",
      availability: "unknown",
      catalog: null,
      problem: {
        code: "model_catalog_unavailable",
        retryable: true,
        context: { cause: "network", httpStatus: null },
      },
    });
    expect(f.modelCatalog).toHaveBeenCalledWith({
      cwd: "/catalog-fixture",
      credentialProfile: expect.objectContaining({ profile_id: "key-a" }),
    });
  });

  it("reports a typed SUCCESSFUL empty catalog as an empty catalog, not as unknown", async () => {
    const f = fixture({ status: "listed", models: [] });
    const response = await harnessAccountModels(f.input);
    expect(response.partial).toBe(false);
    expect(response.accounts[0]).toMatchObject({
      availability: "available",
      problem: null,
      catalog: { models: [], source: "api" },
    });
  });
});
