import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AccountResourceSnapshot, CredentialProfile } from "@claudexor/schema";
import { SecretStore } from "@claudexor/secrets";
import { apiKeyFingerprint } from "./catalog.js";
import {
  decimalAmount,
  instanceKeyCredentials,
  parseKeyAllowance,
  readKeyAllowance,
} from "./key-allowance.js";

const at = new Date("2026-10-29T08:00:00Z");
const target = { harness: "openrouter", profile_id: null };
const fingerprint = "0123456789abcdef";
/** Shape of OpenRouter's documented GET /api/v1/key answer (synthetic values). */
const body = (data: Record<string, unknown>) => ({
  data: {
    label: "sk-or-v1-fix...000",
    limit: 50,
    limit_remaining: 37.66,
    limit_reset: "monthly",
    include_byok_in_limit: false,
    usage: 140.5,
    usage_daily: 1.02,
    usage_weekly: 4.5,
    usage_monthly: 12.34,
    budgets: [
      {
        scope: "key_limit",
        guardrail_id: null,
        budget_id: null,
        limit_usd: 50,
        spend_usd: 12.34,
        remaining_usd: 37.66,
        reset_interval: "monthly",
        resets_at: "2026-11-01T00:00:00Z",
        include_byok: false,
      },
    ],
    is_free_tier: false,
    ...data,
  },
});
const spending = (data: Record<string, unknown>) => {
  const observation = parseKeyAllowance(body(data), target, fingerprint, at);
  expect(observation.credential_fingerprint).toBe(fingerprint);
  return observation.spending!;
};

describe("OpenRouter key allowance codec", () => {
  it("reads a capped key: provider remaining, budget spend and the provider reset instant", () => {
    const facet = spending({});
    expect(facet).toMatchObject({ source: "openrouter_key", freshness: "fresh", last_error: null });
    expect(facet.value).toEqual([
      expect.objectContaining({
        id: "openrouter_key_limit",
        capped: true,
        limit: "50",
        remaining: "37.66",
        used: "12.34",
        window: "month",
        unit: "USD",
        currency: "USD",
        decimal_places: null,
        resets_at: "2026-11-01T00:00:00.000Z",
      }),
    ]);
  });

  it("keeps no per-key cap distinct from zero, unknown and unlimited money", () => {
    const [row] = spending({
      limit: null,
      limit_remaining: null,
      limit_reset: null,
      budgets: [],
    }).value!;
    expect(row).toMatchObject({ capped: false, limit: null, remaining: null, window: "month" });
    expect(row!.used).toBe("12.34");
    expect(row!.reason).toContain("credit balance");
    expect(row!.resets_at).toBeNull();
  });

  it("keeps a real zero cap and an exhausted or overdrawn remainder", () => {
    expect(spending({ limit: 0, limit_remaining: 0, budgets: [] }).value![0]).toMatchObject({
      capped: true,
      limit: "0",
      remaining: "0",
    });
    expect(spending({ limit_remaining: -1.25 }).value![0]!.remaining).toBe("-1.25");
  });

  it("never invents a reset instant: no budget anchor leaves it null and uses the window counter", () => {
    const [weekly] = spending({ limit_reset: "weekly", budgets: [] }).value!;
    expect(weekly).toMatchObject({ window: "week", used: "4.5", resets_at: null });
    const [lifetime] = spending({ limit_reset: null, budgets: [] }).value!;
    expect(lifetime).toMatchObject({ window: "lifetime", used: "140.5", resets_at: null });
    const [unknown] = spending({ limit_reset: "fortnightly", budgets: [] }).value!;
    expect(unknown).toMatchObject({ window: null, used: null, resets_at: null });
    // A budget for another cadence is not this cap's window or reset.
    const [mismatch] = spending({ limit_reset: "daily" }).value!;
    expect(mismatch).toMatchObject({ window: "day", used: "1.02", resets_at: null });
  });

  it("does not stand the usage counter in for spend when BYOK also counts toward the cap", () => {
    const [row] = spending({ include_byok_in_limit: true, budgets: [] }).value!;
    expect(row).toMatchObject({ capped: true, remaining: "37.66", used: null });
  });

  it("fails a malformed amount or body without fabricating a value", () => {
    for (const data of [{ limit: "50" }, { limit_remaining: "x" }, { usage_monthly: "12" }]) {
      const facet = spending(data);
      expect(facet).toMatchObject({
        value: null,
        freshness: "unknown",
        last_error: "invalid_key_amount",
      });
    }
    const missing = parseKeyAllowance({ error: { code: 401 } }, target, fingerprint, at);
    expect(missing.spending).toMatchObject({
      value: null,
      last_error: "unrecognized_key_response",
    });
    expect(() => AccountResourceSnapshot.partial().parse(missing)).not.toThrow();
  });

  it("formats provider numbers as plain decimals without rounding or exponents", () => {
    expect(decimalAmount(5e-7)).toBe("0.0000005");
    expect(decimalAmount(1.5e-10)).toBe("0.00000000015");
    expect(decimalAmount(37.66)).toBe("37.66");
    expect(decimalAmount(0)).toBe("0");
    expect(decimalAmount(-1.25)).toBe("-1.25");
    expect(decimalAmount(1e21)).toBe("1000000000000000000000");
    expect(decimalAmount(Number.NaN)).toBeUndefined();
    expect(decimalAmount("1")).toBeUndefined();
  });
});

describe("key identity", () => {
  it("fingerprints are stable, endpoint-bound, key-specific and never contain the key", () => {
    const key = "fixture-openrouter-default-0000";
    const value = apiKeyFingerprint("https://openrouter.ai/api/v1/", key);
    expect(value).toMatch(/^[0-9a-f]{16}$/);
    expect(apiKeyFingerprint("https://openrouter.ai/api/v1", key)).toBe(value);
    expect(apiKeyFingerprint("https://openrouter.ai/api/v1", `${key}x`)).not.toBe(value);
    expect(apiKeyFingerprint("http://127.0.0.1:1/api/v1", key)).not.toBe(value);
    expect(value).not.toContain(key);
  });

  it("resolves the default key and enabled registered keys exactly as requests do", () => {
    const store = new SecretStore();
    store.set("openrouter", "fixture-openrouter-default");
    store.set("openrouter:work", "fixture-openrouter-work");
    store.set("openrouter:off", "fixture-openrouter-off");
    const instance = {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
    };
    const row = (profile_id: string, secret_ref: string | null, enabled = true) =>
      CredentialProfile.parse({
        profile_id,
        harness_id: "openrouter",
        display_name: profile_id,
        credential_kind: "api_key",
        secret_ref,
        enabled,
      });
    try {
      const credentials = instanceKeyCredentials(
        instance,
        [
          row("work", "openrouter:work"),
          row("off", "openrouter:off", false),
          row("missing", "openrouter:missing"),
        ],
        {},
      );
      expect(credentials.map((c) => c.target)).toEqual([
        { harness: "openrouter", profile_id: null },
        { harness: "openrouter", profile_id: "work" },
      ]);
      expect(credentials[1]!.fingerprint).toBe(
        apiKeyFingerprint(instance.baseUrl, "fixture-openrouter-work"),
      );
      // The key variable outranks the stored default, as in run().
      expect(
        instanceKeyCredentials(instance, [], { OPENROUTER_API_KEY: "fixture-openrouter-env" })[0]!
          .fingerprint,
      ).toBe(apiKeyFingerprint(instance.baseUrl, "fixture-openrouter-env"));
    } finally {
      for (const name of ["openrouter", "openrouter:work", "openrouter:off"]) store.delete(name);
    }
  });
});

describe("GET /key transport", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });
  const serve = async (handler: RequestListener) => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}/api/v1`;
  };

  it("sends the key as a bearer token to <base>/key and returns the body", async () => {
    const seen: Array<{ url?: string; auth?: string; method?: string }> = [];
    const base = await serve((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization, method: req.method });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body({})));
    });
    const read = await readKeyAllowance(`${base}/`, "sk-or-v1-synthetic");
    expect(read).toEqual({ ok: true, body: body({}) });
    expect(seen).toEqual([
      { url: "/api/v1/key", auth: "Bearer sk-or-v1-synthetic", method: "GET" },
    ]);
  });

  it("maps refusals and rate limits to bounded codes without keeping the body", async () => {
    let status = 401;
    const base = await serve((_req, res) => {
      res.statusCode = status;
      if (status === 429) res.setHeader("retry-after", "7");
      res.end(JSON.stringify({ error: { message: "echo sk-or-v1-synthetic" } }));
    });
    expect(await readKeyAllowance(base, "sk-or-v1-synthetic")).toEqual({
      ok: false,
      reason: "auth_rejected",
      httpStatus: 401,
      retryAfterMs: null,
    });
    status = 429;
    expect(await readKeyAllowance(base, "sk-or-v1-synthetic")).toEqual({
      ok: false,
      reason: "rate_limited",
      httpStatus: 429,
      retryAfterMs: 7000,
    });
    status = 500;
    const failed = await readKeyAllowance(base, "sk-or-v1-synthetic");
    expect(failed).toMatchObject({ ok: false, reason: "http_status", httpStatus: 500 });
    expect(JSON.stringify(failed)).not.toContain("sk-or-v1");
  });

  it("reports a body that is not JSON, a timeout and an unreachable endpoint as failures", async () => {
    const base = await serve((req, res) => {
      if (req.url?.includes("slow")) return;
      res.end("not json");
    });
    expect(await readKeyAllowance(base, "k")).toMatchObject({
      ok: false,
      reason: "unrecognized_key_response",
    });
    expect(await readKeyAllowance(`${base}/slow`, "k", 50)).toMatchObject({
      ok: false,
      reason: "timeout",
      httpStatus: null,
    });
    expect(await readKeyAllowance("http://127.0.0.1:9/api/v1", "k")).toMatchObject({
      ok: false,
      reason: "network",
    });
  });
});
