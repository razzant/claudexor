import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic: never read this dev machine's stored secrets — the only key that
// resolves is the env var the test sets (or none). Must be mocked before the
// adapter module loads.
vi.mock("@claudexor/secrets", () => ({ resolveSecret: () => null }));

import { createRawApiAdapter } from "./index.js";

/**
 * The raw-api models() is the REAL ADP4 enumeration producer: GET <baseURL>/models
 * with the resolved auth header, OpenAI `{data:[{id}]}` parsing, and a SOFT fail
 * (return [] — never throw into a picker). These tests pin that contract by
 * stubbing fetch; no network is touched.
 */
describe("raw-api models() — enumeration producer", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    // Clean slate: only the key we set should resolve.
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDEXOR_RAWAPI_KEY;
    delete process.env.CLAUDEXOR_RAWAPI_BASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("GETs <baseURL>/models with a Bearer auth header and parses the OpenAI list", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createRawApiAdapter({ baseUrl: "https://api.openai.com/v1" });
    const models = await adapter.models!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    expect(models).toEqual([
      { id: "gpt-4o-mini", label: null, context_window: null },
      { id: "gpt-4o", label: null, context_window: null },
    ]);
  });

  it("returns [] (no fetch) when no key is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createRawApiAdapter();
    expect(await adapter.models!()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails soft (returns []) on a non-OK response — never throws into the picker", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const adapter = createRawApiAdapter();
    expect(await adapter.models!()).toEqual([]);
  });

  it("fails soft (returns []) on a network error", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const adapter = createRawApiAdapter();
    await expect(adapter.models!()).resolves.toEqual([]);
  });
});
