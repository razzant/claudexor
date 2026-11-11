import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  modelCatalogFailureText,
  readModelCatalog,
  withDispatchModelCatalog,
} from "@claudexor/core";
import { CredentialProfile, HarnessModel, HarnessRunSpec } from "@claudexor/schema";

// Hermetic secrets: only refs a test stores resolve; nothing reads this machine.
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("@claudexor/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/secrets")>()),
  resolveSecret: (ref: string) => secrets.get(ref) ?? null,
}));

import { apiKeyFingerprint } from "./catalog.js";
import { createRawApiAdapter } from "./index.js";

const ORIGINAL_ENV = { ...process.env };
const ROUTER = { id: "openrouter", baseUrl: "https://router.test/api/v1", keyEnv: "ROUTER_KEY" };
/** What every read made with `key` names: that key's fingerprint at this endpoint. */
const sentWith = (key: string) => ({
  credential: { fingerprint: apiKeyFingerprint(ROUTER.baseUrl, key) },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function authorizationOf(fetchMock: ReturnType<typeof stubFetch>, call = 0): string {
  const init = fetchMock.mock.calls[call]?.[1];
  return (init?.headers as Record<string, string>).authorization;
}

const profile = CredentialProfile.parse({
  profile_id: "router-work",
  harness_id: "openrouter",
  display_name: "Work key",
  credential_kind: "api_key",
  secret_ref: "openrouter:work",
});

beforeEach(() => {
  delete process.env.ROUTER_KEY;
  secrets.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("raw-api typed catalog read (#393)", () => {
  it("lists a successful catalog with its metadata, and an empty one as an empty catalog", async () => {
    process.env.ROUTER_KEY = "sk-env";
    stubFetch(() =>
      json({
        data: [
          {
            id: "vendor/vision",
            name: "Vision",
            context_length: 200000,
            architecture: { input_modalities: ["text", "image"] },
            top_provider: { max_completion_tokens: 32000 },
          },
          { id: "vendor/plain" },
        ],
      }),
    );
    const adapter = createRawApiAdapter(ROUTER);
    const read = await adapter.modelCatalog!({ cwd: "/repo" });
    expect(read).toEqual({
      status: "listed",
      models: [
        {
          id: "vendor/vision",
          label: "Vision",
          context_window: 200000,
          routes: null,
          input_modalities: ["text", "image"],
          max_output_tokens: 32000,
        },
        // Unknown metadata is absent, never an empty or invented claim.
        { id: "vendor/plain", label: null, context_window: null, routes: null },
      ],
      ...sentWith("sk-env"),
    });
    if (read.status === "listed") for (const row of read.models) HarnessModel.parse(row);

    stubFetch(() => json({ data: [] }));
    expect(await adapter.modelCatalog!({ cwd: "/repo" })).toEqual({
      status: "listed",
      models: [],
      ...sentWith("sk-env"),
    });
    expect(await readModelCatalog(adapter, { cwd: "/repo" })).toEqual({
      status: "listed",
      models: [],
      failSoft: false,
      sourceProgram: null,
      ...sentWith("sk-env"),
    });
  });

  it.each([
    [401, "auth_rejected"],
    [403, "auth_rejected"],
    [500, "http_status"],
    [503, "http_status"],
  ] as const)("types HTTP %s as %s with its status", async (status, cause) => {
    process.env.ROUTER_KEY = "sk-env";
    stubFetch(() => new Response(`{"error":"status ${status}"}`, { status }));
    const adapter = createRawApiAdapter(ROUTER);
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause, httpStatus: status, detail: `{"error":"status ${status}"}` },
      ...sentWith("sk-env"),
    });
    // The display projection still fails soft for a picker.
    expect(await adapter.models!()).toEqual([]);
  });

  // #172: the whole detail is masked, then cut to its 200 UTF-16 units without
  // separating the halves of an astral character.
  const token = `ghp_${"a".repeat(36)}`;
  const x = (count: number) => "x".repeat(count);
  it.each([
    {
      name: "a token straddling the cut",
      body: `${x(179)} ${token} after`,
      detail: `${x(179)} [redacted] after`,
    },
    { name: "an astral character across the cut", body: `${x(199)}😀tail`, detail: x(199) },
    {
      name: "an astral character ending at the cut",
      body: `${x(198)}😀tail`,
      detail: `${x(198)}😀`,
    },
    { name: "ASCII at the bound", body: x(200), detail: x(200) },
    { name: "ASCII above the bound", body: x(201), detail: x(200) },
  ])("masks and bounds a failed read's detail: $name", async ({ body, detail }) => {
    process.env.ROUTER_KEY = "sk-env";
    stubFetch(() => new Response(body, { status: 503 }));
    const read = await readModelCatalog(createRawApiAdapter(ROUTER), { cwd: "/repo" });
    if (read.status !== "unavailable") throw new Error("expected a failed read");
    expect(read.failure).toEqual({ cause: "http_status", httpStatus: 503, detail });
    // Every disclosure and refusal quotes the detail through this one phrase.
    expect(modelCatalogFailureText(read.failure)).toContain(`HTTP 503: ${detail})`);
  });

  it("types a timeout and a network failure without inventing a status", async () => {
    process.env.ROUTER_KEY = "sk-env";
    const adapter = createRawApiAdapter(ROUTER);
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await adapter.modelCatalog!()).toMatchObject({
      status: "unavailable",
      failure: { cause: "timeout", httpStatus: null },
    });
    stubFetch(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause: "network", httpStatus: null, detail: "fetch failed: ECONNREFUSED" },
      ...sentWith("sk-env"),
    });
    // undici's "fetch failed" keeps the socket error in `cause`: name its code.
    stubFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause: "network", httpStatus: null, detail: "fetch failed (ECONNREFUSED)" },
      ...sentWith("sk-env"),
    });
    // A refusal before any socket (a fetch-blocked port) has a message only.
    stubFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("bad port") });
    });
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause: "network", httpStatus: null, detail: "fetch failed (bad port)" },
      ...sentWith("sk-env"),
    });
  });

  it("types a malformed, a partially malformed and a paginated answer as failures", async () => {
    process.env.ROUTER_KEY = "sk-env";
    const adapter = createRawApiAdapter(ROUTER);
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause: "malformed", httpStatus: 200, detail: "the answer is not JSON" },
      ...sentWith("sk-env"),
    });
    stubFetch(() => json({ data: [{ id: "vendor/a" }, { name: "no id" }] }));
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: { cause: "malformed", httpStatus: 200, detail: "row 1 has no string id" },
      ...sentWith("sk-env"),
    });
    // The valid row does NOT survive as an apparently complete smaller catalog.
    expect(await adapter.models!()).toEqual([]);
    stubFetch(() => json({ data: [{ id: "vendor/a" }], links: { next: "https://x/p2" } }));
    expect(await adapter.modelCatalog!()).toMatchObject({
      status: "unavailable",
      failure: { cause: "incomplete", httpStatus: 200 },
    });
    stubFetch(() => json({ data: [{ id: "vendor/a" }], total_count: 2, links: { next: null } }));
    expect(await adapter.modelCatalog!()).toMatchObject({
      status: "unavailable",
      failure: { cause: "incomplete", httpStatus: 200 },
    });
    stubFetch(() => json({ data: [{ id: "vendor/a" }, { id: "vendor/b" }], total_count: 1 }));
    expect(await adapter.modelCatalog!()).toEqual({
      status: "unavailable",
      failure: {
        cause: "malformed",
        httpStatus: 200,
        detail: "the answer declares 1 rows but carries 2",
      },
      ...sentWith("sk-env"),
    });
    stubFetch(() => json({ data: [{ id: "vendor/a" }], total_count: 1, links: { next: null } }));
    expect(await adapter.modelCatalog!()).toMatchObject({ status: "listed" });
  });

  it("types a missing credential without touching the network", async () => {
    const fetchMock = stubFetch(() => json({ data: [] }));
    expect(await createRawApiAdapter(ROUTER).modelCatalog!()).toEqual({
      status: "unavailable",
      failure: {
        cause: "no_credential",
        httpStatus: null,
        detail: "openrouter: ROUTER_KEY not set",
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the catalog with the SELECTED profile's key, the same one run() sends", async () => {
    process.env.ROUTER_KEY = "sk-ambient";
    secrets.set("openrouter:work", "sk-profile");
    const fetchMock = stubFetch(() =>
      json({
        model: "vendor/a",
        data: [{ id: "vendor/a" }],
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const adapter = createRawApiAdapter(ROUTER);
    await adapter.models!({ cwd: "/repo", credentialProfile: profile });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://router.test/api/v1/models");
    expect(authorizationOf(fetchMock, 0)).toBe("Bearer sk-profile");
    for await (const _event of adapter.run(
      HarnessRunSpec.parse({
        session_id: "profile-run",
        intent: "explain",
        prompt: "hi",
        cwd: "/repo",
        credential_profile: profile,
        model_hint: "vendor/a",
      }),
    )) {
      /* consume */
    }
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://router.test/api/v1/chat/completions");
    expect(authorizationOf(fetchMock, 1)).toBe("Bearer sk-profile");
    // Without a profile both use the instance's own default credential.
    await adapter.models!({ cwd: "/repo" });
    expect(authorizationOf(fetchMock, 2)).toBe("Bearer sk-ambient");
    // Each read names the key it sent, so one profile id is never one key.
    const named = await adapter.modelCatalog!({ cwd: "/repo", credentialProfile: profile });
    expect(named).toMatchObject(sentWith("sk-profile"));
    secrets.set("openrouter:work", "sk-profile-replaced");
    const replaced = await adapter.modelCatalog!({ cwd: "/repo", credentialProfile: profile });
    expect(replaced).toMatchObject(sentWith("sk-profile-replaced"));
    expect(replaced.credential?.fingerprint).not.toBe(named.credential?.fingerprint);
    expect(await adapter.modelCatalog!({ cwd: "/repo" })).toMatchObject(sentWith("sk-ambient"));
  });

  it("run() sends the key its spawn's dispatch read checked, for that instance and profile only", async () => {
    secrets.set("openrouter:work", "sk-checked");
    const fetchMock = stubFetch(() =>
      json({
        model: "vendor/a",
        data: [{ id: "vendor/a" }],
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    const adapter = createRawApiAdapter(ROUTER);
    const spec = (credentialProfile?: CredentialProfile) =>
      HarnessRunSpec.parse({
        session_id: "checked-key",
        intent: "explain",
        prompt: "hi",
        cwd: "/repo",
        model_hint: "vendor/a",
        ...(credentialProfile ? { credential_profile: credentialProfile } : {}),
      });
    const sentBy = async (runner: typeof adapter, run: HarnessRunSpec) => {
      for await (const _event of runner.run(run)) {
        /* consume */
      }
      return authorizationOf(fetchMock, fetchMock.mock.calls.length - 1);
    };
    const read = await adapter.modelCatalog!({ cwd: "/repo", credentialProfile: profile });
    secrets.set("openrouter:work", "sk-replaced"); // after the check, before the request
    expect(await sentBy(adapter, withDispatchModelCatalog(spec(profile), read))).toBe(
      "Bearer sk-checked",
    );
    // Without that read the key resolves now; another profile's read binds nothing.
    expect(await sentBy(adapter, spec(profile))).toBe("Bearer sk-replaced");
    secrets.set("openrouter:other", "sk-other");
    const other = CredentialProfile.parse({
      ...profile,
      profile_id: "router-other",
      secret_ref: "openrouter:other",
    });
    expect(await sentBy(adapter, withDispatchModelCatalog(spec(other), read))).toBe(
      "Bearer sk-other",
    );
    // Nor does another instance's read of its default key.
    process.env.ROUTER_KEY = "sk-ambient";
    process.env.ROUTER_B_KEY = "sk-b";
    const ambient = await adapter.modelCatalog!({ cwd: "/repo" });
    const b = createRawApiAdapter({ ...ROUTER, id: "router-b", keyEnv: "ROUTER_B_KEY" });
    expect(await sentBy(b, withDispatchModelCatalog(spec(), ambient))).toBe("Bearer sk-b");
    // The checked key itself is not on the read, nor on any copy of it.
    for (const view of [
      JSON.stringify(read),
      inspect(read, { depth: 9, showHidden: true }),
      JSON.stringify(structuredClone(read)),
      JSON.stringify({ ...read }),
    ])
      expect(view).not.toContain("sk-checked");
  });

  it("never reads a fenced or missing profile secret: the read fails typed instead", async () => {
    process.env.ROUTER_KEY = "sk-ambient";
    const fetchMock = stubFetch(() => json({ data: [] }));
    const adapter = createRawApiAdapter(ROUTER);
    const fenced = CredentialProfile.parse({ ...profile, secret_ref: "raw:work" });
    expect(await adapter.modelCatalog!({ cwd: "/repo", credentialProfile: fenced })).toMatchObject({
      status: "unavailable",
      failure: { cause: "no_credential" },
    });
    expect(await adapter.modelCatalog!({ cwd: "/repo", credentialProfile: profile })).toMatchObject(
      {
        status: "unavailable",
        failure: { cause: "no_credential", detail: expect.stringContaining("is not stored") },
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
