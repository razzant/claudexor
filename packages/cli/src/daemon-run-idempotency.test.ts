import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DaemonControlApiServer,
  type DaemonFacadeClient,
} from "../../control-api/src/daemon-server.js";
import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { enqueueAndAwait } from "./daemon-run.js";

const addr = { baseUrl: "http://127.0.0.1:1", token: "fixture" };
const request = { mode: "ask", prompt: "inspect", scope: { kind: "none" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("enqueueAndAwait caller idempotency", () => {
  it("uses the caller key only for launch, keeping registration and the body separate", async () => {
    const posts: Array<{ url: string; key: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({
          url,
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: JSON.parse(String(init.body)),
        });
        return Response.json({ jobId: "job", runId: "run", runDir: "/fixture" });
      }),
    );
    const body = { ...request, scope: { kind: "project", root: "/fixture" } };
    const client = { status: vi.fn().mockResolvedValue({ state: "running" }) };
    await enqueueAndAwait(client as never, addr, body, {
      waitForTerminal: false,
      idempotencyKey: "caller-key",
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      url: `${addr.baseUrl}/v2/projects`,
      body: { root: "/fixture" },
    });
    expect(posts[0]!.key).toMatch(/^auto-register-/);
    expect(posts[1]).toEqual({ url: `${addr.baseUrl}/v2/runs`, key: "caller-key", body });
    expect(posts[1]!.body).not.toHaveProperty("idempotencyKey");
  });

  it("preserves internal Delegate admission when the caller supplies no key", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = {
      enqueue: vi.fn().mockResolvedValue({ id: "child" }),
      status: vi
        .fn()
        .mockResolvedValue({ state: "running", runId: "run-child", runDir: "/fixture" }),
    };
    const body = { ...request, parentRunId: "parent", delegatedFromRunId: "parent" };
    await expect(
      enqueueAndAwait(client as never, addr, body, {
        waitForTerminal: false,
        internalDaemonEnqueue: true,
      }),
    ).resolves.toMatchObject({ jobId: "child", runId: "run-child" });
    expect(client.enqueue).toHaveBeenCalledExactlyOnceWith(body, {
      clientId: "delegation-belt",
      operation: "delegated-run",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves generated keys when no caller key is provided", async () => {
    const keys: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        keys.push(new Headers(init.headers).get("Idempotency-Key")!);
        return Response.json({ jobId: "job", runId: "run", runDir: "/fixture" });
      }),
    );
    const client = { status: vi.fn().mockResolvedValue({ state: "running" }) };
    for (let i = 0; i < 2; i++)
      await enqueueAndAwait(client as never, addr, request, { waitForTerminal: false });
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.length > 0)).toBe(true);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("does not retry or fall back to RPC after an ambiguous HTTP launch", async () => {
    const failure = new TypeError("response lost after acceptance");
    const fetch = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetch);
    const client = { enqueue: vi.fn(), status: vi.fn() };
    await expect(
      enqueueAndAwait(client as never, addr, request, {
        waitForTerminal: false,
        idempotencyKey: "caller-key",
      }),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("Idempotency-Key")).toBe("caller-key");
    expect(client.enqueue).not.toHaveBeenCalled();
    expect(client.status).not.toHaveBeenCalled();
  });

  it("refuses a caller key on internal Delegate enqueue before registration or admission", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = { enqueue: vi.fn() };
    await expect(
      enqueueAndAwait(
        client as never,
        addr,
        {
          ...request,
          scope: { kind: "project", root: "/bound" },
          parentRunId: "parent",
          delegatedFromRunId: "parent",
        },
        { waitForTerminal: false, internalDaemonEnqueue: true, idempotencyKey: "caller-key" },
      ),
    ).rejects.toMatchObject({ code: "delegation_idempotency_unsupported", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(client.enqueue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "recovers a lost response for the SQL-accepted command (queued=%s) and preserves conflicts over real HTTP",
    async (queued) => {
      const root = mkdtempSync(join(tmpdir(), "claudexor-launch-key-"));
      const sql = await sqlFixture(root);
      const commands = sql.graph.commands.current();
      const queries = sql.graph.commands.queries;
      const preflight = vi.fn(async () => undefined);
      const findAccepted = vi.fn<NonNullable<DaemonFacadeClient["findAccepted"]>>(
        async (params, opts) =>
          commands.find({
            params,
            idempotencyKey: opts.idempotencyKey,
            clientId: opts.clientId!,
            operation: opts.operation,
            idempotencyParams: opts.idempotencyRequest,
          }),
      );
      const enqueue = vi.fn<DaemonFacadeClient["enqueue"]>(async (params, opts) => {
        const accepted = commands.accept({
          id: `job-${queries.count() + 1}`,
          params,
          idempotencyKey: opts!.idempotencyKey!,
          clientId: opts!.clientId!,
          operation: opts!.operation,
          idempotencyParams: opts!.idempotencyRequest,
        });
        if (!queued)
          commands.update(accepted.record.id, {
            state: "running",
            runId: "run-original",
            runDir: root,
          });
        return { id: accepted.record.id, state: queued ? "queued" : "running" };
      });
      const client = {
        // Only the caller's socket poll materializes a queued command. The HTTP
        // route first returns the genuine 202 job-only acceptance.
        status: vi.fn(async (id: string) => {
          if (!commands.get(id)!.runId)
            commands.update(id, {
              state: "running",
              runId: "run-original",
              runDir: root,
            });
          return commands.get(id)!;
        }),
      };
      const server = new DaemonControlApiServer({
        token: "fixture",
        runStartTimeoutMs: 1,
        pollMs: 1,
        services: {
          preflightRunRequirements: preflight,
        },
        daemon: {
          enqueue,
          findAccepted,
          async status(id) {
            return commands.get(id)!;
          },
          async list() {
            return [];
          },
          async cancel() {
            return { ok: false };
          },
        },
      });
      try {
        const { host, port } = await server.start();
        const address = { baseUrl: `http://${host}:${port}`, token: "fixture" };
        const opts = { waitForTerminal: false, idempotencyKey: "caller-key", startTimeoutMs: 1000 };
        const nativeFetch = globalThis.fetch;
        const failure = new TypeError("accepted response lost");
        let loseResponse = true;
        const fetch = vi.fn<typeof nativeFetch>(async (...args) => {
          const response = await nativeFetch(...args);
          if (loseResponse) {
            loseResponse = false;
            await response.arrayBuffer();
            throw failure;
          }
          return response;
        });
        vi.stubGlobal("fetch", fetch);
        await expect(enqueueAndAwait(client as never, address, request, opts)).rejects.toBe(
          failure,
        );
        expect(fetch).toHaveBeenCalledOnce();
        expect(client.status).not.toHaveBeenCalled();
        expect(queries.count()).toBe(1);
        const first = await enqueueAndAwait(client as never, address, request, opts);
        const original = structuredClone(commands.get(first.jobId));
        const replay = await enqueueAndAwait(client as never, address, request, opts);
        expect(replay).toEqual(first);
        expect(first).toMatchObject({ jobId: "job-1", runId: "run-original" });
        await expect(
          enqueueAndAwait(
            client as never,
            address,
            {
              ...request,
              prompt: "changed body",
            },
            opts,
          ),
        ).rejects.toMatchObject({ code: "idempotency_conflict", retryable: false });
        expect(commands.get(first.jobId)).toEqual(original);
        expect(queries.count()).toBe(1);
        expect(enqueue).toHaveBeenCalledOnce();
        expect(preflight).toHaveBeenCalledOnce();
        expect(enqueue.mock.calls[0]![0]).not.toHaveProperty("idempotencyKey");
      } finally {
        await server.stop();
        await sql.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("returns accepted unbound jobs as handles only for durable-handle callers", async () => {
    const body = { ...request };
    const client = { status: vi.fn() };
    const respond = (status: number, value: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(value, { status })),
      );
    respond(202, { jobId: "job-q", state: "queued" });
    await expect(
      enqueueAndAwait(client as never, addr, body, { waitForTerminal: false, acceptUnbound: true }),
    ).resolves.toEqual({ jobId: "job-q", runId: "", runDir: "", status: "queued" });
    expect(client.status).not.toHaveBeenCalled();
    // A typed failure of the accepted job before any run started keeps its identity.
    const failed = {
      code: "credential_profile_unknown",
      message: "profile p1 is unknown",
      retryable: false,
      requiredActions: ["Pick a registered profile."],
      context: { jobId: "job-f", state: "failed" },
    };
    respond(400, failed);
    await expect(
      enqueueAndAwait(client as never, addr, body, { waitForTerminal: false, acceptUnbound: true }),
    ).resolves.toMatchObject({
      jobId: "job-f",
      runId: "",
      status: "failed",
      error: "profile p1 is unknown",
      errorCode: "credential_profile_unknown",
      errorStatus: 400,
      errorRequiredActions: ["Pick a registered profile."],
    });
    // Refusals that never accepted a job stay refusals, even in handle mode.
    for (const refusal of [
      { code: "idempotency_conflict", message: "changed body", retryable: false },
      { code: "project_root_missing", message: "gone", retryable: false, context: {} },
      { code: "invalid_request", message: "x", retryable: false, context: { jobId: "job-x" } },
    ]) {
      respond(409, refusal);
      await expect(
        enqueueAndAwait(client as never, addr, body, {
          waitForTerminal: false,
          acceptUnbound: true,
        }),
      ).rejects.toMatchObject({ code: refusal.code });
    }
    // Without handle mode the same pre-run failure remains the established typed error.
    respond(400, failed);
    await expect(
      enqueueAndAwait(client as never, addr, body, { waitForTerminal: false }),
    ).rejects.toMatchObject({ code: "credential_profile_unknown" });
  });

  it("keeps a bound handle when its state read fails in handle mode only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ jobId: "job", runId: "run", runDir: "/fixture" })),
    );
    const client = { status: vi.fn().mockRejectedValue(new Error("socket lost")) };
    await expect(
      enqueueAndAwait(client as never, addr, request, {
        waitForTerminal: false,
        acceptUnbound: true,
      }),
    ).resolves.toEqual({
      jobId: "job",
      runId: "run",
      runDir: "/fixture",
      status: "",
      error: undefined,
      errorCode: undefined,
      errorStatus: undefined,
      errorRetryable: undefined,
      errorRequiredActions: undefined,
      errorContext: undefined,
    });
    await expect(
      enqueueAndAwait(client as never, addr, request, { waitForTerminal: false }),
    ).rejects.toThrow("socket lost");
  });

  it("replays a durably accepted job that never binds as the same handle over real HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-launch-queued-"));
    const sql = await sqlFixture(root);
    const commands = sql.graph.commands.current();
    const queries = sql.graph.commands.queries;
    const enqueue = vi.fn<DaemonFacadeClient["enqueue"]>(async (params, opts) => {
      const accepted = commands.accept({
        id: `job-${queries.count() + 1}`,
        params,
        idempotencyKey: opts!.idempotencyKey!,
        clientId: opts!.clientId!,
        operation: opts!.operation,
        idempotencyParams: opts!.idempotencyRequest,
      });
      return { id: accepted.record.id, state: "queued" };
    });
    const server = new DaemonControlApiServer({
      token: "fixture",
      runStartTimeoutMs: 1,
      pollMs: 1,
      daemon: {
        enqueue,
        findAccepted: async (params, opts) =>
          commands.find({
            params,
            idempotencyKey: opts.idempotencyKey,
            clientId: opts.clientId!,
            operation: opts.operation,
            idempotencyParams: opts.idempotencyRequest,
          }),
        async status(id) {
          return commands.get(id)!;
        },
        async list() {
          return [];
        },
        async cancel() {
          return { ok: false };
        },
      },
    });
    try {
      const { host, port } = await server.start();
      const address = { baseUrl: `http://${host}:${port}`, token: "fixture" };
      const client = { status: vi.fn() };
      const opts = { waitForTerminal: false, acceptUnbound: true, idempotencyKey: "queued-key" };
      const first = await enqueueAndAwait(client as never, address, request, opts);
      const replay = await enqueueAndAwait(client as never, address, request, opts);
      expect(first).toEqual({ jobId: "job-1", runId: "", runDir: "", status: "queued" });
      expect(replay).toEqual(first);
      await expect(
        enqueueAndAwait(client as never, address, { ...request, prompt: "changed" }, opts),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(queries.count()).toBe(1);
      expect(enqueue).toHaveBeenCalledOnce();
      expect(client.status).not.toHaveBeenCalled();
    } finally {
      await server.stop();
      await sql.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
