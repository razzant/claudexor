import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@claudexor/secrets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@claudexor/secrets")>()),
  resolveSecret: () => null,
}));

import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { buildRegistry } from "./registry.js";

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("built-in raw-api registry cost wiring", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.CLAUDEXOR_RAWAPI_KEY;
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.CLAUDEXOR_RAWAPI_BASE_URL = "https://unit.test/raw-api/v1";
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.CLAUDEXOR_OPENROUTER_BASE_URL = "https://unit.test/openrouter/v1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("declares the provider's account-charge receipt as exact USD", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "openrouter/model",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0.125 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = buildRegistry({ includeFakes: false }).get("openrouter");
    expect(adapter).toBeDefined();

    const events = await collect(
      adapter!.run(
        HarnessRunSpec.parse({
          session_id: "registry-openrouter-cost",
          intent: "explain",
          model_hint: "vendor/chosen",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    const rawUsageEvent = events.find((event) => event.type === "usage");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://unit.test/openrouter/v1/chat/completions");
    expect(rawUsageEvent).toStrictEqual({
      type: "usage",
      session_id: "registry-openrouter-cost",
      ts: expect.any(String),
      usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.125 },
      observed_model: "openrouter/model",
    });
    expect(rawUsageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);

    const usageEvent = HarnessEvent.parse(rawUsageEvent);
    expect(usageEvent).toMatchObject({
      usage: { input_tokens: 2, output_tokens: 3, cost_usd: 0.125 },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("estimated");
  });

  it("keeps the default raw-api instance untrusted for the same provider extension", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: "compatible/model",
            choices: [{ message: { content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 8, cost: 0.5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = buildRegistry({ includeFakes: false }).get("raw-api");
    expect(adapter).toBeDefined();

    const events = await collect(
      adapter!.run(
        HarnessRunSpec.parse({
          session_id: "registry-generic-cost",
          intent: "explain",
          model_hint: "vendor/chosen",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    const rawUsageEvent = events.find((event) => event.type === "usage");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://unit.test/raw-api/v1/chat/completions");
    expect(rawUsageEvent).toStrictEqual({
      type: "usage",
      session_id: "registry-generic-cost",
      ts: expect.any(String),
      usage: { input_tokens: 5, output_tokens: 8 },
      observed_model: "compatible/model",
    });
    expect(rawUsageEvent?.usage).not.toHaveProperty("cost_usd");
    expect(rawUsageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);

    const usageEvent = HarnessEvent.parse(rawUsageEvent);
    expect(usageEvent).toMatchObject({
      usage: { input_tokens: 5, output_tokens: 8 },
      observed_model: "compatible/model",
    });
    expect(usageEvent.usage).not.toHaveProperty("cost_usd");
  });
});
