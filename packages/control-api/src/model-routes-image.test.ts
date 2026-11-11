import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import AjvModule from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlModelOperationDetail,
  ControlModelSourcesAccountsResponse,
  ImageCallRequest,
  ImageCallResult,
  ModelUsage,
} from "@claudexor/schema";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
const require = createRequire(import.meta.url);
const Ajv = AjvModule.default ?? (AjvModule as unknown as typeof AjvModule.default);
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const ref = { resourceId: "resource-image", sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 7 };
const detail = () =>
  ControlModelOperationDetail.parse({
    id: "job-image",
    state: "queued",
    createdAt: "2026-10-08T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    dispatch: { state: "not_started", startedAt: null, route: null },
    response: { state: "absent" },
    usage: ModelUsage.parse({}),
    cost: null,
    problem: null,
  });
async function fixture(services: DaemonControlApiOptions["services"]) {
  const server = new DaemonControlApiServer({
    token: "image-test-control",
    daemon: { enqueue: vi.fn(), status: vi.fn(), list: vi.fn(async () => []), cancel: vi.fn() },
    services,
  });
  servers.push(server);
  const address = await server.start();
  return (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer image-test-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

describe("image model operations over HTTP", () => {
  it("passes requestKind=image through and refuses the evidence-flag combination", async () => {
    const createModelOperation = vi.fn(async () => detail());
    const request = await fixture({ createModelOperation });
    const accepted = await request(
      "/model-operations?requestKind=image",
      { request: ref },
      { "Idempotency-Key": "img" },
    );
    expect(accepted.status).toBe(202);
    expect(createModelOperation).toHaveBeenLastCalledWith(
      ref,
      "img",
      undefined,
      undefined,
      "image",
    );
    const plain = await request(
      "/model-operations",
      { request: ref },
      { "Idempotency-Key": "txt" },
    );
    expect(plain.status).toBe(202);
    expect(createModelOperation).toHaveBeenLastCalledWith(ref, "txt");
    for (const flag of [
      "captureEffortEvidence",
      "captureFailureEvidence",
      "captureRoutingEvidence",
    ]) {
      const refused = await request(
        `/model-operations?requestKind=image&${flag}=true`,
        { request: ref },
        { "Idempotency-Key": "img-flag" },
      );
      expect(refused.status).toBe(400);
    }
    const unknownKind = await request(
      "/model-operations?requestKind=video",
      { request: ref },
      { "Idempotency-Key": "img-kind" },
    );
    expect(unknownKind.status).toBe(400);
    expect(createModelOperation).toHaveBeenCalledTimes(2);
  });

  it("publishes exported payload schemas separately from the actual image query value", () => {
    const create = OPERATION_CATALOG.operations.find(
      (operation) => operation.method === "POST" && operation.path === "/v2/model-operations",
    );
    expect(create?.parameters).toContainEqual(
      expect.objectContaining({
        name: "requestKind",
        location: "query",
        enum: ["image"],
        schemaRef: null,
      }),
    );
    const parameter = create!.parameters.find((entry) => entry.name === "requestKind")!;
    const documented = JSON.parse(
      readFileSync(new URL("../../../docs/reference/endpoints.json", import.meta.url), "utf8"),
    ).endpoints.find(
      (entry: { method: string; path: string }) =>
        entry.method === "POST" && entry.path === "/v2/model-operations",
    );
    expect(
      documented.parameters.find((entry: { name: string }) => entry.name === "requestKind"),
    ).toMatchObject({
      enum: ["image"],
      schema_ref: null,
      description: parameter.description,
    });
    const ajv = new Ajv({ strict: false });
    const request = ImageCallRequest.parse({
      source: "codex",
      model: "image-model",
      account: { mode: "auto" },
      prompt: "a fox",
    });
    const result = ImageCallResult.parse({
      outcome: "completed",
      operation: "generate",
      requestedModel: request.model,
      images: [],
      route: { source: "codex", credentialProfileId: "a", accountFingerprint: null, model: null },
      appliedOptions: {},
      usage: {},
      cost: {
        knowledge: "unknown",
        billing: "unknown",
        source: "fixture",
        provenance: ["fixture"],
      },
      providerRequestId: null,
      problem: null,
    });
    for (const [name, payload] of [
      ["ImageCallRequest", request],
      ["ImageCallResult", result],
    ] as const) {
      expect(parameter.description).toContain(name);
      // Resolve through the package export, as an independent client does.
      const schema = JSON.parse(
        readFileSync(require.resolve(`@claudexor/schema/generated/${name}.schema.json`), "utf8"),
      );
      const validate = ajv.compile(schema);
      expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
      expect(validate("image")).toBe(false);
      expect(validate({ ...payload, unexpected: true })).toBe(false);
    }
    const validateQuery = ajv.compile({ type: "string", enum: parameter.enum });
    expect(validateQuery("image")).toBe(true);
    expect(validateQuery(request)).toBe(false);
    expect(validateQuery("video")).toBe(false);
  });

  it("projects a source's image facet only in the negotiated account view", async () => {
    const imageGeneration = {
      models: ["gpt-image-2"],
      modelsProvenance: "fixture",
      inputMimes: ["image/png", "image/jpeg", "image/webp"],
      maxInputImages: 5,
      maxInputImagesProvenance: "fixture",
      supportedOptions: ["size", "quality", "background", "n"],
    };
    const request = await fixture({
      modelSources: vi.fn(async (view?: "accounts") => ({
        sources: [
          {
            id: "codex",
            label: "Codex",
            credentialHarness: "codex",
            ...(view === "accounts"
              ? {
                  processingPreferences: ["standard"],
                  accountCatalog: true,
                  imageGeneration,
                }
              : {}),
          },
        ],
      })),
    });
    const accounts = ControlModelSourcesAccountsResponse.parse(
      await (await request("/model-sources?view=accounts")).json(),
    );
    expect(accounts.sources[0]!.imageGeneration).toEqual(imageGeneration);
    const legacy = (await (await request("/model-sources")).json()) as {
      sources: Record<string, unknown>[];
    };
    expect(legacy.sources[0]).not.toHaveProperty("imageGeneration");
  });
});

it("reads and refreshes image quota scope through the ordinary HTTP quota surface", async () => {
  const result = { snapshots: [], absences: [], refreshed_at: null };
  const quota = vi.fn(async () => result);
  const refreshQuota = vi.fn(async () => result);
  const request = await fixture({ quota, refreshQuota });
  expect((await request("/quota?requestKind=image&model=explicit-image")).status).toBe(200);
  expect(quota).toHaveBeenLastCalledWith({ requestKind: "image", model: "explicit-image" });
  expect((await request("/quota", { requestKind: "image" })).status).toBe(200);
  expect(refreshQuota).toHaveBeenLastCalledWith({ requestKind: "image" });
  expect((await request("/quota?requestKind=unknown")).status).toBe(400);
  expect((await request("/quota?requestKind=image&requestKind=text")).status).toBe(400);
});
