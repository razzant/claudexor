import { expect, it, vi } from "vitest";
import canonical from "../../schema/fixtures/effort-resolution.json" with { type: "json" };
import {
  ControlModelCatalogResponse,
  CredentialProfile,
  ModelCallRequest,
  ModelCallResult,
} from "@claudexor/schema";
import { createCodexModelAdapter, parseCodexModelCatalog } from "./model.js";
import { requestBodyText } from "./test-support/request-body.js";

const FULL_SIBLING = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

function fixture(
  levels: string[] | null = ["low", "max"],
  observed?: string,
  sibling: string[] = FULL_SIBLING,
) {
  const dispatch = vi.fn(async () => {});
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method !== "POST")
      return Response.json({
        models: [
          {
            slug: "target",
            ...(levels ? { supported_reasoning_levels: levels.map((effort) => ({ effort })) } : {}),
          },
          {
            slug: "sibling",
            supported_reasoning_levels: sibling.map((effort) => ({ effort })),
          },
        ],
      });
    expect(dispatch).toHaveBeenCalledTimes(1);
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          model: "target",
          output: [],
          ...(observed ? { reasoning: { effort: observed } } : {}),
        },
      })}\n\n`,
    );
  });
  const adapter = createCodexModelAdapter({
    fetch,
    now: () => 1900000000000,
    clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
    readAuthFile: async () =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "fixture",
          id_token: `fixture.${Buffer.from('{"sub":"fixture-user"}').toString("base64url")}.signature`,
          access_token: `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`,
        },
      }),
  });
  const request = ModelCallRequest.parse({
    source: "codex",
    model: "target",
    account: { mode: "pin", profileId: "fixture" },
    messages: [{ role: "user", content: "test" }],
  });
  const context = {
    profile: CredentialProfile.parse({
      profile_id: "fixture",
      harness_id: "codex",
      display_name: "Fixture",
      credential_kind: "config_dir_login",
      isolation_locator: `${process.env.CLAUDEXOR_CONFIG_DIR}/fixture`,
    }),
    signal: new AbortController().signal,
    onDispatch: dispatch,
  };
  return { fetch, dispatch, request, context, adapter };
}

it.each([
  ["xhigh", ["low", "max"], "low", "downward"],
  ["none", ["high", "max"], "high", "floor"],
  ["future-native", ["future-native"], "future-native", "exact"],
  ["Future.Native/2027", ["Future.Native/2027"], "Future.Native/2027", "exact"],
  ["none", ["none", "high"], "none", "exact"],
  ["max", ["low", "max", "ultra"], "max", "exact"],
  ["future-native", ["low", "future-native", "ultra"], "future-native", "exact"],
  ["xhigh", [], null, "omitted"],
] as const)(
  "resolves %s in the exact account catalog before its only POST",
  async (requested, levels, submitted, resolution) => {
    const f = fixture([...levels]);
    const request = { ...f.request, options: { reasoningEffort: requested } };
    const frozen = JSON.stringify(request);
    const result = await f.adapter.invoke(request, f.context);
    expect(JSON.stringify(request)).toBe(frozen);
    expect(result.outcome).toBe("completed");
    expect(f.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const body = JSON.parse(await requestBodyText(f.fetch.mock.calls[1]![1]));
    expect(body.reasoning?.effort ?? null).toBe(submitted);
    expect(ModelCallResult.parse(result)).toMatchObject({
      effortResolution: { requested, submitted, resolution, source: "account_catalog" },
    });
    expect(result.appliedOptions.reasoningEffort).toBeUndefined();
  },
);

it.each([
  // No verified model lists the word, so the account's own order cannot rank it:
  // the shared preference order places it onto a level the target really accepts.
  ["minimal", ["low", "max"], FULL_SIBLING, "low", "floor"],
  ["ultra", ["low", "high"], ["low", "medium", "high"], "high", "downward"],
  ["none", ["low", "high"], ["low", "medium", "high"], "low", "floor"],
] as const)(
  "places %s by the shared preference order when no catalog model lists it",
  async (requested, levels, sibling, submitted, resolution) => {
    const f = fixture([...levels], undefined, [...sibling]);
    const result = await f.adapter.invoke(
      { ...f.request, options: { reasoningEffort: requested } },
      f.context,
    );
    expect(result.outcome).toBe("completed");
    const body = JSON.parse(await requestBodyText(f.fetch.mock.calls[1]![1]));
    expect(body.reasoning.effort).toBe(submitted);
    expect(result.effortResolution).toMatchObject({ requested, submitted, resolution });
    expect(result.effortResolution?.reason).toContain("shared preference order");
    // The session-Ultra projection note belongs to models that list `ultra`.
    expect(result.effortResolution?.reason).not.toContain("do not execute");
  },
);

it("keeps a provider echo separate from submission", async () => {
  const f = fixture(["low", "max"], "max");
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "xhigh" } },
    f.context,
  );
  expect(result).toMatchObject({
    effortResolution: { requested: "xhigh", submitted: "low", observed: "max" },
  });
});

it("refuses unrankable requests without dispatch, generation, or a zero-cost claim", async () => {
  const f = fixture();
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "invented" } },
    f.context,
  );
  expect(result.problem?.code).toBe("unsupported_parameter");
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(result.cost.cashUsd).toBeNull();
  expect(result).toMatchObject({
    effortResolution: { requested: "invented", submitted: null, resolution: "rejected" },
  });
});

it("pins the exact additive receipt for embedding consumers", async () => {
  const f = fixture(["low", "xhigh"]);
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "ultra" } },
    f.context,
  );
  expect(result.effortResolution).toEqual(canonical);
});

it.each([{ levels: null }, { levels: [] }])(
  "retains missing versus empty effort metadata through catalog reuse: $levels",
  async ({ levels }) => {
    const f = fixture(levels);
    const catalog = ControlModelCatalogResponse.parse(await f.adapter.catalog(f.context));
    const result = await f.adapter.invoke(
      { ...f.request, options: { reasoningEffort: "xhigh" } },
      { ...f.context, catalog },
    );
    expect(result.outcome).toBe("completed");
    expect(result.effortResolution).toMatchObject({
      requested: "xhigh",
      submitted: null,
      resolution: levels ? "omitted" : "unverifiable",
      observed: null,
      observedSource: null,
    });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
  },
);

it.each([
  ["max", ["low", "medium", "high", "xhigh", "max", "ultra"]],
  ["xhigh", ["low", "medium", "high", "xhigh", "ultra"]],
] as const)(
  "adapts native Ultra to the route's %s generation effort after catalog parsing",
  async (submitted, levels) => {
    const f = fixture([...levels], submitted);
    const catalog = ControlModelCatalogResponse.parse(await f.adapter.catalog(f.context));
    expect(catalog.models[0]).toMatchObject({
      reasoningEfforts: levels.filter((level) => level !== "ultra"),
      reasoningEffortPreferenceOrder: levels,
      reasoningEffortsVerified: true,
    });
    const request = { ...f.request, options: { reasoningEffort: "ultra" } };
    const original = JSON.stringify(request);
    const result = await f.adapter.invoke(request, { ...f.context, catalog });
    expect(f.fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET", "POST"]);
    const body = JSON.parse(await requestBodyText(f.fetch.mock.calls[1]![1]));
    expect(body.reasoning.effort).toBe(submitted);
    expect(JSON.stringify(request)).toBe(original);
    expect(result.outcome).toBe("completed");
    expect(result.effortResolution).toMatchObject({
      requested: "ultra",
      submitted,
      observed: submitted,
      resolution: "downward",
      parameter: "reasoning.effort",
      source: "account_catalog",
      reason: expect.stringContaining("do not execute"),
    });
    expect(result.appliedOptions.reasoningEffort).toBe(submitted);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  },
);

it("re-projects a verified historical operation-local catalog without claiming provider observation", async () => {
  const f = fixture(["low", "max", "ultra"]);
  const catalog = ControlModelCatalogResponse.parse(await f.adapter.catalog(f.context));
  catalog.models[0]!.reasoningEfforts = catalog.models[0]!.reasoningEffortPreferenceOrder!;
  delete catalog.models[0]!.reasoningEffortPreferenceOrder;
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "ultra" } },
    { ...f.context, catalog },
  );
  expect(result.outcome).toBe("completed");
  expect(result.effortResolution).toMatchObject({
    requested: "ultra",
    submitted: "max",
    resolution: "downward",
    observed: null,
  });
  expect(result.appliedOptions.reasoningEffort).toBeUndefined();
});

it("does not publish a native-only default as a raw generation default", () => {
  const [model] = parseCodexModelCatalog({
    models: [
      {
        slug: "target",
        supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
        default_reasoning_level: "ultra",
        multi_agent_reasoning_effort: "high",
      },
    ],
  });
  expect(model).toMatchObject({ reasoningEfforts: ["high"], defaultReasoningEffort: null });
});

it("does not invent an Ultra replacement when vendor orders contradict each other", async () => {
  const f = fixture(["max", "low", "ultra"]);
  const result = await f.adapter.invoke(
    { ...f.request, options: { reasoningEffort: "ultra" } },
    f.context,
  );
  expect(result.problem?.code).toBe("unsupported_parameter");
  expect(result.effortResolution).toMatchObject({
    requested: "ultra",
    submitted: null,
    resolution: "rejected",
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls.map(([, init]) => init?.method ?? "GET")).toEqual(["GET"]);
});

it.each([undefined, "max", "future-native"])(
  "preserves unlisted-model effort %s without a sibling ladder",
  async (effort) => {
    const f = fixture(["low"]);
    const result = await f.adapter.invoke(
      { ...f.request, model: "unlisted", options: { reasoningEffort: effort } },
      f.context,
    );
    const body = JSON.parse(await requestBodyText(f.fetch.mock.calls[1]![1]));
    expect(body.model).toBe("unlisted");
    expect(body.reasoning?.effort).toBe(effort);
    expect(result.effortResolution).toMatchObject({
      requested: effort ?? null,
      submitted: effort ?? null,
      resolution: effort ? "exact" : "omitted",
      source: "adapter",
      observed: null,
      observedSource: null,
    });
    expect(result.effortResolution?.reason).toContain("without capability confirmation");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  },
);

it("refuses native-only Ultra for an unlisted raw model as an option, not an account or model", async () => {
  const f = fixture();
  const result = await f.adapter.invoke(
    { ...f.request, model: "unlisted", options: { reasoningEffort: "ultra" } },
    f.context,
  );
  expect(result.problem).toMatchObject({
    code: "unsupported_parameter",
    context: { parameter: "reasoningEffort" },
  });
  expect(result.effortResolution).toMatchObject({
    requested: "ultra",
    submitted: null,
    resolution: "rejected",
    source: "adapter",
  });
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
