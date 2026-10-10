import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "@claudexor/core";
import {
  ControlModelOperationDetail,
  CredentialProfile,
  ModelCallRequest,
  ModelCallResult,
  ModelOperationParams,
  type ModelPayloadRef,
} from "@claudexor/schema";
import { DaemonClient } from "./client.js";
import { DaemonServer } from "./server.js";
import { ModelOperations } from "./model-operations.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";
import { createCodexModelAdapter } from "../../harness-codex/src/model.js";
import effortFixture from "../../schema/fixtures/effort-resolution.json" with { type: "json" };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const request = (content = "own conversation") =>
  ModelCallRequest.parse({
    source: "codex",
    model: "test-model",
    account: { mode: "pin", profileId: "fixture" },
    messages: [{ role: "system", content }],
  });
const route = {
  source: "codex",
  credentialProfileId: "fixture",
  accountFingerprint: "account-A",
  model: "test-model",
};
const result = () =>
  ModelCallResult.parse({
    outcome: "completed",
    message: { role: "assistant", content: "exact result 🦉" },
    route,
    usage: { input_tokens: 3, output_tokens: 2 },
    cost: { knowledge: "unknown", billing: "unknown", source: "fixture", provenance: ["test"] },
    appliedOptions: {},
    problem: null,
  });

async function fixture(
  invoke?: ModelAdapter["invoke"],
  history: { maxHistory?: number; idempotencyRetentionMs?: number } = {},
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-mo-")));
  let clock = new Date();
  const sql = await sqlFixture(root, () => clock);
  const store = sql.graph.commands.current();
  const commands = sql.graph.commands;
  const resources = sql.graph.resources;
  const socket =
    process.platform === "win32" ? `\\\\.\\pipe\\cx-mo-${randomUUID()}` : join(root, "daemon.sock");
  const client = new DaemonClient(socket, "fixture-control");
  const sends = vi.fn();
  const adapter: ModelAdapter = {
    id: "codex",
    catalog: vi.fn(),
    invoke:
      invoke ??
      (async (_input, context) => {
        await context.onDispatch(route);
        sends();
        return result();
      }),
  };
  const profile = CredentialProfile.parse({
    profile_id: "fixture",
    harness_id: "codex",
    display_name: "Fixture",
    credential_kind: "config_dir_login",
    isolation_locator: join(root, "profile"),
  });
  const operations = new ModelOperations({
    commands,
    resourceQueries: commands.queries,
    resources: () => resources,
    now: () => clock,
    enqueue: (envelope) => client.call("claudexor.enqueue", envelope),
    cancel: (id, reason) => client.cancel(id, reason),
    resolve: async () => ({ adapter, profile }),
  });
  const server = new DaemonServer({
    ...history,
    socketPath: socket,
    token: "fixture-control",
    commands,
    maxConcurrent: 1,
    runner: (input, context) => operations.execute(input, context),
    onCommandTerminal: (record) => operations.onCommandTerminal(record),
  });
  await server.start();
  cleanup.push(async () => {
    await server.stop();
    operations.close();
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  });
  const upload = (body = request()): ModelPayloadRef =>
    resources.publishModel(Buffer.from(JSON.stringify(body)));
  const terminal = async (id: string) => {
    await vi.waitFor(
      () => expect(["queued", "running"]).not.toContain(operations.inspect(id).state),
      { timeout: 10_000, interval: 5 },
    );
    return operations.inspect(id);
  };
  return {
    root,
    sql,
    records: sql.records,
    store,
    resources,
    operations,
    server,
    client,
    sends,
    upload,
    terminal,
    setNow: (time: Date) => {
      clock = time;
    },
  };
}

describe("model operations over the existing daemon command substrate", () => {
  it("refines a journaled send only after native connection non-delivery, retaining its attempt and replay", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("fixture listener missing");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const nativeFetch = globalThis.fetch;
    const posts = vi.fn();
    const adapter = createCodexModelAdapter({
      now: () => 1900000000000,
      clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            account_id: "fixture",
            access_token: `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`,
          },
        }),
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ models: [{ slug: "test-model" }] });
        const running = f.records()[0]!;
        expect(f.operations.inspect(running.id).dispatch).toMatchObject({
          state: "started",
          startedAt: expect.any(String),
        });
        posts();
        return nativeFetch(`http://127.0.0.1:${address.port}`, init);
      },
    });
    const f = await fixture((input, context) =>
      adapter.invoke(input, {
        ...context,
        profile: {
          ...context.profile,
          isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
        },
      }),
    );
    const created = await f.operations.create(f.upload(), "connection-proof");
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "failed",
      dispatch: {
        state: "not_started",
        startedAt: expect.any(String),
        route: { model: "test-model" },
      },
      problem: {
        code: "transport_not_delivered",
        retryable: true,
        context: {
          generationStarted: false,
          stage: "fetch",
          errorCode: "ECONNREFUSED",
          requestDelivery: { basis: "connect_failure", handedOffBytes: null },
        },
      },
    });
    const stored = f.operations.readResult(created.id);
    expect(ModelCallResult.parse(JSON.parse(stored.bytes.toString()))).toMatchObject({
      outcome: "failed",
      message: null,
      usage: { input_tokens: null },
      cost: { knowledge: "unknown", cashUsd: null },
    });
    const replay = await f.operations.create(f.upload(), "connection-proof");
    expect(replay.id).toBe(created.id);
    expect(replay.dispatch).toEqual(done.dispatch);
    expect(f.operations.readResult(created.id).bytes.equals(stored.bytes)).toBe(true);
    expect(posts).toHaveBeenCalledTimes(1);
  });

  it("keeps a publication failure after a no-generation proof unresolved", async () => {
    const f = await fixture(async (_request, context) => {
      await context.onDispatch(route);
      return {
        ...result(),
        outcome: "failed",
        message: null,
        problem: {
          code: "transport_not_delivered",
          message: "fixture proof",
          retryable: true,
          fieldErrors: {},
          requiredActions: [],
          evidenceRefs: [],
          context: {
            generationStarted: false,
            requestDelivery: { state: "not_delivered", basis: "incomplete_upload" },
          },
        },
      };
    });
    const ref = f.upload();
    vi.spyOn(f.resources, "publishModel").mockImplementation(() => {
      throw new Error("fixture publication unavailable");
    });
    const created = await f.operations.create(ref, "proof-not-published");
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "interrupted",
      dispatch: { state: "unknown", startedAt: expect.any(String) },
      response: { state: "absent" },
    });
  });

  it.each([undefined, false, true])(
    "captures effort only with negotiated intent (%s) through HTTP, restart, replay and ACK",
    async (captureEffortEvidence) => {
      const posts = vi.fn();
      const adapter = createCodexModelAdapter({
        now: () => 1900000000000,
        clientVersion: async () => ({ version: "0.156.1", source: "verified_transport" }),
        readAuthFile: async () =>
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              account_id: "fixture",
              access_token: `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`,
            },
          }),
        fetch: async (_url, init) => {
          if (init?.method === "POST") {
            posts(JSON.parse(await new Response(init.body).text()).reasoning.effort);
            return new Response(
              `data: ${JSON.stringify({ type: "response.completed", response: { model: "test-model", output: [] } })}\n\n`,
            );
          }
          return Response.json({
            models: [
              {
                slug: "test-model",
                supported_reasoning_levels: [{ effort: "low" }, { effort: "xhigh" }],
              },
              {
                slug: "sibling",
                supported_reasoning_levels: [
                  { effort: "low" },
                  { effort: "xhigh" },
                  { effort: "ultra" },
                ],
              },
            ],
          });
        },
      });
      const f = await fixture((input, context) =>
        adapter.invoke(input, {
          ...context,
          profile: {
            ...context.profile,
            isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
          },
        }),
      );
      const api = new DaemonControlApiServer({
        token: "fixture-control",
        daemon: f.client,
        services: {
          createModelOperation: f.operations.create.bind(f.operations),
          getModelOperation: async (id) => f.operations.inspect(id),
          readModelResult: async (id) => f.operations.readResult(id),
          acknowledgeModelResult: async (id, digest) => f.operations.acknowledge(id, digest),
        },
      });
      const address = await api.start();
      cleanup.push(() => api.stop());
      const endpoint = `http://${address.host}:${address.port}/v2/model-operations`;
      const headers = {
        Authorization: "Bearer fixture-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": "effort-custody",
      };
      const body = request();
      body.options.reasoningEffort = effortFixture.requested;
      const ref = f.upload(body);
      const captureQuery =
        captureEffortEvidence === undefined
          ? ""
          : `?captureEffortEvidence=${captureEffortEvidence}`;
      const post = (query = captureQuery) =>
        fetch(`${endpoint}${query}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ request: ref }),
        });
      const createdResponse = await post();
      expect(createdResponse.status).toBe(202);
      const created = ControlModelOperationDetail.parse(await createdResponse.json());
      await f.terminal(created.id);
      const response = await fetch(`${endpoint}/${created.id}/result`, { headers });
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const parsed = JSON.parse(bytes.toString());
      if (captureEffortEvidence === true) expect(parsed.effortResolution).toEqual(effortFixture);
      else expect(parsed).not.toHaveProperty("effortResolution");
      // Frozen pre-effort top-level strict result fields, including real provider echoes.
      expect(Object.keys(parsed).sort()).toEqual(
        [
          "appliedOptions",
          "cost",
          ...(captureEffortEvidence ? ["effortResolution"] : []),
          "message",
          "outcome",
          "problem",
          "route",
          "usage",
        ].sort(),
      );
      expect(parsed.appliedOptions).toEqual({});
      const stored = f.operations.readResult(created.id);
      const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      expect(stored.bytes.equals(bytes)).toBe(true);
      expect(stored.sha256).toBe(digest);
      expect(response.headers.get("etag")).toBe(`"${digest}"`);
      expect(f.operations.readResult(created.id).bytes.equals(bytes)).toBe(true);
      expect(((await (await post()).json()) as { id: string }).id).toBe(created.id);
      expect((await post(`?captureEffortEvidence=${captureEffortEvidence !== true}`)).status).toBe(
        409,
      );
      const params = f.store.get(created.id)!.params;
      if (captureEffortEvidence === true)
        expect(params).toHaveProperty("captureEffortEvidence", true);
      else expect(params).not.toHaveProperty("captureEffortEvidence");
      await api.stop();
      await f.server.stop();
      f.operations.close();
      await f.sql.close();
      const sql = await sqlFixture(f.root);
      const resources = sql.graph.resources;
      const reopened = new ModelOperations({
        commands: sql.graph.commands,
        resourceQueries: sql.graph.commands.queries,
        resources: () => resources,
        enqueue: async () => {
          throw new Error("replay cannot enqueue");
        },
        cancel: async () => {
          throw new Error("replay cannot cancel");
        },
        resolve: async () => {
          throw new Error("replay cannot resolve a provider");
        },
      });
      cleanup.push(async () => {
        reopened.close();
        await sql.close();
      });
      expect(reopened.readResult(created.id).bytes.equals(bytes)).toBe(true);
      expect(
        (await reopened.create(ref, "effort-custody", undefined, captureEffortEvidence)).id,
      ).toBe(created.id);
      await expect(
        reopened.create(ref, "effort-custody", undefined, captureEffortEvidence !== true),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const restartedApi = new DaemonControlApiServer({
        token: "fixture-control",
        daemon: f.client,
        services: {
          readModelResult: async (id) => reopened.readResult(id),
          acknowledgeModelResult: async (id, sha) => reopened.acknowledge(id, sha),
        },
      });
      const restartedAddress = await restartedApi.start();
      cleanup.push(() => restartedApi.stop());
      const restartedEndpoint = `http://${restartedAddress.host}:${restartedAddress.port}/v2/model-operations/${created.id}`;
      const recovered = await fetch(`${restartedEndpoint}/result`, { headers });
      expect(Buffer.from(await recovered.arrayBuffer()).equals(bytes)).toBe(true);
      expect(recovered.headers.get("etag")).toBe(`"${digest}"`);
      const ack = await fetch(`${restartedEndpoint}/ack`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sha256: digest }),
      });
      expect(ack.status).toBe(200);
      expect(((await ack.json()) as { response: { state: string } }).response.state).toBe(
        "acknowledged",
      );
      expect(
        (await reopened.create(ref, "effort-custody", undefined, captureEffortEvidence)).response
          .state,
      ).toBe("acknowledged");
      expect(resources.listModelResources()).toEqual([]);
      expect(posts.mock.calls).toEqual([[effortFixture.submitted]]);
    },
  );

  it("binds capture intent while retaining historical false/omitted idempotency", async () => {
    const captures: Array<boolean | undefined> = [];
    const f = await fixture(async (_input, context) => {
      captures.push(context.captureFailureEvidence);
      await context.onDispatch(route);
      return result();
    });
    const legacy = await f.operations.create(f.upload(), "legacy-capture");
    await f.terminal(legacy.id);
    expect(f.store.get(legacy.id)!.params).not.toHaveProperty("captureFailureEvidence");
    expect((await f.operations.create(f.upload(), "legacy-capture", false)).id).toBe(legacy.id);
    await expect(f.operations.create(f.upload(), "legacy-capture", true)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    const modern = await f.operations.create(f.upload(), "modern-capture", true);
    await f.terminal(modern.id);
    expect(f.store.get(modern.id)!.params).toHaveProperty("captureFailureEvidence", true);
    expect((await f.operations.create(f.upload(), "modern-capture", true)).id).toBe(modern.id);
    await expect(f.operations.create(f.upload(), "modern-capture")).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(captures).toEqual([undefined, true]);
  });

  it("carries a large real adapter failure through HTTP, journal restart, ACK and expiry in one result", async () => {
    const wire = Buffer.from(
      `data: {private-wire-marker}\n\n${"received suffix 🦉".repeat(40_000)}`,
    );
    expect(wire.length).toBeGreaterThan(256 * 1024);
    const posts = vi.fn();
    const adapter = createCodexModelAdapter({
      readAuthFile: async () =>
        JSON.stringify({
          tokens: {
            access_token: `fixture.${Buffer.from('{"exp":2100000000}').toString("base64url")}.signature`,
            account_id: "fixture",
          },
        }),
      refresh: async () => {
        throw new Error("no auth refresh in this fixture");
      },
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          posts();
          return new Response(wire, { headers: { "x-request-id": "retained-failure" } });
        }
        return Response.json({ models: [{ slug: "test-model" }] });
      },
    });
    const f = await fixture((input, context) =>
      adapter.invoke(input, {
        ...context,
        profile: {
          ...context.profile,
          isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
        },
      }),
    );
    const api = new DaemonControlApiServer({
      token: "fixture-control",
      daemon: f.client,
      services: {
        createModelOperation: f.operations.create.bind(f.operations),
        getModelOperation: async (id) => f.operations.inspect(id),
        readModelResult: async (id) => f.operations.readResult(id),
        acknowledgeModelResult: async (id, digest) => f.operations.acknowledge(id, digest),
      },
    });
    const address = await api.start();
    cleanup.push(() => api.stop());
    const endpoint = `http://${address.host}:${address.port}/v2/model-operations`;
    const headers = {
      Authorization: "Bearer fixture-control",
      "X-Claudexor-Protocol-Major": "3",
      "Content-Type": "application/json",
      "Idempotency-Key": "large-failure",
    };
    const createdResponse = await fetch(`${endpoint}?captureFailureEvidence=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({ request: f.upload() }),
    });
    expect(createdResponse.status).toBe(202);
    const created = ControlModelOperationDetail.parse(await createdResponse.json());
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "interrupted",
      dispatch: { state: "unknown" },
      response: { state: "ready" },
      problem: { context: { stage: "json", receivedBytes: wire.length } },
    });
    const response = await fetch(`${endpoint}/${created.id}/result`, { headers });
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    const captured = ModelCallResult.parse(JSON.parse(bytes.toString()));
    expect(Buffer.from(captured.failureEvidence!.bodyBase64, "base64").equals(wire)).toBe(true);
    expect(captured.failureEvidence!.errors[0].name).toBe("SyntaxError");
    expect(JSON.stringify(done)).not.toContain("private-wire-marker");
    expect(JSON.stringify(f.records())).not.toContain(captured.failureEvidence!.bodyBase64);
    expect(f.resources.listModelResources()).toHaveLength(1);
    expect((await f.operations.create(f.upload(), "large-failure", true)).id).toBe(created.id);
    expect(f.operations.readResult(created.id).bytes.equals(bytes)).toBe(true);
    await api.stop();
    await f.server.stop();
    f.operations.close();
    await f.sql.close();

    const sql = await sqlFixture(f.root);
    const store = sql.graph.commands.current();
    const resources = sql.graph.resources;
    let now = new Date();
    const reopened = new ModelOperations({
      commands: sql.graph.commands,
      resourceQueries: sql.graph.commands.queries,
      resources: () => resources,
      now: () => now,
      enqueue: async () => {
        throw new Error("replay cannot enqueue");
      },
      cancel: async () => {
        throw new Error("replay cannot cancel");
      },
      resolve: async () => {
        throw new Error("replay cannot resolve a provider");
      },
    });
    cleanup.push(async () => {
      reopened.close();
      await sql.close();
    });
    expect(reopened.readResult(created.id).bytes.equals(bytes)).toBe(true);
    expect(reopened.reconcileResources().released).toEqual([]);
    const ref = ModelOperationParams.parse(store.get(created.id)!.params).request;
    expect((await reopened.create(ref, "large-failure", true)).id).toBe(created.id);
    const digest = reopened.readResult(created.id).sha256;
    expect(reopened.acknowledge(created.id, digest).response.state).toBe("acknowledged");
    expect(resources.listModelResources()).toEqual([]);
    expect((await reopened.create(ref, "large-failure", true)).response.state).toBe("acknowledged");
    expect(posts).toHaveBeenCalledTimes(1);

    // The same evidence-bearing resource follows ordinary unacknowledged expiry.
    const pendingRef = resources.publishModel(bytes);
    const pending = structuredClone(store.get(created.id)!);
    pending.id = "expiry-failure";
    store.accept({
      id: pending.id,
      params: pending.params,
      idempotencyKey: pending.id,
      clientId: "fixture",
    });
    const expiresAt = new Date(now.getTime() + 1000).toISOString();
    store.update(pending.id, {
      state: "interrupted",
      result: {
        ...(pending.result as object),
        response: { state: "ready", ref: pendingRef, readyAt: now.toISOString(), expiresAt },
      },
    });
    expect(reopened.readResult(pending.id).bytes.equals(bytes)).toBe(true);
    now = new Date(expiresAt);
    expect(reopened.inspect(pending.id).response.state).toBe("expired");
    expect(reopened.reconcileResources().errors).toEqual([]);
    expect(resources.listModelResources()).toEqual([]);
  });

  it.each(["completed", "incomplete"] as const)(
    "keeps %s provider finality but fails an unusable message",
    async (outcome) => {
      const f = await fixture(async (_input, context) => {
        await context.onDispatch(route);
        return {
          ...result(),
          outcome,
          message: null,
          problem: {
            code: "response_rejected",
            message: "Message could not be used",
            context: { stage: "message" },
            retryable: false,
            fieldErrors: {},
            requiredActions: [],
            evidenceRefs: [],
          },
        };
      });
      const created = await f.operations.create(f.upload(), `rejected-${outcome}`);
      expect(await f.terminal(created.id)).toMatchObject({
        state: "failed",
        dispatch: { state: "response_received" },
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      expect(JSON.parse(f.operations.readResult(created.id).bytes.toString())).toMatchObject({
        outcome,
        message: null,
        problem: { code: "response_rejected" },
      });
    },
  );

  it("retains a confirmed processing refusal as a physically sent response and never starts Standard itself", async () => {
    const posts = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        posts(JSON.parse(await new Response(init.body).text()).service_tier);
        return Response.json(
          { error: { code: "resource_unavailable", param: "service_tier" } },
          { status: 429, headers: { "x-request-id": "custody-refusal" } },
        );
      }
      return Response.json({ models: [{ slug: "test-model", service_tiers: [{ id: "flex" }] }] });
    });
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2100000000 })).toString("base64url")}.signature`;
    const adapter = createCodexModelAdapter({
      fetch: fetcher,
      now: () => 1900000000000,
      readAuthFile: async () =>
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { account_id: "fixture-account", access_token: token },
        }),
    });
    const f = await fixture((input, context) =>
      adapter.invoke(input, {
        ...context,
        profile: {
          ...context.profile,
          isolation_locator: join(process.env.CLAUDEXOR_CONFIG_DIR!, "profiles", "fixture"),
        },
      }),
    );
    const body = request();
    body.options.processingPreference = "economy";
    const ref = f.upload(body);
    const created = await f.operations.create(ref, "processing-refusal");
    const done = await f.terminal(created.id);
    expect(done).toMatchObject({
      state: "failed",
      dispatch: { state: "response_received", startedAt: expect.any(String) },
      response: { state: "ready" },
      problem: {
        code: "processing_unavailable",
        context: {
          generationStarted: false,
          processingFallback: "standard",
          processingRefusal: "capacity",
          httpStatus: 429,
          vendorCode: "resource_unavailable",
          requestId: "custody-refusal",
        },
      },
    });
    const stored = f.operations.readResult(created.id);
    const reread = f.operations.readResult(created.id);
    expect(stored.bytes.equals(reread.bytes)).toBe(true);
    const result = ModelCallResult.parse(JSON.parse(stored.bytes.toString()));
    expect(result.processing).toMatchObject({
      requested: "economy",
      submitted: "economy",
      submittedNative: "flex",
      observed: "unknown",
    });
    expect(result.cost).toMatchObject({ knowledge: "unknown", cashUsd: null });
    expect((await f.operations.create(ref, "processing-refusal")).id).toBe(created.id);
    f.operations.acknowledge(created.id, stored.sha256);
    expect((await f.operations.create(ref, "processing-refusal")).response.state).toBe(
      "acknowledged",
    );
    expect(posts.mock.calls).toEqual([["flex"]]);
  });
  it("keeps turn state in result custody across rejoin and ACK, outside public receipts", async () => {
    const nativeContinuation = {
      route,
      format: "codex.turn.v1",
      payload: { turnState: "private-turn-token" },
    };
    const invoke = vi.fn<ModelAdapter["invoke"]>(async (input, context) => {
      expect(input.nativeContinuation).toBeNull();
      await context.onDispatch(route);
      return { ...result(), outcome: "unknown", message: null, nativeContinuation };
    });
    const f = await fixture(invoke);
    const ref = f.upload({ ...request(), nativeContinuation: null });
    const created = await f.operations.create(ref, "turn-state-rejoin");
    const done = await f.terminal(created.id);
    expect(JSON.stringify(done)).not.toContain("private-turn-token");
    expect(JSON.stringify(f.records())).not.toContain("private-turn-token");
    const first = f.operations.readResult(created.id);
    expect(JSON.parse(first.bytes.toString()).nativeContinuation).toEqual(nativeContinuation);
    expect((await f.operations.create(ref, "turn-state-rejoin")).id).toBe(created.id);
    expect(f.operations.readResult(created.id).bytes.equals(first.bytes)).toBe(true);
    f.operations.acknowledge(created.id, first.sha256);
    expect((await f.operations.create(ref, "turn-state-rejoin")).response.state).toBe(
      "acknowledged",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([{ stop_reason: "end_turn" }, { refusal: "The prior provider refused." }])(
    "reports invalid uploaded model bytes through HTTP as pre-admission 400: %j",
    async (extra) => {
      const f = await fixture();
      const api = new DaemonControlApiServer({
        token: "fixture-control",
        daemon: f.client,
        services: {
          createModelOperation: f.operations.create.bind(f.operations),
          getModelOperation: async (id) => f.operations.inspect(id),
        },
      });
      const address = await api.start();
      cleanup.push(() => api.stop());
      const ref = f.resources.publishModel(
        Buffer.from(
          JSON.stringify({
            ...request(),
            messages: [{ role: "assistant", content: "private caller content", ...extra }],
          }),
        ),
      );
      const headers = {
        Authorization: "Bearer fixture-control",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        "Idempotency-Key": "invalid-model-body",
      };
      const endpoint = `http://${address.host}:${address.port}/v2/model-operations`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: ref }),
      });
      expect(response.status).toBe(400);
      const problem = await response.json();
      expect(problem).toMatchObject({ code: "model_request_invalid", retryable: false });
      expect(JSON.stringify(problem)).not.toContain("private caller content");
      expect(f.records()).toEqual([]);
      expect(f.sends).not.toHaveBeenCalled();
      const absent = await fetch(`${endpoint}/not-created`, { headers });
      expect(absent.status).toBe(404);
      expect(await absent.json()).toMatchObject({ code: "model_operation_not_found" });
      // The invalid body never claimed the key. A corrected request can use it,
      // and an accepted replay must not validate a since-released upload copy.
      const accepted = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: f.upload() }),
      });
      expect(accepted.status).toBe(202);
      const created = ControlModelOperationDetail.parse(await accepted.json());
      await f.terminal(created.id);
      f.operations.acknowledge(created.id, f.operations.readResult(created.id).sha256);
      const replacement = f.upload();
      f.resources.releaseModel(replacement);
      const replay = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ request: replacement }),
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toMatchObject({
        id: created.id,
        response: { state: "acknowledged" },
      });
      expect(f.records()).toHaveLength(1);
      expect(f.sends).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps >10 MiB bodies out of the journal and preserves a result until explicit ACK", async () => {
    const f = await fixture();
    const ref = f.upload(request("private-model-marker" + "x".repeat(11 * 1024 * 1024)));
    const created = await f.operations.create(ref, "large");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("succeeded");
    expect(done.dispatch.state).toBe("response_received");
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.records())).not.toContain("private-model-marker");
    expect(JSON.stringify(f.records()).length).toBeLessThan(5000);
    expect(() => f.resources.readModel(ref)).toThrowError(
      expect.objectContaining({ code: "resource_not_found" }),
    );
    const first = f.operations.readResult(created.id);
    const second = f.operations.readResult(created.id);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(JSON.parse(first.bytes.toString()).message.content).toBe("exact result 🦉");
    expect(f.operations.inspect(created.id).response.state).toBe("ready");
    expect(f.operations.acknowledge(created.id, first.sha256).response.state).toBe("acknowledged");
    expect(f.operations.acknowledge(created.id, first.sha256).response.state).toBe("acknowledged");
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ status: 410 }),
    );
    expect(f.resources.listModelResources()).toEqual([]);
    expect((await f.operations.create(ref, "large")).id).toBe(created.id);
    expect(f.sends).toHaveBeenCalledTimes(1);
  });

  it("concurrent create and re-uploaded identical bytes retain one accepted invocation", async () => {
    const f = await fixture();
    const first = f.upload();
    const second = f.upload();
    const [a, b] = await Promise.all([
      f.operations.create(first, "same"),
      f.operations.create(second, "same"),
    ]);
    expect(a.id).toBe(b.id);
    await f.terminal(a.id);
    expect(f.sends).toHaveBeenCalledTimes(1);
    expect(f.records()).toHaveLength(1);
    expect(() => f.resources.readModel(first)).toThrow();
    expect(() => f.resources.readModel(second)).toThrow();
    const replayRef = f.upload();
    expect((await f.operations.create(replayRef, "same")).id).toBe(a.id);
    expect(() => f.resources.readModel(replayRef)).toThrow();
    await expect(f.operations.create(f.upload(request("different")), "same")).rejects.toMatchObject(
      { code: "idempotency_conflict" },
    );
  });

  it("does not report model jobs as Agent Runs while normal capacity sees them", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, ctx) => {
      await ctx.onDispatch(route);
      await gate;
      return result();
    });
    const first = await f.operations.create(f.upload(), "first");
    const secondRef = f.upload(request("second"));
    const second = await f.operations.create(secondRef, "second");
    expect(await f.client.list({ page: { limit: 200, state: null, cursor: null } })).toEqual([]);
    expect(f.operations.inspect(first.id).state).toBe("running");
    expect(f.operations.inspect(second.id).state).toBe("queued");
    const cancelled = await f.operations.cancel(second.id, "user_cancelled");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.dispatch.state).toBe("not_started");
    expect(() => f.resources.readModel(secondRef)).toThrow();
    release();
    await f.terminal(first.id);
    expect((await f.operations.cancel(first.id)).state).toBe("succeeded");
  });

  it("keeps model idempotency after history cap/age and result acknowledgement", async () => {
    const f = await fixture(undefined, { maxHistory: 1, idempotencyRetentionMs: 0 });
    const first = await f.operations.create(f.upload(), "retained-first");
    await f.terminal(first.id);
    f.operations.acknowledge(first.id, f.operations.readResult(first.id).sha256);
    const second = await f.operations.create(f.upload(request("other")), "retained-second");
    await f.terminal(second.id);
    expect(f.records()).toHaveLength(2);
    expect((await f.operations.create(f.upload(), "retained-first")).id).toBe(first.id);
    expect(f.operations.inspect(first.id).response.state).toBe("acknowledged");
    expect(f.sends).toHaveBeenCalledTimes(2);
  });

  it("does not report a provider response when the durable dispatch write fails", async () => {
    const sends = vi.fn();
    const f = await fixture(async (_request, ctx) => {
      try {
        await ctx.onDispatch(route);
        sends();
        return result();
      } catch {
        return { ...result(), outcome: "failed", message: null };
      }
    });
    f.sql.store.transaction(() =>
      f.sql.store.exec(`CREATE TRIGGER dispatch_write_fault BEFORE UPDATE ON command
      WHEN (SELECT json_extract(CAST(inline AS TEXT),'$.dispatch.state') FROM blob WHERE sha256=NEW.result_sha)='started'
      BEGIN SELECT RAISE(ABORT,'fixture SQL write failed'); END`),
    );
    const created = await f.operations.create(f.upload(), "dispatch-write-failed");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("failed");
    expect(done.dispatch.state).toBe("not_started");
    expect(sends).not.toHaveBeenCalled();
  });

  it("marks an interrupted physical send unknown rather than never-sent or free", async () => {
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      throw new Error("upstream disappeared");
    });
    const created = await f.operations.create(f.upload(), "torn");
    const done = await f.terminal(created.id);
    expect(done.state).toBe("interrupted");
    expect(done.dispatch.state).toBe("unknown");
    expect(done.cost).toBeNull();
    expect(done.usage.input_tokens).toBeNull();
    expect(
      (
        await f.operations.create(
          ModelOperationParams.parse(f.store.get(created.id)!.params).request,
          "torn",
        )
      ).id,
    ).toBe(created.id);
  });

  it("refuses malformed UTF-8 and ordinary attachment refs before admission", async () => {
    const f = await fixture();
    const bytes = Buffer.concat([
      Buffer.from('{"source":"'),
      Buffer.from([255]),
      Buffer.from('"}'),
    ]);
    await expect(
      f.operations.create(f.resources.publishModel(bytes), "utf8"),
    ).rejects.toMatchObject({
      code: "model_request_invalid",
      status: 400,
      retryable: false,
    });
    const upload = f.resources.create(
      { kind: "file", mime: "application/json", sizeBytes: 2 },
      "ordinary",
    );
    await f.resources.write(
      upload.uploadId,
      (async function* () {
        yield Buffer.from("{}");
      })(),
    );
    const ordinary = f.resources.finalize(upload.uploadId, undefined, "ordinary-final");
    await expect(
      f.operations.create(
        { resourceId: ordinary.resourceId, sha256: ordinary.sha256, sizeBytes: ordinary.sizeBytes },
        "ordinary-op",
      ),
    ).rejects.toMatchObject({ code: "resource_purpose_mismatch" });
    expect(f.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it.each([
    "{broken",
    JSON.stringify({
      ...request(),
      messages: [{ role: "assistant", content: "private", stop_reason: "end_turn" }],
    }),
  ])("rejects invalid request bytes before command acceptance", async (body) => {
    const f = await fixture();
    const ref = f.resources.publishModel(Buffer.from(body));
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(f.operations.create(ref, "invalid-request")).rejects.toMatchObject({
        code: "model_request_invalid",
        status: 400,
        retryable: false,
      });
    }
    expect(f.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it("preserves resource I/O failure instead of granting invalid-request authority", async () => {
    const f = await fixture();
    const ref = f.upload();
    const failure = Object.assign(new Error("resource unavailable"), { code: "EIO" });
    vi.spyOn(f.resources, "readModel").mockImplementation(() => {
      throw failure;
    });
    await expect(f.operations.create(ref, "io-error")).rejects.toBe(failure);
    expect(f.records()).toEqual([]);
    expect(f.sends).not.toHaveBeenCalled();
  });

  it("replays accepted authority before validating an already released replacement upload", async () => {
    const f = await fixture();
    const created = await f.operations.create(f.upload(), "accepted-before-validation");
    await f.terminal(created.id);
    f.operations.acknowledge(created.id, f.operations.readResult(created.id).sha256);
    const replacement = f.upload();
    f.resources.releaseModel(replacement);
    const read = vi.spyOn(f.resources, "readModel");
    const replay = await f.operations.create(replacement, "accepted-before-validation");
    expect(replay.id).toBe(created.id);
    expect(replay.response.state).toBe("acknowledged");
    expect(read).not.toHaveBeenCalled();
    expect(f.records()).toHaveLength(1);
    expect(f.sends).toHaveBeenCalledTimes(1);
  });

  it("a malformed raw model command cannot poison another operation's cleanup", async () => {
    const f = await fixture();
    f.store.accept({
      id: "malformed",
      params: { kind: "model" },
      idempotencyKey: "malformed",
      clientId: "fixture",
    });
    const created = await f.operations.create(f.upload(), "valid-after-malformed");
    await f.terminal(created.id);
    f.store.update("malformed", { state: "failed" });
    expect(f.operations.reconcileResources().errors).toEqual([]);
  });

  it("a wrong ACK cannot release content; expiry is 30 days from ready, with dry-run cleanup", async () => {
    const f = await fixture();
    const created = await f.operations.create(f.upload(), "expiry");
    const done = await f.terminal(created.id);
    if (done.response.state !== "ready") throw new Error("expected ready result");
    const ready = done.response;
    expect(Date.parse(ready.expiresAt) - Date.parse(ready.readyAt)).toBe(30 * 24 * 60 * 60 * 1000);
    expect(() => f.operations.acknowledge(created.id, `sha256:${"0".repeat(64)}`)).toThrowError(
      expect.objectContaining({ code: "model_result_digest_mismatch" }),
    );
    f.setNow(new Date(Date.parse(ready.expiresAt) - 1));
    expect(f.operations.readResult(created.id).sha256).toBe(ready.ref.sha256);
    f.setNow(new Date(ready.expiresAt));
    expect(f.operations.inspect(created.id).response.state).toBe("expired");
    expect(() => f.operations.readResult(created.id)).toThrowError(
      expect.objectContaining({ status: 410 }),
    );
    expect(f.operations.reconcileResources(true).released).toContain(ready.ref.resourceId);
    expect(f.resources.readModel(ready.ref).length).toBeGreaterThan(0);
    expect(f.operations.reconcileResources().errors).toEqual([]);
    expect(() => f.resources.readModel(ready.ref)).toThrow();
    expect(f.operations.inspect(created.id).response.state).toBe("expired");
  });

  it("retains an input shared with another live command until both settle", async () => {
    let release!: () => void;
    let count = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      if (++count === 1) await gate;
      return result();
    });
    const ref = f.upload();
    const first = await f.operations.create(ref, "shared-first");
    const second = await f.operations.create(ref, "shared-second");
    release();
    await f.terminal(first.id);
    await f.terminal(second.id);
    expect(count).toBe(2);
    expect(() => f.resources.readModel(ref)).toThrow();
  });

  it("a redundant replay preserves a different command's live input resource", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(async (_input, context) => {
      await context.onDispatch(route);
      await gate;
      return result();
    });
    const first = await f.operations.create(f.upload(), "shared-copy-first");
    const secondRef = f.upload();
    const second = await f.operations.create(secondRef, "shared-copy-second");
    expect((await f.operations.create(secondRef, "shared-copy-first")).id).toBe(first.id);
    expect(f.resources.readModel(secondRef).length).toBeGreaterThan(0);
    release();
    await f.terminal(first.id);
    await f.terminal(second.id);
    expect(() => f.resources.readModel(secondRef)).toThrow();
  });
});
