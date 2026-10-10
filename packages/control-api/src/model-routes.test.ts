import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlModelOperationDetail, ModelUsage } from "@claudexor/schema";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { parseCodexModelCatalog } from "../../harness-codex/src/model.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const ref = { resourceId: "resource-test", sha256: `sha256:${"a".repeat(64)}`, sizeBytes: 42 };
const detail = () =>
  ControlModelOperationDetail.parse({
    id: "job-model",
    state: "queued",
    createdAt: "2026-09-06T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    dispatch: { state: "not_started", startedAt: null, route: null },
    response: { state: "absent" },
    usage: ModelUsage.parse({}),
    cost: null,
    problem: null,
  });
async function fixture(services: DaemonControlApiOptions["services"], recovery = false) {
  const daemon = {
    enqueue: vi.fn(),
    status: vi.fn(),
    list: vi.fn(async () => []),
    cancel: vi.fn(),
  };
  const server = new DaemonControlApiServer({
    token: "model-test-control",
    daemon,
    services,
    ...(recovery ? { servingMode: () => "recovery_only" as const } : {}),
  });
  servers.push(server);
  const address = await server.start();
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer model-test-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { request, daemon };
}

describe("raw model operation HTTP surface", () => {
  it("negotiates exact failure capture without changing the body or unrelated query compatibility", async () => {
    const createModelOperation = vi.fn(async () => detail());
    const f = await fixture({ createModelOperation });
    const headers = { "Idempotency-Key": "capture" };
    for (const suffix of ["", "?captureFailureEvidence=false", "?unrelated=ignored"]) {
      expect(
        (await f.request(`/model-operations${suffix}`, { request: ref }, headers)).status,
      ).toBe(202);
      expect(createModelOperation).toHaveBeenLastCalledWith(ref, "capture");
    }
    expect(
      (
        await f.request(
          "/model-operations?captureFailureEvidence=true&unrelated=ignored",
          { request: ref },
          headers,
        )
      ).status,
    ).toBe(202);
    expect(createModelOperation).toHaveBeenLastCalledWith(ref, "capture", true);
    for (const value of ["", "1", "TRUE", "true&captureFailureEvidence=false"]) {
      expect(
        (
          await f.request(
            `/model-operations?captureFailureEvidence=${value}`,
            { request: ref },
            headers,
          )
        ).status,
      ).toBe(400);
    }
    expect(createModelOperation).toHaveBeenCalledTimes(4);
    expect(
      OPERATION_CATALOG.operations.find(
        (op) => op.method === "POST" && op.path === "/v2/model-operations",
      )?.parameters,
    ).toContainEqual(
      expect.objectContaining({
        name: "captureFailureEvidence",
        location: "query",
        enum: ["true", "false"],
      }),
    );
  });
  it("negotiates effort capture independently while preserving omitted/false calls", async () => {
    const createModelOperation = vi.fn(async () => detail());
    const f = await fixture({ createModelOperation });
    const headers = { "Idempotency-Key": "effort" };
    for (const query of ["", "?captureEffortEvidence=false"]) {
      expect((await f.request(`/model-operations${query}`, { request: ref }, headers)).status).toBe(
        202,
      );
      expect(createModelOperation).toHaveBeenLastCalledWith(ref, "effort");
    }
    expect(
      (
        await f.request(
          "/model-operations?captureEffortEvidence=true&unrelated=ignored",
          { request: ref },
          headers,
        )
      ).status,
    ).toBe(202);
    expect(createModelOperation).toHaveBeenLastCalledWith(ref, "effort", undefined, true);
    expect(
      (
        await f.request(
          "/model-operations?captureEffortEvidence=true&captureFailureEvidence=true",
          { request: ref },
          headers,
        )
      ).status,
    ).toBe(202);
    expect(createModelOperation).toHaveBeenLastCalledWith(ref, "effort", true, true);
    for (const value of ["", "1", "TRUE", "true&captureEffortEvidence=false"]) {
      expect(
        (
          await f.request(
            `/model-operations?captureEffortEvidence=${value}`,
            { request: ref },
            headers,
          )
        ).status,
      ).toBe(400);
    }
    expect(createModelOperation).toHaveBeenCalledTimes(4);
    expect(
      OPERATION_CATALOG.operations.find(
        (op) => op.method === "POST" && op.path === "/v2/model-operations",
      )?.parameters,
    ).toContainEqual(
      expect.objectContaining({
        name: "captureEffortEvidence",
        location: "query",
        enum: ["true", "false"],
      }),
    );
  });

  it.each([{ levels: [] }, { levels: ["high", "ultra"] }])(
    "projects the real Codex catalog $levels to both frozen HTTP shapes",
    async ({ levels }) => {
      const models = parseCodexModelCatalog({
        models: [
          { slug: "test-model", supported_reasoning_levels: levels.map((effort) => ({ effort })) },
        ],
      });
      expect(models[0]?.reasoningEffortsVerified).toBe(true);
      const catalog = {
        source: "codex",
        credentialProfileId: "fixture",
        accountFingerprint: null,
        observedAt: "2026-09-12T00:00:00.000Z",
        provenance: "provider_http",
        models,
        clientVersion: "0.156.1",
        clientVersionSource: "verified_transport",
      };
      const accountView = {
        source: "codex",
        accounts: [
          { credentialProfileId: "fixture", availability: "available", problem: null, catalog },
        ],
        partial: false,
      };
      const f = await fixture({
        modelCatalog: async () => catalog,
        modelAccountCatalog: async () => accountView,
      });
      const legacy = await f.request("/model-sources/codex/models");
      expect(legacy.status).toBe(200);
      expect(await legacy.json()).toEqual({
        source: "codex",
        credentialProfileId: "fixture",
        accountFingerprint: null,
        observedAt: "2026-09-12T00:00:00.000Z",
        provenance: "provider_http",
        models: [
          {
            id: "test-model",
            label: null,
            isDefault: false,
            contextWindow: null,
            maxContextWindow: null,
            maxOutputTokens: null,
            inputModalities: [],
            imageInput: false,
            reasoningEfforts: levels.filter((level) => level !== "ultra"),
            defaultReasoningEffort: null,
            supportedOptions: [
              "toolChoice",
              "cacheKey",
              "serviceTier",
              "processingPreference",
              ...(levels.length ? ["reasoningEffort"] : []),
            ],
          },
        ],
      });
      const modern = await f.request("/model-sources/codex/models?view=accounts");
      expect(modern.status).toBe(200);
      const publicModels = models.map(
        ({ reasoningEffortPreferenceOrder: _order, ...model }) => model,
      );
      expect(await modern.json()).toEqual({
        ...accountView,
        accounts: [{ ...accountView.accounts[0], catalog: { ...catalog, models: publicModels } }],
      });
      expect(models[0]?.reasoningEffortsVerified).toBe(true);
      if (levels.length) expect(models[0]?.reasoningEffortPreferenceOrder).toEqual(levels);
    },
  );

  it("requires idempotency before accepting refs and never enqueues an Agent Run", async () => {
    const createModelOperation = vi.fn(async () => detail());
    const f = await fixture({ createModelOperation });
    expect((await f.request("/model-operations", { request: ref })).status).toBe(400);
    expect(createModelOperation).not.toHaveBeenCalled();
    const accepted = await f.request(
      "/model-operations",
      { request: ref },
      { "Idempotency-Key": "stable-operation" },
    );
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual(detail());
    expect(createModelOperation).toHaveBeenCalledWith(ref, "stable-operation");
    expect(f.daemon.enqueue).not.toHaveBeenCalled();
    expect(
      (
        await f.request(
          "/model-operations",
          { request: { ...ref, prompt: "no inline body" } },
          { "Idempotency-Key": "bad" },
        )
      ).status,
    ).toBe(400);
    expect(createModelOperation).toHaveBeenCalledTimes(1);
  });

  it("returns >4MiB exact bytes with no content redaction and no implicit ACK", async () => {
    const bytes = Buffer.from(
      JSON.stringify({ content: "sk-" + "z".repeat(80) + "🦉" + "q".repeat(5 * 1024 * 1024) }),
    );
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const readModelResult = vi.fn(async () => ({ bytes, sha256 }));
    const acknowledgeModelResult = vi.fn(async () => detail());
    const f = await fixture({ readModelResult, acknowledgeModelResult });
    for (let index = 0; index < 2; index++) {
      const response = await f.request("/model-operations/job-model/result");
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(`"${sha256}"`);
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    }
    expect(acknowledgeModelResult).not.toHaveBeenCalled();
    expect((await f.request("/model-operations/job-model/ack", { sha256 })).status).toBe(200);
    expect(acknowledgeModelResult).toHaveBeenCalledWith("job-model", sha256);
  });

  it("retains typed released-result and cancellation responses without regeneration", async () => {
    const getModelOperation = vi.fn(async () => detail());
    const cancelModelOperation = vi.fn(async () => ({ ...detail(), state: "cancelled" }));
    const readModelResult = vi.fn(async () => {
      throw Object.assign(new Error("already released"), {
        code: "model_result_released",
        status: 410,
      });
    });
    const f = await fixture({ getModelOperation, cancelModelOperation, readModelResult });
    expect((await f.request("/model-operations/job-model")).status).toBe(200);
    const gone = await f.request("/model-operations/job-model/result");
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ code: "model_result_released" });
    const cancelled = await f.request("/model-operations/job-model/control", {
      action: "cancel",
      reasonCode: "user_cancelled",
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ state: "cancelled" });
    expect(cancelModelOperation).toHaveBeenCalledWith("job-model", "user_cancelled");
    expect(f.daemon.enqueue).not.toHaveBeenCalled();
  });

  it("keeps raw catalogs account-scoped and leaves omitted profile selection to the engine", async () => {
    let provenance = "fixture";
    const modelSources = vi.fn(async () => ({
      sources: [{ id: "codex", label: "Codex", credentialHarness: "codex" }],
    }));
    const modelCatalog = vi.fn(async (source, profile) => ({
      source,
      credentialProfileId: profile ?? "chosen",
      accountFingerprint: null,
      observedAt: "2026-09-06T00:00:00.000Z",
      provenance,
      clientVersion: "0.156.1",
      clientVersionSource: "verified_transport",
      models: [],
    }));
    const f = await fixture({ modelSources, modelCatalog });
    expect((await f.request("/model-sources")).status).toBe(200);
    const historical = await f.request("/model-sources/codex/models");
    expect(historical.status).toBe(200);
    expect(await historical.json()).toMatchObject({
      provenance: "fixture",
      observedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", undefined, undefined);
    provenance = "provider_http";
    const observed = await f.request("/model-sources/codex/models?credentialProfileId=chosen");
    expect(observed.status).toBe(200);
    // The legacy query keeps its pre-negotiation shape: the declared client
    // version the transport recorded is NOT projected here (the account view
    // below carries it), exactly like `processing` per row.
    expect(await observed.json()).toEqual({
      source: "codex",
      credentialProfileId: "chosen",
      accountFingerprint: null,
      observedAt: "2026-09-06T00:00:00.000Z",
      provenance: "provider_http",
      models: [],
    });
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", "chosen", undefined);
    expect(
      (await f.request("/model-sources/codex/models?requestedModel=exact%2Fmodel%2B1")).status,
    ).toBe(200);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", undefined, "exact/model+1");
    expect(
      (
        await f.request(
          "/model-sources/codex/models?credentialProfileId=chosen&requestedModel=exact-model",
        )
      ).status,
    ).toBe(200);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", "chosen", "exact-model");
    for (const query of [
      "credentialProfileId=a&credentialProfileId=b",
      "account=b",
      "credentialProfileId=",
      "requestedModel=",
      "requestedModel=%20%20",
      "requestedModel=a&requestedModel=b",
    ]) {
      expect((await f.request(`/model-sources/codex/models?${query}`)).status).toBe(400);
    }
    expect(modelCatalog).toHaveBeenCalledTimes(4);
  });

  it("negotiates account catalogs while keeping the strict legacy model shape unchanged", async () => {
    const processing = {
      modes: ["standard", "fast"],
      nativeModes: [{ mode: "fast", id: "priority" }],
      defaultNativeMode: "auto",
      eligible: true,
      source: "provider",
      observedAt: "2026-09-12T00:00:00.000Z",
    };
    const model = {
      id: "test-model",
      label: null,
      isDefault: true,
      contextWindow: 1000000,
      maxContextWindow: 1000000,
      maxOutputTokens: null,
      inputModalities: ["text"],
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      supportedOptions: [],
      processing,
    };
    const catalog = {
      source: "codex",
      credentialProfileId: "a",
      accountFingerprint: null,
      observedAt: "2026-09-12T00:00:00.000Z",
      provenance: "provider_http",
      clientVersion: "0.156.1",
      clientVersionSource: "installed_cli",
      models: [model],
    };
    const accountView = {
      source: "codex",
      accounts: [{ credentialProfileId: "a", availability: "available", problem: null, catalog }],
      partial: false,
    };
    const modelCatalog = vi.fn(async () => catalog);
    const modelAccountCatalog = vi.fn(async () => accountView);
    const source = { id: "codex", label: "Codex", credentialHarness: "codex" };
    const modelSources = vi.fn(async (view?: "accounts") => ({
      sources: [
        view
          ? {
              ...source,
              processingPreferences: ["standard", "fast", "economy"],
              accountCatalog: true,
            }
          : source,
      ],
    }));
    const f = await fixture({ modelCatalog, modelAccountCatalog, modelSources });
    expect(await (await f.request("/model-sources")).json()).toEqual({ sources: [source] });
    expect(await (await f.request("/model-sources?view=accounts")).json()).toMatchObject({
      sources: [{ accountCatalog: true, processingPreferences: ["standard", "fast", "economy"] }],
    });
    const legacy = (await (await f.request("/model-sources/codex/models")).json()) as {
      models: Array<Record<string, unknown>>;
    };
    expect(legacy.models[0]).not.toHaveProperty("processing");
    const modern = await f.request(
      "/model-sources/codex/models?view=accounts&credentialProfileId=a",
    );
    expect(modern.status).toBe(200);
    // The negotiated view carries the declared client version per catalog.
    const modernBody = (await modern.json()) as { accounts: Array<{ catalog: unknown }> };
    expect(modernBody).toEqual(accountView);
    expect(modernBody.accounts[0]?.catalog).toMatchObject({
      clientVersion: "0.156.1",
      clientVersionSource: "installed_cli",
    });
    expect(modelAccountCatalog).toHaveBeenCalledExactlyOnceWith("codex", "a");
    expect(modelCatalog).toHaveBeenCalledTimes(1);
    for (const query of [
      "view=unknown",
      "view=",
      "view=accounts&view=accounts",
      "view=accounts&requestedModel=test",
    ]) {
      expect((await f.request(`/model-sources/codex/models?${query}`)).status).toBe(400);
    }
    for (const query of ["view=unknown", "view=accounts&view=accounts", "extra=true"]) {
      expect((await f.request(`/model-sources?${query}`)).status).toBe(400);
    }
    const descriptor = OPERATION_CATALOG.operations.find(
      (op) => op.path === "/v2/model-sources/:id/models",
    );
    expect(descriptor?.parameters).toContainEqual(
      expect.objectContaining({ name: "view", enum: ["accounts"] }),
    );
    expect(descriptor?.responseSchema).toBe("ControlModelCatalogQueryResponse");
  });

  it("negotiates exact requested-model admission without inventing a model or changing legacy reads", async () => {
    const admission = { requestedModel: "unlisted/model", inventoryAbsence: "advisory" };
    const catalog = {
      source: "codex",
      credentialProfileId: "a",
      accountFingerprint: "a",
      observedAt: "2026-10-09T00:00:00.000Z",
      provenance: "provider_http",
      clientVersion: "0.156.1",
      clientVersionSource: "verified_transport",
      models: [],
      admission,
    };
    const modelCatalog = vi.fn(async () => catalog);
    const f = await fixture({ modelCatalog });
    const path =
      "/model-sources/codex/models?credentialProfileId=a&requestedModel=unlisted%2Fmodel";
    const legacy = await (await f.request(path)).json();
    const explicitFalse = await (await f.request(path + "&includeAdmission=false")).json();
    expect(legacy).toEqual(explicitFalse);
    expect(legacy).not.toHaveProperty("admission");
    expect(legacy).not.toHaveProperty("clientVersion");
    const modern = await f.request(path + "&includeAdmission=true");
    expect(modern.status).toBe(200);
    expect(await modern.json()).toEqual(catalog);
    expect(modelCatalog).toHaveBeenLastCalledWith("codex", "a", "unlisted/model", true);
    const count = modelCatalog.mock.calls.length;
    for (const query of [
      "includeAdmission=true",
      "includeAdmission=wrong&requestedModel=x",
      "includeAdmission=true&includeAdmission=false&requestedModel=x",
      "view=accounts&includeAdmission=true&requestedModel=x",
    ]) {
      expect((await f.request(`/model-sources/codex/models?${query}`)).status).toBe(400);
    }
    expect(modelCatalog).toHaveBeenCalledTimes(count);
    const descriptor = OPERATION_CATALOG.operations.find(
      (row) => row.path === "/v2/model-sources/:id/models",
    );
    expect(descriptor?.parameters).toContainEqual(
      expect.objectContaining({ name: "includeAdmission", enum: ["true", "false"] }),
    );
    const mismatch = await f.request(
      "/model-sources/codex/models?requestedModel=another&includeAdmission=true",
    );
    expect(mismatch.status).toBe(500);
    expect(await mismatch.json()).toMatchObject({ code: "invalid_service_response" });
  });

  it("refuses malformed service output and protects all model routes in recovery mode", async () => {
    const invalid = await fixture({ getModelOperation: async () => ({ id: "lying" }) });
    const response = await invalid.request("/model-operations/job-model");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "invalid_service_response" });
    const createModelOperation = vi.fn(async () => detail());
    const recovery = await fixture({ createModelOperation }, true);
    expect(
      (
        await recovery.request(
          "/model-operations",
          { request: ref },
          { "Idempotency-Key": "recovery" },
        )
      ).status,
    ).toBe(503);
    expect((await recovery.request("/model-sources")).status).toBe(503);
    expect(createModelOperation).not.toHaveBeenCalled();
    const advertised = OPERATION_CATALOG.operations.filter((op) =>
      op.path.startsWith("/v2/model-"),
    );
    expect(advertised).toHaveLength(7);
    expect(
      advertised.find((op) => op.path === "/v2/model-operations" && op.method === "POST"),
    ).toMatchObject({ idempotency: "key_required", completion: "durable_handle" });
  });
});
