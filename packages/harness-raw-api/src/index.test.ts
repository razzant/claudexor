import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: never read this dev machine's stored secrets — the only key that
// resolves is the env var the test sets (or none). Must be mocked before the
// adapter module loads.
vi.mock("@claudexor/secrets", () => ({ resolveSecret: () => null }));

import { HarnessRunSpec } from "@claudexor/schema";
import { createRawApiAdapter } from "./index.js";

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
    expect(error?.transient?.kind).toBe("service_unavailable");
  });
});

describe("raw-api immutable attachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("places an admitted generic-file sentinel in the vendor payload after digest verification", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const dir = mkdtempSync(join(tmpdir(), "claudexor-raw-attachment-"));
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
    const dir = mkdtempSync(join(tmpdir(), "claudexor-raw-digest-"));
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

describe("raw-api typed patch producer", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  it("advertises implement only with the git-patch transport and emits a typed envelope", async () => {
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
    const events = await collect(
      adapter.run(
        HarnessRunSpec.parse({
          session_id: "raw1",
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
    expect(events.find((event) => event.type === "patch_produced")?.patch_envelope?.patch).toBe(
      patch,
    );
    expect(events.find((event) => event.type === "patch_produced")?.patch_envelope).toMatchObject({
      context_packet_hash: "sha256:packet",
      base_tree_sha: "tree",
      patch_hash: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
      touched_paths: [{ path: "a.txt", expected_blob_oid: "blob" }],
    });
    expect(events.some((event) => event.type === "message")).toBe(false);
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
});
