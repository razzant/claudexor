import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: never read this dev machine's stored secrets — the only key that
// resolves is the env var the test sets (or none). Must be mocked before the
// adapter module loads.
vi.mock("@claudexor/secrets", async (importOriginal) => ({
  // The name GRAMMAR stays real (pure, no store); only store reads are stubbed.
  ...(await importOriginal<typeof import("@claudexor/secrets")>()),
  resolveSecret: () => null,
}));

import { appendHarnessEvent } from "@claudexor/core";
import { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { createRawApiAdapter } from "./index.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

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
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createRawApiAdapter({ baseUrl: "https://api.openai.com/v1" });
    const models = await adapter.models!();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    // routes: null = unannotated (a live enumeration reflects the credentials
    // it ran under; route scoping is a manifest-annotation concept, W11).
    expect(models).toEqual([
      { id: "gpt-4o-mini", label: null, context_window: null, routes: null },
      { id: "gpt-4o", label: null, context_window: null, routes: null },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );
    const adapter = createRawApiAdapter();
    expect(await adapter.models!()).toEqual([]);
  });

  it("fails soft (returns []) on a network error", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const adapter = createRawApiAdapter();
    await expect(adapter.models!()).resolves.toEqual([]);
  });

  it("emits typed transient metadata for retryable raw-api HTTP failures", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("try later", { status: 503 })),
    );
    const adapter = createRawApiAdapter();
    const events = await collect(
      adapter.run(
        HarnessRunSpec.parse({
          session_id: "s1",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    const error = events.find((e) => e.type === "error");
    expect(events.map((event) => event.type)).toEqual(["started", "error", "completed"]);
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(error?.transient?.kind).toBe("service_unavailable");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("normalizes a fractional Retry-After delay before emitting typed events", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("slow down", { status: 429, headers: { "retry-after": "0.572548415" } }),
      ),
    );
    const events = await collect(
      createRawApiAdapter().run(
        HarnessRunSpec.parse({
          session_id: "s-fractional-retry",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.rate_limit?.retry_delay_ms).toBe(573);
    expect(error?.transient?.retry_delay_ms).toBe(573);
    expect(() => HarnessEvent.parse(error)).not.toThrow();
  });
});

describe("raw-api provider cost receipts", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.CLAUDEXOR_RAWAPI_KEY;
    delete process.env.CLAUDEXOR_RAWAPI_BASE_URL;
    process.env.OPENAI_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  async function runWithProviderCost(
    cost: unknown,
    providerUsageCostUnit?: "usd",
    upstreamInferenceCost?: unknown,
  ): Promise<HarnessEvent[]> {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "openrouter/model",
              choices: [{ message: { content: "done" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 2,
                completion_tokens: 3,
                cost,
                ...(upstreamInferenceCost === undefined
                  ? {}
                  : { cost_details: { upstream_inference_cost: upstreamInferenceCost } }),
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const events = await collect(
      createRawApiAdapter({ providerUsageCostUnit }).run(
        HarnessRunSpec.parse({
          session_id: "provider-cost",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
        }),
      ),
    );
    return events;
  }

  it.each([
    ["the account-charge receipt instead of upstream inference cost", 0.01, 99],
    ["an exact zero receipt", 0, undefined],
  ])("emits %s as exact USD only for a trusted instance", async (_label, cost, upstreamCost) => {
    const events = await runWithProviderCost(cost, "usd", upstreamCost);
    const usageEvent = events.find((event) => event.type === "usage");

    expect(events.map((event) => event.type)).toEqual(["started", "message", "usage", "completed"]);
    expect(usageEvent).toStrictEqual({
      type: "usage",
      session_id: "provider-cost",
      ts: expect.any(String),
      usage: { input_tokens: 2, output_tokens: 3, cost_usd: cost },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(usageEvent?.usage?.cost_usd).not.toBe(99);
    expect(usageEvent?.usage).not.toHaveProperty("estimated");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("keeps the same provider extension untrusted on a generic instance", async () => {
    const events = await runWithProviderCost(0.25);
    const usageEvent = events.find((event) => event.type === "usage");

    expect(usageEvent).toStrictEqual({
      type: "usage",
      session_id: "provider-cost",
      ts: expect.any(String),
      usage: { input_tokens: 2, output_tokens: 3 },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("cost_usd");
    expect(usageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(usageEvent?.usage).not.toHaveProperty("estimated");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("ignores upstream inference cost when the trusted account receipt is absent", async () => {
    const events = await runWithProviderCost(undefined, "usd", 99);
    const usageEvent = events.find((event) => event.type === "usage");

    expect(usageEvent).toStrictEqual({
      type: "usage",
      session_id: "provider-cost",
      ts: expect.any(String),
      usage: { input_tokens: 2, output_tokens: 3 },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("cost_usd");
    expect(usageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("emits a cost-only usage receipt even when token counts are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "openrouter/model",
              choices: [{ message: { content: "done" }, finish_reason: "stop" }],
              usage: { cost: 0.75 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const events = await collect(
      createRawApiAdapter({ providerUsageCostUnit: "usd" }).run(
        HarnessRunSpec.parse({
          session_id: "provider-cost-only",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
        }),
      ),
    );
    const usageEvent = events.find((event) => event.type === "usage");

    expect(usageEvent).toStrictEqual({
      type: "usage",
      session_id: "provider-cost-only",
      ts: expect.any(String),
      usage: { input_tokens: undefined, output_tokens: undefined, cost_usd: 0.75 },
      observed_model: "openrouter/model",
    });
    expect(usageEvent?.usage).not.toHaveProperty("provider_cost");
    expect(usageEvent?.usage?.input_tokens).toBeUndefined();
    expect(usageEvent?.usage?.output_tokens).toBeUndefined();
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });
});

// Release wave round-15 #5: the instance secret fence accepts only NAMESPACED
// refs whose base belongs to the instance — a foreign provider's namespaced
// slot must refuse typed before any secret read or network call.
describe("raw-api profile instance fence (INV-135)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("refuses a namespaced ref outside the instance fence without touching the network", async () => {
    process.env.OPENAI_API_KEY = "sk-default";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(
      createRawApiAdapter().run(
        HarnessRunSpec.parse({
          session_id: "s1",
          intent: "review",
          prompt: "x",
          cwd: process.cwd(),
          access: "readonly",
          external_context_policy: "auto",
          tool_permission_policy: { web: "auto", allow: [], deny: [] },
          credential_profile: {
            profile_id: "acc2",
            harness_id: "raw-api",
            display_name: "Second",
            credential_kind: "api_key",
            secret_ref: "openrouter:acc2",
          },
        }),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["error", "completed"]);
    expect((events[0] as { error?: string }).error).toContain("instance fence");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("raw-api immutable attachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("places an admitted generic-file sentinel in the vendor payload after digest verification", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const dir = reapMk(join(tmpdir(), "claudexor-raw-attachment-"));
    const path = join(dir, "note.txt");
    const text = "generic sentinel";
    writeFileSync(path, text);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "r1",
            model: "gpt-test",
            choices: [{ message: { content: "seen" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(
      createRawApiAdapter().run(
        HarnessRunSpec.parse({
          session_id: "attachment-run",
          intent: "review",
          prompt: "read it",
          cwd: dir,
          access: "readonly",
          attachments: [
            {
              resource_id: "res-note",
              kind: "file",
              mime: "text/plain",
              name: "note.txt",
              sha256: `sha256:${createHash("sha256").update(text).digest("hex")}`,
              size_bytes: Buffer.byteLength(text),
              path,
            },
          ],
        }),
      ),
    );
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("generic sentinel");
  });

  it("does not call the vendor when immutable bytes no longer match the resource digest", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const dir = reapMk(join(tmpdir(), "claudexor-raw-digest-"));
    const path = join(dir, "note.txt");
    writeFileSync(path, "changed");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const events = await collect(
      createRawApiAdapter().run(
        HarnessRunSpec.parse({
          session_id: "digest-run",
          intent: "review",
          prompt: "read it",
          cwd: dir,
          access: "readonly",
          attachments: [
            {
              resource_id: "res-note",
              kind: "file",
              mime: "text/plain",
              name: "note.txt",
              sha256: `sha256:${"0".repeat(64)}`,
              size_bytes: 7,
              path,
            },
          ],
        }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "error")).toBe(true);
  });
});

describe("raw-api doctor exact auth-source readiness", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLAUDEXOR_RAWAPI_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports a present exact api_key_env source as available but unverified without a paid smoke", async () => {
    const secret = `sk-${"s".repeat(48)}`;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createRawApiAdapter();

    const report = await adapter.doctor({
      cwd: "/repo",
      authSource: "api_key_env",
      env: { OPENAI_API_KEY: secret },
    });

    expect(report.status).toBe("degraded");
    expect(report.auth_sources).toEqual([
      {
        source: "api_key_env",
        availability: "available",
        verification: "not_run",
        detail: "credential source is present; verification requires an isolated capability smoke",
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports a missing exact api_key_env source as unavailable but unverified", async () => {
    const report = await createRawApiAdapter().doctor({ cwd: "/repo", authSource: "api_key_env" });

    expect(report.status).toBe("unavailable");
    expect(report.auth_sources).toEqual([
      {
        source: "api_key_env",
        availability: "unavailable",
        verification: "not_run",
        detail: "OPENAI_API_KEY is not configured",
      },
    ]);
  });

  it("returns explicit unavailable evidence for an unsupported source without exposing another source", async () => {
    const secret = `sk-${"u".repeat(48)}`;
    process.env.OPENAI_API_KEY = secret;

    const report = await createRawApiAdapter().doctor({
      cwd: "/repo",
      authSource: "native_session",
    });

    expect(report.enabled_intents).toEqual([]);
    expect(report.auth_sources).toEqual([
      {
        source: "native_session",
        availability: "unavailable",
        verification: "not_run",
        detail: "raw-api does not support native_session",
      },
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("api_key_env");
  });
});

describe("named-instance identity in outward diagnostics (QA-058)", () => {
  const ORIGINAL_ENV = { ...process.env };
  const openrouter = () =>
    createRawApiAdapter({
      id: "openrouter",
      providerFamily: "unknown",
      baseUrl: "https://openrouter.ai/api/v1",
      keyEnv: "OPENROUTER_API_KEY",
      defaultModel: "openai/gpt-5.5",
    });

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("discovery names the instance id, never the raw-api class", async () => {
    await expect(openrouter().discover()).rejects.toThrow(
      "openrouter unavailable: set OPENROUTER_API_KEY",
    );
    await expect(openrouter().discover()).rejects.not.toThrow(/raw-api/);
  });

  it("doctor missing-key reason and unsupported-source detail speak the instance id", async () => {
    const missing = await openrouter().doctor({ cwd: "/repo", authSource: "api_key_env" });
    expect(missing.reasons).toEqual(["set OPENROUTER_API_KEY to enable the openrouter harness"]);
    expect(JSON.stringify(missing)).not.toContain("raw-api");

    const unsupported = await openrouter().doctor({ cwd: "/repo", authSource: "native_session" });
    expect(unsupported.reasons).toEqual(["openrouter does not support auth source native_session"]);
    expect(unsupported.auth_sources[0]?.detail).toBe("openrouter does not support native_session");
    expect(JSON.stringify(unsupported)).not.toContain("raw-api");
  });

  it("a runtime missing-key error names the instance id", async () => {
    const events = await collect(
      openrouter().run(
        HarnessRunSpec.parse({
          session_id: "s-or",
          intent: "explain",
          prompt: "hi",
          cwd: process.cwd(),
        }),
      ),
    );
    const error = events.find((e) => e.type === "error") as { error?: string } | undefined;
    expect(error?.error).toBe("openrouter: OPENROUTER_API_KEY not set");
    expect(error?.error).not.toContain("raw-api");
  });

  it("the DEFAULT instance still identifies itself as raw-api (no over-correction)", async () => {
    await expect(createRawApiAdapter().discover()).rejects.toThrow(
      "raw-api unavailable: set OPENAI_API_KEY",
    );
  });
});

describe("raw-api typed patch producer", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("advertises patch transport and emits typed envelopes for implement and synthesize", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: "raw-model",
              choices: [
                {
                  message: {
                    content: JSON.stringify({ patch }),
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const adapter = createRawApiAdapter();
    const manifest = await adapter.discover();
    expect(manifest.capabilities).toMatchObject({
      implement: true,
      implementation_transport: "git_patch_envelope",
    });
    for (const intent of ["implement", "synthesize"] as const) {
      const events = await collect(
        adapter.run(
          HarnessRunSpec.parse({
            session_id: `raw-${intent}`,
            intent,
            prompt: "edit",
            cwd: process.cwd(),
            raw_context_packet: {
              schema_version: 1,
              packet_hash: "sha256:packet",
              base_commit_sha: "commit",
              base_tree_sha: "tree",
              readable_files: [
                {
                  path: "a.txt",
                  mode: "100644",
                  blob_oid: "blob",
                  content_hash: "sha256:old",
                  content: "old\n",
                },
              ],
              editable_paths: ["a.txt"],
              file_manifest: [{ path: "a.txt", disposition: "full" }],
              omissions: [],
              evidence_refs: ["git:tree:a.txt:blob"],
            },
          }),
        ),
      );
      expect(events.find((event) => event.type === "patch_produced")?.patch_envelope).toMatchObject(
        {
          context_packet_hash: "sha256:packet",
          base_tree_sha: "tree",
          patch,
          patch_hash: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
          touched_paths: [{ path: "a.txt", expected_blob_oid: "blob" }],
        },
      );
      expect(events.some((event) => event.type === "message")).toBe(false);
    }
  });

  it("refuses incomplete JSON with a typed truncation code", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "{" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const spec = HarnessRunSpec.parse({
      session_id: "raw2",
      intent: "implement",
      prompt: "edit",
      cwd: process.cwd(),
      raw_context_packet: {
        schema_version: 1,
        packet_hash: "sha256:packet",
        base_commit_sha: "commit",
        base_tree_sha: "tree",
        readable_files: [],
        editable_paths: [],
        file_manifest: [],
        omissions: [],
        evidence_refs: [],
      },
    });
    const events = await collect(createRawApiAdapter().run(spec));
    expect(events.find((event) => event.type === "error")?.refusal_code).toBe(
      "raw_patch_truncated",
    );
  });

  it("emits a patch event for token-like content: keep-and-mask replaces the early refusal (INV-062)", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const tokenLike = `ghp_${"x".repeat(24)}`;
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      `+${tokenLike}`,
      "",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patch }) } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const events = await collect(
      createRawApiAdapter().run(
        HarnessRunSpec.parse({
          session_id: "raw-sensitive",
          intent: "implement",
          prompt: "edit",
          cwd: process.cwd(),
          raw_context_packet: {
            schema_version: 1,
            packet_hash: "sha256:packet",
            base_commit_sha: "commit",
            base_tree_sha: "tree",
            readable_files: [
              {
                path: "a.txt",
                mode: "100644",
                blob_oid: "blob",
                content_hash: "sha256:old",
                content: "old\n",
              },
            ],
            editable_paths: ["a.txt"],
            file_manifest: [{ path: "a.txt", disposition: "full" }],
            omissions: [],
            evidence_refs: ["git:tree:a.txt:blob"],
          },
        }),
      ),
    );
    // The proposal is no longer refused for its content. The exact patch rides
    // the memory-only patch event (the engine never logs it) so the engine can
    // keep the bytes and mask only its saved copies; scope, preimage and digest
    // evidence are still enforced when the envelope is consumed.
    expect(events.some((event) => event.type === "error")).toBe(false);
    const produced = events.find((event) => event.type === "patch_produced");
    expect(produced?.patch_envelope?.patch).toBe(patch);
    expect(produced?.patch_envelope?.touched_paths).toEqual([
      { path: "a.txt", expected_blob_oid: "blob" },
    ]);
    // No other event (message, usage, completed) echoes the token.
    expect(JSON.stringify(events.filter((event) => event.type !== "patch_produced"))).not.toContain(
      tokenLike,
    );
  });
});

describe("raw-api terminal provider completions", () => {
  const ORIGINAL_ENV = { ...process.env };
  const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
  const rawContextPacket = {
    schema_version: 1 as const,
    packet_hash: "sha256:packet",
    base_commit_sha: "commit",
    base_tree_sha: "tree",
    readable_files: [
      {
        path: "a.txt",
        mode: "100644",
        blob_oid: "blob",
        content_hash: "sha256:old",
        content: "old\n",
      },
    ],
    editable_paths: ["a.txt"],
    file_manifest: [{ path: "a.txt", disposition: "full" as const }],
    omissions: [],
    evidence_refs: ["git:tree:a.txt:blob"],
  };

  beforeEach(() => {
    delete process.env.CLAUDEXOR_RAWAPI_KEY;
    delete process.env.CLAUDEXOR_RAWAPI_BASE_URL;
    process.env.OPENAI_API_KEY = "sk-test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  function responseFor(options: {
    content?: unknown;
    finishReason?: unknown;
    error?: unknown;
    model?: string;
    omitModel?: boolean;
    omitUsage?: boolean;
    omitTokenCounts?: boolean;
    cost?: unknown;
    upstreamInferenceCost?: unknown;
  }): Response {
    return new Response(
      JSON.stringify({
        ...(options.omitModel ? {} : { model: options.model ?? "provider-model" }),
        choices: [
          {
            message: { role: "assistant", content: options.content ?? "partial output" },
            ...(options.finishReason === undefined ? {} : { finish_reason: options.finishReason }),
            ...(options.error === undefined ? {} : { error: options.error }),
          },
        ],
        ...(options.omitUsage
          ? {}
          : {
              usage: {
                ...(options.omitTokenCounts ? {} : { prompt_tokens: 7, completion_tokens: 3 }),
                ...(options.cost === undefined ? {} : { cost: options.cost }),
                ...(options.upstreamInferenceCost === undefined
                  ? {}
                  : {
                      cost_details: {
                        upstream_inference_cost: options.upstreamInferenceCost,
                      },
                    }),
              },
            }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function runSpec(intent: "explain" | "review" | "implement" | "synthesize", sessionId: string) {
    return HarnessRunSpec.parse({
      session_id: sessionId,
      intent,
      prompt: "x",
      cwd: process.cwd(),
      access: "readonly",
      external_context_policy: "auto",
      tool_permission_policy: { web: "auto", allow: [], deny: [] },
      ...((intent === "implement" || intent === "synthesize") && {
        raw_context_packet: rawContextPacket,
      }),
    });
  }

  it.each(["review", "explain"] as const)(
    "treats finish_reason:error as terminal for %s without emitting partial output",
    async (intent) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            finishReason: "error",
            error: {
              code: 502,
              message: "Provider disconnected",
              metadata: { error_type: "provider_unavailable" },
            },
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter().run(runSpec(intent, `terminal-${intent}`)),
      );
      expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
      expect(events.some((event) => event.type === "message")).toBe(false);
      expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
      expect(events.find((event) => event.type === "error")?.payload).toMatchObject({
        partial_output: "partial output",
        partial_output_truncated: false,
      });
      expect(events.find((event) => event.type === "usage")).toMatchObject({
        observed_model: "provider-model",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
      expect(events.at(-1)).toMatchObject({
        type: "completed",
        observed_model: "provider-model",
      });
    },
  );

  it("preserves terminal order and schema validity when model and usage are absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor({
          finishReason: "error",
          omitModel: true,
          omitUsage: true,
        }),
      ),
    );

    const events = await collect(createRawApiAdapter().run(runSpec("review", "terminal-empty")));
    expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
    expect(events.find((event) => event.type === "usage")?.usage).toEqual({});
    expect(events.find((event) => event.type === "usage")?.observed_model).toBeUndefined();
    expect(events.at(-1)?.observed_model).toBeUndefined();
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it.each([
    ["a positive receipt with tokens", 0.25, false],
    ["an exact zero receipt with tokens", 0, false],
    ["a positive cost-only receipt", 0.5, true],
  ] as const)("preserves trusted terminal cost for %s", async (_label, cost, omitTokenCounts) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor({ finishReason: "error", cost, omitTokenCounts })),
    );

    const events = await collect(
      createRawApiAdapter({ providerUsageCostUnit: "usd" }).run(
        runSpec("review", `trusted-terminal-${cost}-${omitTokenCounts}`),
      ),
    );
    const usage = events.find((event) => event.type === "usage");

    expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
    expect(events.some((event) => event.type === "message")).toBe(false);
    expect(usage).toStrictEqual({
      type: "usage",
      session_id: `trusted-terminal-${cost}-${omitTokenCounts}`,
      ts: expect.any(String),
      usage: {
        input_tokens: omitTokenCounts ? undefined : 7,
        output_tokens: omitTokenCounts ? undefined : 3,
        cost_usd: cost,
      },
      observed_model: "provider-model",
    });
    expect(usage?.usage).not.toHaveProperty("provider_cost");
    expect(usage?.usage).not.toHaveProperty("estimated");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("keeps terminal provider cost untrusted for a generic instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor({ finishReason: "error", cost: 0.25 })),
    );

    const events = await collect(createRawApiAdapter().run(runSpec("review", "generic-terminal")));
    const usage = events.find((event) => event.type === "usage");

    expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
    expect(usage?.usage).toStrictEqual({ input_tokens: 7, output_tokens: 3 });
    expect(usage?.usage).not.toHaveProperty("cost_usd");
    expect(usage?.usage).not.toHaveProperty("provider_cost");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it("does not promote an upstream-only terminal cost to an account receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor({ finishReason: "error", upstreamInferenceCost: 99 })),
    );

    const events = await collect(
      createRawApiAdapter({ providerUsageCostUnit: "usd" }).run(
        runSpec("review", "upstream-only-terminal"),
      ),
    );
    const usage = events.find((event) => event.type === "usage");

    expect(usage?.usage).toStrictEqual({ input_tokens: 7, output_tokens: 3 });
    expect(usage?.usage).not.toHaveProperty("cost_usd");
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it.each(["implement", "synthesize"] as const)(
    "suppresses a valid partial patch on a terminal %s completion",
    async (intent) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            content: JSON.stringify({ patch }),
            finishReason: "error",
            cost: 0.25,
            error: {
              code: 502,
              message: "Provider unavailable",
              metadata: { error_type: "provider_unavailable" },
            },
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter({ providerUsageCostUnit: "usd" }).run(
          runSpec(intent, `patch-${intent}`),
        ),
      );
      expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
      expect(events.some((event) => event.type === "patch_produced")).toBe(false);
      expect(events.find((event) => event.type === "usage")?.usage).toMatchObject({
        cost_usd: 0.25,
      });
      expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
    },
  );

  it.each([
    ["rate_limit_exceeded", "service_unavailable", true],
    ["provider_overloaded", "service_unavailable", false],
    ["provider_unavailable", "service_unavailable", false],
    ["server", "service_unavailable", false],
    ["timeout", "timeout", false],
  ] as const)(
    "maps documented %s failures onto existing typed retry evidence",
    async (errorType, transientKind, hasRateLimit) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            finishReason: "error",
            error: {
              code: 502,
              message: "typed failure",
              metadata: { error_type: errorType },
            },
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter().run(runSpec("review", `mapping-${errorType}`)),
      );
      const error = events.find((event) => event.type === "error");
      expect(error?.transient).toEqual({ kind: transientKind, retry_delay_ms: null });
      if (hasRateLimit) {
        expect(error?.rate_limit).toEqual({ resets_at: null, retry_delay_ms: null });
      } else {
        expect(error).not.toHaveProperty("rate_limit");
      }
      expect(() => HarnessEvent.parse(error)).not.toThrow();
    },
  );

  it.each(["unknown_future_type", "authentication", "payment_required", "invalid_input", "policy"])(
    "does not invent transient or rate-limit evidence for %s",
    async (errorType) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            error: {
              code: 400,
              message: "deterministic failure",
              metadata: { error_type: errorType },
            },
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter().run(runSpec("review", `deterministic-${errorType}`)),
      );
      const error = events.find((event) => event.type === "error");
      expect(error).not.toHaveProperty("transient");
      expect(error).not.toHaveProperty("rate_limit");
      expect(events.some((event) => event.type === "message")).toBe(false);
      expect(() => HarnessEvent.parse(error)).not.toThrow();
    },
  );

  it("redacts full strings before bounding allowlisted diagnostic evidence", async () => {
    const secret = ["sk", "or", "v1"].join("-") + `-${"s".repeat(48)}`;
    const providerMessage = `${"m".repeat(700)} ${secret}`;
    const partialOutput = `${"p".repeat(700)} ${secret}`;
    const finishReason = `${"f".repeat(700)} ${secret}`;
    const errorType = `${"e".repeat(700)} ${secret}`;
    const providerCode = `${"c".repeat(700)} ${secret}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor({
          content: partialOutput,
          finishReason,
          error: {
            code: 502,
            message: providerMessage,
            metadata: {
              error_type: errorType,
              provider_code: providerCode,
              flagged_input: "unknown metadata sentinel",
            },
            raw: "unknown top-level sentinel",
          },
        }),
      ),
    );

    const events = await collect(createRawApiAdapter().run(runSpec("review", "bounded-error")));
    const error = events.find((event) => event.type === "error");
    expect(error?.error).toBe("raw-api provider completion failed");
    expect(error?.payload).toMatchObject({
      provider_error: {
        code: 502,
      },
      partial_output_truncated: true,
    });
    const payload = error?.payload as {
      finish_reason?: string;
      provider_error?: { message?: string; error_type?: string; provider_code?: string };
      partial_output?: string;
    };
    expect(payload.finish_reason?.length).toBeLessThanOrEqual(500);
    expect(payload.provider_error?.message?.length).toBeLessThanOrEqual(500);
    expect(payload.provider_error?.error_type?.length).toBeLessThanOrEqual(500);
    expect(payload.provider_error?.provider_code?.length).toBeLessThanOrEqual(500);
    expect(payload.partial_output?.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("flagged_input");
    expect(JSON.stringify(error)).not.toContain("unknown metadata sentinel");
    expect(JSON.stringify(error)).not.toContain("unknown top-level sentinel");
  });

  it("redacts a provider diagnostic that straddles the bound before slicing; partial output stays exact", async () => {
    const secret = ["sk", "or", "v1"].join("-") + `-${"z".repeat(48)}`;
    const straddlingPartialOutput = `${"p".repeat(480)} ${secret}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor({
          content: straddlingPartialOutput,
          finishReason: "error",
          error: { code: 502, message: `${"m".repeat(480)} ${secret}` },
        }),
      ),
    );

    const events = await collect(createRawApiAdapter().run(runSpec("review", "straddling-secret")));
    const error = events.find((event) => event.type === "error");
    const payload = error?.payload as {
      provider_error?: { message?: string };
      partial_output?: string;
      partial_output_truncated?: boolean;
    };
    // The provider's message is a diagnostic: masked before it is bounded.
    expect(payload.provider_error?.message).toBe(`${"m".repeat(480)} [redacted]`);
    // The model's partial text is working content: bounded, never masked (INV-146).
    expect(payload.partial_output).toBe(straddlingPartialOutput.slice(0, 500));
    expect(payload.partial_output_truncated).toBe(true);
  });

  it.each([
    [499, 499, false],
    [500, 500, false],
    [501, 500, true],
  ] as const)(
    "marks a %i-character partial output as length %i with truncated=%s",
    async (sourceLength, storedLength, truncated) => {
      const partialOutput = "p".repeat(sourceLength);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            content: partialOutput,
            finishReason: "error",
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter().run(runSpec("review", `diagnostic-boundary-${sourceLength}`)),
      );
      const payload = events.find((event) => event.type === "error")?.payload as {
        partial_output?: string;
        partial_output_truncated?: boolean;
      };
      expect(payload.partial_output).toBe("p".repeat(storedLength));
      expect(payload.partial_output_truncated).toBe(truncated);
    },
  );

  it("accepts either terminal signal, but not a malformed choice error by itself", async () => {
    for (const [sessionId, options] of [
      ["finish-only", { finishReason: "error", error: undefined }],
      [
        "choice-only",
        {
          finishReason: undefined,
          error: { code: 500, message: "failed", metadata: { error_type: "server" } },
        },
      ],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responseFor(options)),
      );
      const events = await collect(createRawApiAdapter().run(runSpec("review", sessionId)));
      expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor({ finishReason: undefined, error: { code: "500" } })),
    );
    const malformed = await collect(createRawApiAdapter().run(runSpec("review", "malformed")));
    expect(malformed.map((event) => event.type)).toEqual([
      "started",
      "message",
      "usage",
      "completed",
    ]);
  });

  it.each(["stop", "length"] as const)(
    "gives a structurally valid choice error precedence over finish_reason:%s",
    async (finishReason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          responseFor({
            finishReason,
            error: {
              code: 502,
              message: "Provider unavailable",
              metadata: { error_type: "provider_unavailable" },
            },
          }),
        ),
      );

      const events = await collect(
        createRawApiAdapter().run(runSpec("review", `${finishReason}-with-choice-error`)),
      );
      expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
      expect(events.some((event) => event.type === "message")).toBe(false);
    },
  );

  it.each(["stop", "length"] as const)(
    "keeps finish_reason:%s successful for both messages and patch envelopes",
    async (finishReason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responseFor({ content: "done", finishReason })),
      );
      const messageEvents = await collect(
        createRawApiAdapter().run(runSpec("explain", `${finishReason}-message`)),
      );
      // A cut answer stays an answer (#144) and says it was cut (#147).
      expect(messageEvents.map((event) => event.type)).toEqual(
        finishReason === "length"
          ? ["started", "message", "status", "usage", "completed"]
          : ["started", "message", "usage", "completed"],
      );

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => responseFor({ content: JSON.stringify({ patch }), finishReason })),
      );
      const patchEvents = await collect(
        createRawApiAdapter().run(runSpec("implement", `${finishReason}-patch`)),
      );
      expect(patchEvents.some((event) => event.type === "patch_produced")).toBe(true);
      expect(patchEvents.some((event) => event.type === "error")).toBe(false);
      expect(patchEvents.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
    },
  );

  it("keeps finish_reason:length successful while preserving trusted cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor({ content: "done", finishReason: "length", cost: 0 })),
    );

    const events = await collect(
      createRawApiAdapter({ providerUsageCostUnit: "usd" }).run(
        runSpec("explain", "length-with-cost"),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "message",
      "status",
      "usage",
      "completed",
    ]);
    expect(events.find((event) => event.type === "status")?.payload).toEqual({
      finish_reason: "length",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "usage")?.usage).toStrictEqual({
      input_tokens: 7,
      output_tokens: 3,
      cost_usd: 0,
    });
    expect(events.every((event) => HarnessEvent.safeParse(event).success)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["rich", [{ type: "text", text: "rich content" }]],
  ] as const)("omits partial-output diagnostics for %s message content", async (label, content) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFor({
          content,
          finishReason: "error",
        }),
      ),
    );
    const events = await collect(createRawApiAdapter().run(runSpec("review", `${label}-content`)));
    const error = events.find((event) => event.type === "error");
    expect(error?.payload).not.toHaveProperty("partial_output");
    expect(error?.payload).not.toHaveProperty("partial_output_truncated");
  });
});

/**
 * INV-146: a failed completion's partial text is the model's own output, and
 * the only copy Claudexor keeps of it. Through the real adapter over HTTP and
 * the shared journal writer it stays exact; the provider's error report stays
 * a masked diagnostic, and the completion stays failed (no answer message).
 */
describe("raw-api failed completion keeps the model's partial output exact", () => {
  const ORIGINAL_ENV = { ...process.env };
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("is exact in the live event and the journal, with the provider error masked", async () => {
    const work = ["sk", "or", "v1"].join("-") + `-${"W0rk".repeat(12)}`;
    const vendor = ["sk", "or", "v1"].join("-") + `-${"V3nd".repeat(12)}`;
    const partial = `Partial answer so far: export OPENROUTER_API_KEY=${work}`;
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "provider-model",
          choices: [
            {
              message: { role: "assistant", content: partial },
              finish_reason: "error",
              error: { code: 502, message: `upstream rejected ${vendor}` },
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    process.env.CLAUDEXOR_TEST_RAWAPI_KEY = "fixture-key";
    const adapter = createRawApiAdapter({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      keyEnv: "CLAUDEXOR_TEST_RAWAPI_KEY",
    });
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(
      HarnessRunSpec.parse({
        session_id: "partial-output",
        intent: "explain",
        prompt: "x",
        cwd: process.cwd(),
        access: "readonly",
        external_context_policy: "auto",
        tool_permission_policy: { web: "auto", allow: [], deny: [] },
      }),
    ))
      events.push(event);

    // The completion stays failed and the partial text never becomes the answer.
    expect(events.map((event) => event.type)).toEqual(["started", "error", "usage", "completed"]);
    const live = events.find((event) => event.type === "error")!;
    expect(live.payload?.["partial_output"]).toBe(partial);
    expect(live.payload?.["partial_output_truncated"]).toBe(false);
    expect(JSON.stringify(live)).not.toContain(vendor);

    const journal = join(reapMk(join(tmpdir(), "raw-api-partial-")), "events.jsonl");
    for (const event of events) appendHarnessEvent(journal, event);
    const stored = readFileSync(journal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as HarnessEvent);
    const error = stored.find((event) => event.type === "error")!;
    expect(error.payload?.["partial_output"]).toBe(partial);
    expect(error.payload?.["provider_error"]).toEqual({
      code: 502,
      message: "upstream rejected [redacted]",
    });
    expect(stored.some((event) => event.type === "message")).toBe(false);
    expect(readFileSync(journal, "utf8")).not.toContain(vendor);
  });
});
