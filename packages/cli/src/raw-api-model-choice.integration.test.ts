/**
 * #395 through the production path: a Raw API request names only a model
 * somebody chose. The real Orchestrator, the real adapter and the real registry
 * talk to a LOCAL endpoint, so "nothing was sent" and "this model was sent" are
 * read from the bytes it received. The precedence is run, then saved, then the
 * instance's own operator choice; below that there is nothing.
 */
import { mkdirSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRawApiAdapter } from "@claudexor/harness-raw-api";
import { Orchestrator } from "@claudexor/orchestrator";
import { CredentialProfile, type HarnessRunSpec } from "@claudexor/schema";
import { SecretStore } from "@claudexor/secrets";
import { noProjectRepoRoot } from "@claudexor/util";
import { buildRegistry } from "./registry.js";
import {
  KEY_ENV,
  asDoctorOk,
  attemptRecord,
  committed,
  failureRecord,
  nativeReader,
  removeOwnedDirs,
  runEvents,
  sentPacket,
  startLoopback,
  telemetryRecord,
  useConfig,
  withProfileProbe,
  type Loopback,
} from "./test-support/raw-api-loopback.js";

// Real Git runs: the timeouts detect hangs, and a busy machine is not one.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

const MODEL_ENV = "CLAUDEXOR_TEST_RAW_CONTRACT_MODEL";
const PATCH =
  "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# repo\n+# raw\n";

let provider: Loopback;
beforeAll(async () => {
  provider = await startLoopback();
});
afterAll(async () => {
  await provider.stop();
});
beforeEach(() => {
  provider.reset();
  process.env[KEY_ENV] = "sk-contract";
});
afterEach(() => {
  delete process.env[KEY_ENV];
  vi.unstubAllEnvs();
  removeOwnedDirs();
});

const openrouter = (extra: Record<string, unknown> = {}) =>
  createRawApiAdapter({
    id: "openrouter",
    providerFamily: "unknown",
    baseUrl: provider.baseUrl,
    keyEnv: KEY_ENV,
    modelEnv: MODEL_ENV,
    ...extra,
  } as Parameters<typeof createRawApiAdapter>[0]);

const noProject = () => {
  const root = noProjectRepoRoot();
  mkdirSync(root, { recursive: true });
  return root;
};

/** One isolated raw Agent attempt. */
const runAgent = (adapter = openrouter(), input: Record<string, unknown> = {}) =>
  new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] }).run({
    repoRoot: committed(),
    prompt: "Update the heading",
    mode: "agent",
    harnesses: [adapter.id],
    n: 1,
    ...input,
  });

/** One no-project Ask. */
const runAsk = (adapter = openrouter(), input: Record<string, unknown> = {}) =>
  new Orchestrator({ registry: new Map([[adapter.id, adapter]]), reviewers: [] }).run({
    repoRoot: noProject(),
    prompt: "2+2?",
    mode: "ask",
    contextMode: "off",
    harnesses: [adapter.id],
    ...input,
  });

/** The requested model on the run's final attempt receipt. */
const requestedModel = (runDir: string) => {
  const telemetry = telemetryRecord(runDir);
  return telemetry.attempts.find((a) => a.attempt_id === telemetry.final_attempt_id)
    ?.requested_model;
};

describe("a request without a chosen model is never sent (#395)", () => {
  it.each([
    ["Agent", () => runAgent()],
    ["Ask", () => runAsk()],
  ])("%s without any choice refuses before spending, naming the remedy once", async (_m, run) => {
    const result = await run();
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    const failure = failureRecord(result.runDir);
    expect(failure.code).toBe("model_selection_required");
    expect(failure.category).toBe("config_error");
    expect(failure.phase).toBe("routing");
    expect(failure.safeMessage).toContain("openrouter needs a model and none is selected");
    expect(failure.safeMessage).toContain("nothing was sent");
    expect(failure.safeMessage).toContain("claudexor models --harness openrouter");
    expect(failure.safeMessage).toContain(
      "claudexor settings set harness.openrouter.default_model",
    );
    expect(failure.safeMessage).toContain(MODEL_ENV);
    expect(failure.nextActions.join("\n")).toContain("default_model");
  });

  it.each([
    ["blank run model", () => runAsk(openrouter(), { models: { openrouter: "   " } })],
    ["blank instance model", () => runAsk(openrouter({ defaultModel: "  " }))],
    [
      "blank environment model",
      () => {
        vi.stubEnv(MODEL_ENV, "   ");
        return runAsk();
      },
    ],
    [
      "blank saved model",
      () => {
        useConfig({ harnesses: { openrouter: { default_model: "  " } } });
        return runAsk();
      },
    ],
  ])("a %s is no model", async (_name, run) => {
    const result = await run();
    expect(provider.posts).toEqual([]);
    expect(failureRecord(result.runDir).code).toBe("model_selection_required");
  });

  it("a pinned saved account is refused the same way", async () => {
    const profile = CredentialProfile.parse({
      profile_id: "work",
      harness_id: "openrouter",
      display_name: "Work",
      credential_kind: "api_key",
      secret_ref: "openrouter:work",
      enabled: true,
    });
    useConfig({ credential_profiles: [profile] });
    new SecretStore().set("openrouter:work", "sk-contract-work");
    const adapter = withProfileProbe(openrouter());
    const result = await new Orchestrator({
      registry: new Map([[adapter.id, adapter]]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      credentialProfileId: "work",
    });
    expect(provider.posts).toEqual([]);
    expect(failureRecord(result.runDir).code).toBe("model_selection_required");
  });

  it("Auto skips an unselected proved route with its reason; another route runs", async () => {
    const local: HarnessRunSpec[] = [];
    // Its own id: the doctor's answer for `openrouter` at this root is already cached.
    const adapter = asDoctorOk(openrouter({ id: "proved-route" }));
    const result = await new Orchestrator({
      registry: new Map([
        [adapter.id, adapter],
        ["reader", nativeReader("reader", "anthropic", local)],
      ]),
      reviewers: [],
    }).run({ repoRoot: noProject(), prompt: "2+2?", mode: "ask", contextMode: "off" });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts).toEqual([]);
    expect(local).toHaveLength(1);
    const degraded = runEvents(result.runDir).find((e) => e.type === "route.pool.degraded");
    expect(degraded?.payload["dropped_lanes"]).toEqual([
      expect.objectContaining({ harness_id: "proved-route", stage: "model" }),
    ]);
  });

  it("no alternative provider or model stands in for the refused one", async () => {
    const local: HarnessRunSpec[] = [];
    const adapter = openrouter();
    const result = await new Orchestrator({
      registry: new Map([
        [adapter.id, adapter],
        ["reader", nativeReader("reader", "anthropic", local)],
      ]),
      reviewers: [],
    }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      harnesses: ["openrouter", "reader"],
    });
    expect(result.lifecycle).toBe("failed");
    expect(provider.posts).toEqual([]);
    expect(local).toEqual([]);
  });

  it("the adapter itself refuses a model-less direct dispatch before any POST (a continuity summary)", async () => {
    const events: Array<{ type: string; error?: string }> = [];
    for await (const event of openrouter().run({
      session_id: "direct",
      intent: "explain",
      prompt: "Summarize",
      cwd: noProject(),
      model_hint: null,
      attachments: [],
      extra: {},
    } as unknown as HarnessRunSpec))
      events.push(event as { type: string; error?: string });
    expect(provider.posts).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error", "completed"]);
    expect(events[0]?.error).toContain("needs a model and none is selected");
  });
});

describe("the chosen model reaches admission, sizing, the POST and the receipt (#395)", () => {
  it("a run override is admitted, sizes the packet, is sent and is the receipt, byte-identical", async () => {
    provider.answers = [{ patch: PATCH }];
    const result = await runAgent(openrouter(), { models: { openrouter: "vendor/big" } });
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts[0]!.body.model).toBe("vendor/big");
    expect(sentPacket(provider.posts[0]).budget?.model).toBe("vendor/big");
    expect(requestedModel(result.runDir)).toBe("vendor/big");
    expect(provider.gets.length).toBeGreaterThan(0); // the catalog was read to admit it
  });

  it("a saved harness default needs no run choice, once saved", async () => {
    useConfig({ harnesses: { openrouter: { default_model: "vendor/big" } } });
    provider.answers = [{ patch: PATCH }];
    const result = await runAgent();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts[0]!.body.model).toBe("vendor/big");
    expect(sentPacket(provider.posts[0]).budget?.model).toBe("vendor/big");
    expect(requestedModel(result.runDir)).toBe("vendor/big");
  });

  it("an environment choice is admitted like any other and discloses where it came from", async () => {
    vi.stubEnv(MODEL_ENV, "vendor/big");
    provider.answers = [{ patch: PATCH }];
    const result = await runAgent();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts[0]!.body.model).toBe("vendor/big");
    expect(sentPacket(provider.posts[0]).budget?.model).toBe("vendor/big");
    expect(requestedModel(result.runDir)).toBe("vendor/big");
    expect(provider.gets.length).toBeGreaterThan(0);
    expect(attemptRecord(result.runDir)).not.toContain("process_crash");
    const titles = JSON.stringify(runEvents(result.runDir));
    expect(titles).toContain(MODEL_ENV);
  });

  it("the precedence is run over saved over environment", async () => {
    provider.catalog = ["vendor/run", "vendor/saved", "vendor/env"];
    vi.stubEnv(MODEL_ENV, "vendor/env");
    useConfig({ harnesses: { openrouter: { default_model: "vendor/saved" } } });
    await runAsk(openrouter(), { models: { openrouter: "vendor/run" } });
    expect(provider.posts.at(-1)!.body.model).toBe("vendor/run");
    await runAsk();
    expect(provider.posts.at(-1)!.body.model).toBe("vendor/saved");
    useConfig({});
    await runAsk();
    expect(provider.posts.at(-1)!.body.model).toBe("vendor/env");
  });

  it("an instance model and the environment are one operator choice, instance first", async () => {
    provider.catalog = ["vendor/instance", "vendor/env"];
    vi.stubEnv(MODEL_ENV, "vendor/env");
    await runAsk(openrouter({ defaultModel: "vendor/instance" }));
    expect(provider.posts.at(-1)!.body.model).toBe("vendor/instance");
  });
});

describe("a chosen model keeps the catalog's verdict (#395 x INV-104)", () => {
  it.each([
    ["run", () => runAsk(openrouter(), { models: { openrouter: "vendor/absent" } })],
    [
      "environment",
      () => {
        vi.stubEnv(MODEL_ENV, "vendor/absent");
        return runAsk();
      },
    ],
    [
      "saved",
      () => {
        useConfig({ harnesses: { openrouter: { default_model: "vendor/absent" } } });
        return runAsk();
      },
    ],
  ])("a %s model the catalog proves absent refuses before any POST", async (_name, run) => {
    const result = await run();
    expect(provider.posts).toEqual([]);
    expect(result.lifecycle).toBe("failed");
    expect(result.summary).toContain("refused model 'vendor/absent' (truth source: api)");
  });

  it.each([
    ["run", () => runAsk(openrouter(), { models: { openrouter: "vendor/unlisted" } })],
    [
      "environment",
      () => {
        vi.stubEnv(MODEL_ENV, "vendor/unlisted");
        return runAsk();
      },
    ],
  ])("a %s model on an unavailable catalog is forwarded unchanged and says so", async (_n, run) => {
    provider.catalog = 503;
    const result = await run();
    expect(result.lifecycle, result.summary).toBe("succeeded");
    expect(provider.posts.map((post) => post.body.model)).toEqual(["vendor/unlisted"]);
    expect(JSON.stringify(runEvents(result.runDir))).toContain(
      'model \\"vendor/unlisted\\" could not be verified',
    );
  });

  it("a rejected key still refuses a chosen model, sending nothing", async () => {
    provider.catalog = 401;
    const result = await runAsk(openrouter(), { models: { openrouter: "vendor/big" } });
    expect(provider.posts).toEqual([]);
    expect(failureRecord(result.runDir).code).toBe("model_catalog_unavailable");
  });
});

describe("the real registry's two instances (#395)", () => {
  const useRegistry = () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-contract-or");
    vi.stubEnv("CLAUDEXOR_OPENROUTER_BASE_URL", provider.baseUrl);
    vi.stubEnv("CLAUDEXOR_RAWAPI_KEY", "sk-contract-raw");
    vi.stubEnv("CLAUDEXOR_RAWAPI_BASE_URL", provider.baseUrl);
    return buildRegistry({ includeFakes: false });
  };
  const askOn = (registry: ReturnType<typeof buildRegistry>, id: string) =>
    new Orchestrator({ registry, reviewers: [] }).run({
      repoRoot: noProject(),
      prompt: "2+2?",
      mode: "ask",
      contextMode: "off",
      harnesses: [id],
    });

  it.each(["openrouter", "raw-api"])("%s has no hidden model: nothing is sent", async (id) => {
    const result = await askOn(useRegistry(), id);
    expect(provider.posts).toEqual([]);
    expect(failureRecord(result.runDir).code).toBe("model_selection_required");
  });

  it("each instance reads only its own variable", async () => {
    provider.catalog = ["vendor/raw", "vendor/or"];
    vi.stubEnv("CLAUDEXOR_RAWAPI_MODEL", "vendor/raw");
    const generic = await askOn(useRegistry(), "raw-api");
    expect(generic.lifecycle, generic.summary).toBe("succeeded");
    expect(provider.posts.map((post) => post.body.model)).toEqual(["vendor/raw"]);
    // The generic instance's choice does not reach OpenRouter.
    provider.posts.length = 0;
    const leaked = await askOn(useRegistry(), "openrouter");
    expect(provider.posts).toEqual([]);
    expect(failureRecord(leaked.runDir).code).toBe("model_selection_required");
    // Its own variable does, and the other instance keeps its own.
    vi.stubEnv("CLAUDEXOR_OPENROUTER_MODEL", "vendor/or");
    const own = await askOn(useRegistry(), "openrouter");
    expect(own.lifecycle, own.summary).toBe("succeeded");
    expect(provider.posts.map((post) => post.body.model)).toEqual(["vendor/or"]);
  });
});
