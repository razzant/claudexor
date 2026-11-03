import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@claudexor/core";
import {
  CredentialUnusableLedger,
  DaemonClient,
  DaemonServer,
  ModelSubstitutionLedger,
  QuotaRegistry,
} from "@claudexor/daemon";
import {
  createCodexAdapter,
  createCodexModelAdapter,
  parseCodexRateLimitsResponse,
} from "@claudexor/harness-codex";
import {
  withQuotaAvailability,
  CredentialProfile,
  GlobalConfig,
  ImageCallRequest,
  ImageCallResult,
  ModelCallRequest,
  ModelCallResult,
  type ModelAccountChoice,
  type CredentialProfileStatus,
} from "@claudexor/schema";
import { codexRateLimitEvents } from "../../harness-codex/src/quota.js";
import { accountObservations } from "./account-observations.js";
import { createModelServices } from "./model-services.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const cleanups: Array<() => Promise<void>> = [];
const removals: Array<() => void> = [];
beforeEach(() => accountObservations.invalidate());
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

async function fixture(imageDeps?: Parameters<typeof createCodexModelAdapter>[0]) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-msi-")));
  const sql = await sqlFixture(root);
  const commands = sql.graph.commands;
  const quota = new QuotaRegistry(sql.graph.globalEvents);
  const unusable = new CredentialUnusableLedger();
  const resources = sql.graph.resources;
  const cfg = GlobalConfig.parse({
    credential_profiles: ["a", "b"].map((id) => ({
      profile_id: id,
      harness_id: "codex",
      display_name: id,
      credential_kind: "config_dir_login",
      isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "image-profiles", id),
    })),
  });
  const probe = vi.fn<(profile: CredentialProfile) => Promise<CredentialProfileStatus>>(
    async (profile) => ({
      profile_id: profile.profile_id,
      harness_id: "codex",
      availability: "available",
      verification: "passed",
      verification_source: "local_store",
      detail: "fixture",
      last_verified_at: null,
    }),
  );
  const catalog = vi.fn<ModelAdapter["catalog"]>(async ({ profile }) => ({
    source: "codex",
    credentialProfileId: profile.profile_id,
    accountFingerprint: profile.profile_id,
    observedAt: new Date().toISOString(),
    provenance: "fixture",
    clientVersion: null,
    clientVersionSource: null,
    models: [
      {
        id: "text-model",
        label: null,
        isDefault: true,
        contextWindow: null,
        maxContextWindow: null,
        maxOutputTokens: null,
        inputModalities: ["text"],
        reasoningEfforts: [],
        defaultReasoningEffort: null,
        supportedOptions: [],
      },
    ],
  }));
  const failures = { text: false, image: false };
  const cost = {
    knowledge: "unknown",
    billing: "unknown",
    source: "fixture",
    provenance: ["fixture"],
  };
  const refusal = (image: boolean) => ({
    code: "subscription_window_exhausted",
    message: "fixture limit",
    retryable: false,
    context: {
      resetsAt: new Date(Date.now() + 60000).toISOString(),
      ...(image ? { limitId: "image_gen" } : {}),
    },
  });
  const invoke = vi.fn<ModelAdapter["invoke"]>(async (request, context) => {
    const route = {
      source: "codex",
      credentialProfileId: context.profile.profile_id,
      accountFingerprint: context.profile.profile_id,
      model: request.model,
    };
    await context.onDispatch(route);
    return ModelCallResult.parse({
      outcome: failures.text ? "failed" : "completed",
      route,
      message: failures.text ? null : { role: "assistant", content: "text" },
      usage: {},
      cost,
      appliedOptions: {},
      problem: failures.text ? refusal(false) : null,
    });
  });
  const bytes = Buffer.from("synthetic-image-result");
  const imageInvoke = vi.fn<NonNullable<ModelAdapter["image"]>["invoke"]>(
    imageDeps
      ? createCodexModelAdapter(imageDeps).image!.invoke
      : async (request, context) => {
          const route = {
            source: "codex",
            credentialProfileId: context.profile.profile_id,
            accountFingerprint: context.profile.profile_id,
            model: null,
          };
          await context.onDispatch(route);
          return ImageCallResult.parse({
            outcome: failures.image ? "failed" : "completed",
            route,
            operation: "generate",
            requestedModel: request.model,
            images: failures.image
              ? []
              : [
                  {
                    mime: "image/png",
                    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                    sizeBytes: bytes.length,
                    dataBase64: bytes.toString("base64"),
                    generationId: null,
                  },
                ],
            usage: {},
            cost,
            appliedOptions: {},
            providerRequestId: null,
            problem: failures.image ? refusal(true) : null,
          });
        },
  );
  const adapter: ModelAdapter = {
    id: "codex",
    catalog,
    invoke,
    image: {
      capability: {
        models: ["image-hint"],
        modelsProvenance: "fixture",
        inputMimes: ["image/png"],
        maxInputImages: 5,
        maxInputImagesProvenance: "fixture tool bound",
        supportedOptions: ["n"],
      },
      invoke: imageInvoke,
    },
  };
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cx-msi-${randomUUID()}`
      : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const services = createModelServices({
    commands,
    resourceQueries: commands.queries,
    resources: () => resources,
    client,
    quota: () => quota,
    config: () => cfg,
    unusable,
    substitutions: new ModelSubstitutionLedger(),
    migrationGate: () => null,
    registry: new Map([["codex", { ...createCodexAdapter(), probeCredentialProfile: probe }]]),
    sources: [{ adapter, label: "Codex", credentialHarness: "codex" }],
  });
  const server = new DaemonServer({
    socketPath: socket,
    token: "fixture-control",
    commands,
    runner: (params, context) => services.operations.execute(params, context),
    onCommandTerminal: (record) => services.operations.onCommandTerminal(record),
  });
  await server.start();
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(async () => {
    services.close();
    await server.stop();
    await sql.close();
  });
  const run = async (kind: "image" | "text", account: ModelAccountChoice = { mode: "auto" }) => {
    const request =
      kind === "image"
        ? ImageCallRequest.parse({
            source: "codex",
            model: "explicit-unlisted-image",
            account,
            prompt: "a fox",
          })
        : ModelCallRequest.parse({
            source: "codex",
            model: "text-model",
            account,
            messages: [{ role: "user", content: "hello" }],
          });
    const ref = resources.publishModel(Buffer.from(JSON.stringify(request)));
    const started = await services.routes.createModelOperation(
      ref,
      randomUUID(),
      undefined,
      undefined,
      kind === "image" ? "image" : undefined,
    );
    await vi.waitFor(
      () =>
        expect(["queued", "running"]).not.toContain(services.operations.inspect(started.id).state),
      { timeout: 10_000 },
    );
    return services.operations.inspect(started.id);
  };
  return {
    run,
    cfg,
    probe,
    catalog,
    invoke,
    imageInvoke,
    quota,
    sql,
    unusable,
    failures,
    services,
    adapter,
    resources,
  };
}

// Exercise real image translation/auth with synthetic credentials and a mocked
// provider; no vendor process or external inference is needed by these fixtures.
function provider() {
  const clock = { now: 1900000000000, expiresAt: 1900003600 as number | null };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const response = () => Response.json({ data: [{ b64_json: png.toString("base64") }] });
  const respond = vi.fn<() => Response | Promise<Response>>(response);
  const post = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe("POST");
    await new Response(init?.body).arrayBuffer();
    return respond();
  });
  const refresh = vi.fn(async () => {});
  return {
    clock,
    png,
    respond,
    post,
    refresh,
    response,
    deps: {
      fetch: post,
      now: () => clock.now,
      refresh,
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "fixture-account",
            access_token: `fixture.${Buffer.from(
              JSON.stringify(clock.expiresAt === null ? {} : { exp: clock.expiresAt }),
            ).toString("base64url")}.signature`,
          },
        }),
    },
  };
}

describe("image account resolution through the composed model service", () => {
  it("retains mixed image output and diagnostics through retrieval, replay and whole-result ACK after one POST", async () => {
    const p = provider();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    p.respond.mockImplementation(() =>
      Response.json({
        data: [
          { b64_json: p.png.toString("base64"), generation_id: "first" },
          { b64_json: "@@@@" },
          null,
          { b64_json: jpeg.toString("base64"), generation_id: "last" },
        ],
        usage: { input_tokens: 17, output_tokens: 23 },
        quality: "medium",
      }),
    );
    const f = await fixture(p.deps);
    const request = ImageCallRequest.parse({
      source: "codex",
      model: "explicit-unlisted-image",
      account: { mode: "auto" },
      prompt: "a fox",
      options: { n: 4 },
    });
    const ref = f.resources.publishModel(Buffer.from(JSON.stringify(request)));
    const create = () =>
      f.services.routes.createModelOperation(ref, "mixed", undefined, undefined, "image");
    const started = await create();
    await vi.waitFor(() => expect(f.services.operations.inspect(started.id).state).toBe("failed"), {
      timeout: 10_000,
    });
    expect(f.services.operations.inspect(started.id)).toMatchObject({
      dispatch: { state: "response_received" },
      response: { state: "ready" },
      usage: { input_tokens: 17, output_tokens: 23 },
      problem: { code: "response_rejected", context: { rejectedIndexes: [1, 2] } },
    });
    const stored = f.services.operations.readResult(started.id);
    const result = ImageCallResult.parse(JSON.parse(stored.bytes.toString()));
    expect(result).toMatchObject({
      outcome: "completed",
      appliedOptions: { quality: "medium" },
      usage: { input_tokens: 17, output_tokens: 23 },
      problem: { code: "response_rejected", context: { rejectedIndexes: [1, 2] } },
    });
    expect(result.images.map(({ generationId, dataBase64 }) => [generationId, dataBase64])).toEqual(
      [
        ["first", p.png.toString("base64")],
        ["last", jpeg.toString("base64")],
      ],
    );
    expect((await create()).id).toBe(started.id);
    expect(f.services.operations.readResult(started.id).bytes).toEqual(stored.bytes);
    await expect(
      f.services.routes.acknowledgeModelResult(started.id, `sha256:${"0".repeat(64)}`),
    ).rejects.toThrow();
    expect(f.services.operations.readResult(started.id).bytes).toEqual(stored.bytes);
    await f.services.routes.acknowledgeModelResult(started.id, stored.sha256);
    expect(f.resources.listModelResources()).toEqual([]);
    expect(() => f.services.operations.readResult(started.id)).toThrow(/acknowledged or expired/);
    expect((await create()).response.state).toBe("acknowledged");
    expect(new Headers(p.post.mock.calls[0]![1]!.headers).get("x-codex-image-turn-id")).toBe(
      `img-${started.id}`,
    );
    expect(p.post).toHaveBeenCalledTimes(1);
    expect(f.catalog).not.toHaveBeenCalled();
  });

  it("shares confirmed fresh-token image 401 revocation with image and text routing", async () => {
    const p = provider();
    p.respond.mockImplementationOnce(() => Response.json({}, { status: 401 }));
    const f = await fixture(p.deps);
    expect((await f.run("image")).problem?.code).toBe("auth_required");
    expect(f.unusable.live()).toMatchObject([
      { harness_id: "codex", profile_id: "a", code: "auth_revoked", model: null },
    ]);
    expect(f.quota.read().snapshots).toEqual([]);
    expect(await f.run("image", { mode: "pin", profileId: "a" })).toMatchObject({
      dispatch: { state: "not_started" },
      problem: { code: "auth_required" },
    });
    expect(
      (await f.run("image", { mode: "auto", preferredProfileId: "a" })).dispatch.route
        ?.credentialProfileId,
    ).toBe("b");
    expect((await f.run("text")).dispatch.route?.credentialProfileId).toBe("b");
    expect(p.post).toHaveBeenCalledTimes(2);
    expect(p.refresh).not.toHaveBeenCalled();
  });

  it.each(["expired_in_flight", "opaque", "refresh_unconfirmed"])(
    "does not revoke image credentials when freshness is %s",
    async (freshness) => {
      const p = provider();
      if (freshness === "opaque") p.clock.expiresAt = null;
      if (freshness === "refresh_unconfirmed") p.clock.expiresAt = p.clock.now / 1000 - 1;
      p.respond.mockImplementationOnce(() => {
        if (freshness === "expired_in_flight") p.clock.now = p.clock.expiresAt! * 1000;
        return Response.json({}, { status: 401 });
      });
      const f = await fixture(p.deps);
      expect((await f.run("image")).problem?.code).toBe("auth_refresh_failed");
      expect(f.unusable.live()).toEqual([]);
      expect(f.quota.read().snapshots).toEqual([]);
      expect(p.post).toHaveBeenCalledTimes(freshness === "refresh_unconfirmed" ? 0 : 1);
      expect(p.refresh).toHaveBeenCalledTimes(freshness === "refresh_unconfirmed" ? 1 : 0);
    },
  );

  it("does not let a late image 401 revoke credentials replaced during the POST", async () => {
    const p = provider();
    const f = await fixture(p.deps);
    p.respond.mockImplementationOnce(() => {
      f.unusable.clearSubject("codex", "a");
      return Response.json({}, { status: 401 });
    });
    expect((await f.run("image")).problem?.code).toBe("auth_required");
    expect(f.unusable.live()).toEqual([]);
    expect(f.quota.read().snapshots).toEqual([]);
    expect((await f.run("image")).dispatch.route?.credentialProfileId).toBe("a");
    expect(p.post).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429])(
    "keeps image HTTP %s entitlement/quota evidence out of text routing",
    async (status) => {
      const p = provider();
      p.respond.mockImplementationOnce(() =>
        Response.json(
          {
            error: {
              code: status === 403 ? "model_not_found" : "usage_limit_reached",
              resets_at: 1900003600,
            },
          },
          { status, headers: { "x-codex-active-limit": "image_gen" } },
        ),
      );
      const f = await fixture(p.deps);
      const before = f.quota.read();
      expect((await f.run("image")).state).toBe("failed");
      if (status === 403) expect(f.quota.read()).toEqual(before);
      else {
        expect(f.quota.read().snapshots).toMatchObject([
          {
            source: "codex_image_response",
            constraints: [{ applies_to_request_kinds: ["image"] }],
          },
        ]);
        expect((await f.run("image", { mode: "pin", profileId: "a" })).problem?.code).toBe(
          "subscription_window_exhausted",
        );
        expect(p.post).toHaveBeenCalledTimes(1);
        expect((await f.run("image")).dispatch.route?.credentialProfileId).toBe("b");
      }
      expect(f.unusable.live()).toEqual([]);
      expect((await f.run("text")).dispatch.route?.credentialProfileId).toBe("a");
      expect(p.post).toHaveBeenCalledTimes(status === 403 ? 1 : 2);
    },
  );

  it("forwards an explicit unlisted model without reading the text catalog and keeps a preferred account", async () => {
    const f = await fixture();
    const done = await f.run("image", { mode: "auto", preferredProfileId: "b" });
    expect(done).toMatchObject({
      state: "succeeded",
      dispatch: { route: { credentialProfileId: "b", model: null } },
    });
    expect(f.imageInvoke).toHaveBeenCalledTimes(1);
    expect(f.imageInvoke.mock.calls[0]![0].model).toBe("explicit-unlisted-image");
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(["unknown", "disabled", "api_key", "probe_failed", "revoked"])(
    "keeps a %s pin strict without fallback",
    async (reason) => {
      const f = await fixture();
      if (reason === "disabled") f.cfg.credential_profiles[0]!.enabled = false;
      if (reason === "api_key")
        f.cfg.credential_profiles[0] = CredentialProfile.parse({
          profile_id: "a",
          harness_id: "codex",
          display_name: "API",
          credential_kind: "api_key",
          secret_ref: "openai:a",
        });
      if (reason === "probe_failed")
        f.probe.mockImplementation(async (profile) => ({
          profile_id: profile.profile_id,
          harness_id: "codex",
          availability: "unknown",
          verification: "failed",
          verification_source: "local_store",
          detail: "fixture failure",
          last_verified_at: null,
        }));
      if (reason === "revoked")
        f.unusable.record({
          harness_id: "codex",
          profile_id: "a",
          code: "auth_revoked",
          source: "attempt_stream",
          detail: "fixture revocation",
          model: null,
          observed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60000).toISOString(),
        });
      const done = await f.run("image", {
        mode: "pin",
        profileId: reason === "unknown" ? "missing" : "a",
      });
      expect(done.state).toBe("failed");
      expect(done.dispatch.state).toBe("not_started");
      if (reason === "revoked") expect(done.problem?.code).toBe("auth_required");
      expect(f.imageInvoke).not.toHaveBeenCalled();
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );

  it("does not let an image refusal poison text quota or rotate the text pool", async () => {
    const f = await fixture();
    f.failures.image = true;
    const before = f.quota.read();
    expect((await f.run("image")).problem?.context.limitId).toBe("image_gen");
    expect(f.quota.read()).toEqual(before);
    expect(f.unusable.live()).toEqual([]);
    expect((await f.run("text")).dispatch.route?.credentialProfileId).toBe("a");
    expect(f.imageInvoke).toHaveBeenCalledTimes(1);
  });

  it("ignores text windows for image Auto, preferred and pin while text still rotates/refuses", async () => {
    const f = await fixture();
    f.failures.text = true;
    await f.run("text", { mode: "pin", profileId: "a" });
    expect(f.quota.read().snapshots).not.toHaveLength(0);
    f.failures.text = false;
    expect((await f.run("text")).dispatch.route?.credentialProfileId).toBe("b");
    expect((await f.run("text", { mode: "pin", profileId: "a" })).problem?.code).toBe(
      "subscription_window_exhausted",
    );
    for (const account of [
      { mode: "auto" },
      { mode: "auto", preferredProfileId: "a" },
      { mode: "pin", profileId: "a" },
    ] as const) {
      expect(await f.run("image", account)).toMatchObject({
        state: "succeeded",
        dispatch: { route: { credentialProfileId: "a" } },
      });
    }
  });

  it("projects adapter capability only in the negotiated account view", async () => {
    const f = await fixture();
    expect(await f.services.routes.modelSources("accounts")).toMatchObject({
      sources: [{ imageGeneration: f.adapter.image!.capability }],
    });
    expect(await f.services.routes.modelSources()).toEqual({
      sources: [{ id: "codex", label: "Codex", credentialHarness: "codex" }],
    });
    expect(f.catalog).not.toHaveBeenCalled();
  });
});

describe("visible request-kind quota through the actual shared admission path", () => {
  it("keeps full and incremental image exhaustion visible while text uses the same account", async () => {
    const f = await fixture();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const full = (used: number) => ({
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset } },
        image_gen: { primary: { usedPercent: used, windowDurationMins: 1440, resetsAt: reset } },
      },
    });
    for (const row of parseCodexRateLimitsResponse(full(100), new Date(), "a")) f.quota.upsert(row);
    const raw = f.quota.read();
    expect(raw.snapshots[0]!.constraints.map((c) => c.applies_to_request_kinds)).toEqual([
      ["text"],
      ["image"],
    ]);
    expect(withQuotaAvailability(raw).snapshots[0]?.availability?.state).toBe("available");
    expect(
      withQuotaAvailability(raw, { requestKind: "image" }).snapshots[0]?.availability?.state,
    ).toBe("exhausted");
    expect((await f.run("text")).dispatch.route?.credentialProfileId).toBe("a");
    expect((await f.run("image", { mode: "pin", profileId: "a" })).problem?.code).toBe(
      "subscription_window_exhausted",
    );
    expect(f.imageInvoke).not.toHaveBeenCalled();
    expect(
      (await f.run("image", { mode: "auto", preferredProfileId: "a" })).dispatch.route
        ?.credentialProfileId,
    ).toBe("b");
    // A later notification changes its own image window, never the text window.
    for (const event of codexRateLimitEvents(full(20), "native"))
      f.quota.ingest("codex", {
        ...event,
        credential_route: "vendor_native",
        credential_profile_id: "a",
      });
    // Full refresh supersedes matching incremental identities and previous full measurements.
    const newer = new Date(Date.now() + 10);
    for (const row of parseCodexRateLimitsResponse(full(20), newer, "a")) f.quota.upsert(row);
    const restarted = new QuotaRegistry(f.sql.graph.globalEvents).read();
    expect(
      restarted.snapshots.some((s) =>
        s.constraints.some((c) => c.applies_to_request_kinds?.includes("image")),
      ),
    ).toBe(true);
    expect(
      withQuotaAvailability(restarted, { requestKind: "image" }).snapshots.every(
        (s) => s.availability?.state === "available",
      ),
    ).toBe(true);
    expect((await f.run("image", { mode: "pin", profileId: "a" })).state).toBe("succeeded");
  });
});

it("does not attach a late image 429 to replacement credentials", async () => {
  const p = provider();
  const f = await fixture(p.deps);
  p.respond.mockImplementationOnce(() => {
    f.unusable.clearSubject("codex", "a");
    return Response.json(
      { error: { code: "usage_limit_reached", resets_at: 1900003600 } },
      { status: 429 },
    );
  });
  expect((await f.run("image")).problem?.code).toBe("image_generation_limit_reached");
  expect(f.quota.read().snapshots).toEqual([]);
  expect(f.unusable.live()).toEqual([]);
});
