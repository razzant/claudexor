import { sqlFixture } from "../../daemon/src/store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlProblem, type ControlRunStartRequest } from "@claudexor/schema";
import { DaemonTransportError } from "../../daemon/src/client-errors.js";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";
import { normalizeRunStartRequest } from "./run-start.js";

const roots: string[] = [];
const stores: Array<Awaited<ReturnType<typeof sqlFixture>>> = [];
const servers: DaemonControlApiServer[] = [];
const token = "run-start-test-token";
const sameKeyAction = "Retry the same operation with the same Idempotency-Key.";
type Route = "create" | "retry";

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const sql of stores.splice(0)) await sql.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real HTTP and SQL command authority, with no daemon process or harness execution. */
async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "claudexor-start-http-")));
  roots.push(root);
  const sql = await sqlFixture(root);
  stores.push(sql);
  const store = sql.graph.commands.current();
  const queries = sql.graph.commands.queries;
  const request = normalizeRunStartRequest({
    mode: "agent",
    prompt: "inspect the project",
    access: "readonly",
    scope: { kind: "project", root },
  });
  function accept(
    params: unknown,
    key: string,
    operation = "run.create",
    idempotencyParams = params,
  ) {
    const accepted = store.accept({
      id: `job-${queries.count() + 1}`,
      params,
      idempotencyKey: key,
      clientId: "control-api",
      operation,
      idempotencyParams,
    });
    if (!accepted.reused) {
      store.update(accepted.record.id, {
        state: "running",
        runId: `run-${accepted.record.id}`,
        taskId: `task-${accepted.record.id}`,
        runDir: root,
      });
    }
    return store.get(accepted.record.id)!;
  }
  const source = accept(request, "source-a");
  store.update(source.id, { state: "succeeded" });
  const otherSource = accept({ ...request, prompt: "inspect the other module" }, "source-b");
  store.update(otherSource.id, { state: "succeeded" });

  const findAccepted = vi.fn<NonNullable<DaemonFacadeClient["findAccepted"]>>(
    async (params, options) =>
      store.find({
        params,
        idempotencyKey: options.idempotencyKey,
        clientId: options.clientId ?? "daemon-client",
        operation: options.operation,
        idempotencyParams: options.idempotencyRequest,
      }),
  );
  const enqueue = vi.fn<DaemonFacadeClient["enqueue"]>(async (params, options) => {
    const record = accept(
      params,
      options!.idempotencyKey!,
      options?.operation,
      options?.idempotencyRequest,
    );
    return { id: record.id, state: record.state };
  });
  const preflight = vi.fn(async (_request: ControlRunStartRequest) => undefined);
  const server = new DaemonControlApiServer({
    token,
    services: { preflightRunRequirements: preflight },
    daemon: {
      findAccepted,
      enqueue,
      async status(id) {
        const record = store.get(id);
        if (!record) throw new Error(`missing job ${id}`);
        return record;
      },
      async list(query) {
        if (!("id" in query)) throw new Error("expected an addressed source lookup");
        return queries.select(query);
      },
      async cancel() {
        throw new Error("lookup cannot cancel an accepted command");
      },
    },
  });
  servers.push(server);
  const { host, port } = await server.start();
  function post(route: Route, key = "request-key", original = request, retryId = source.runId!) {
    return fetch(`http://${host}:${port}/v2/runs${route === "retry" ? `/${retryId}/retry` : ""}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "X-Claudexor-Protocol-Major": "3",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(route === "create" ? original : {}),
    });
  }
  return {
    store,
    queries,
    request,
    source,
    otherSource,
    findAccepted,
    enqueue,
    preflight,
    accept,
    post,
  };
}

describe.each(["create", "retry"] as const)("%s idempotency HTTP composition", (route) => {
  it("returns a real CommandStore conflict without losing the earlier accepted body", async () => {
    const f = await fixture();
    const first = await f.post(route);
    expect(first.status).toBe(200);
    const accepted = (await first.json()) as { jobId: string };
    const original = structuredClone(f.store.get(accepted.jobId));
    const conflictingRequest = { ...f.request, prompt: "a different body" };
    const conflictingIdentity =
      route === "create" ? conflictingRequest : { retryOf: f.otherSource.runId };
    // The canonical producer has code/status and no retryable field.
    let producerError: unknown;
    try {
      f.store.find({
        params: conflictingRequest,
        idempotencyKey: "request-key",
        clientId: "control-api",
        operation: route === "create" ? "run.create" : "run.retry",
        idempotencyParams: conflictingIdentity,
      });
    } catch (error) {
      producerError = error;
    }
    expect(producerError).toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(producerError).not.toHaveProperty("retryable");

    const conflict = await f.post(route, "request-key", conflictingRequest, f.otherSource.runId!);
    expect(conflict.status).toBe(409);
    expect(ControlProblem.parse(await conflict.json())).toMatchObject({
      code: "idempotency_conflict",
      retryable: false,
    });
    expect(f.store.get(accepted.jobId)).toEqual(original);
    const replay = await f.post(route);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ jobId: accepted.jobId });
    expect(f.preflight).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.queries.count()).toBe(3);
  });

  it("exposes actual CommandStore key validation as a definite 400", async () => {
    const f = await fixture();
    f.findAccepted.mockImplementation(async () =>
      f.store.find({ params: f.request, idempotencyKey: "", clientId: "control-api" }),
    );
    const response = await f.post(route);
    expect(response.status).toBe(400);
    expect(ControlProblem.parse(await response.json())).toMatchObject({
      code: "invalid_idempotency_key",
      retryable: false,
    });
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.queries.count()).toBe(2);
  });

  it.each([
    [
      "transport timeout",
      (): Error => new DaemonTransportError("claudexor.findAccepted", "timeout"),
      "daemon_busy",
      503,
    ],
    [
      "transport unavailable",
      (): Error => new DaemonTransportError("claudexor.findAccepted", "unavailable"),
      "daemon_unavailable",
      503,
    ],
    ["untyped exception", (): Error => new Error("index unreadable"), undefined, undefined],
    ["untyped value", (): string => "index unreadable", undefined, undefined],
    [
      "read-side forbidden",
      (): Error =>
        Object.assign(new Error("index forbidden"), {
          code: "index_forbidden",
          status: 403,
          retryable: false,
        }),
      "index_forbidden",
      403,
    ],
    [
      "read-side rate limit",
      (): Error =>
        Object.assign(new Error("index rate limited"), {
          code: "index_rate_limited",
          status: 429,
          retryable: false,
        }),
      "index_rate_limited",
      429,
    ],
  ] as const)(
    "keeps %s unknown with its cause and the same-key action",
    async (_name, error, code, status) => {
      const f = await fixture();
      f.findAccepted.mockRejectedValue(error());
      const response = await f.post(route);
      expect(response.status).toBe(503);
      const problem = ControlProblem.parse(await response.json());
      expect(problem).toMatchObject({
        code: "idempotency_status_unavailable",
        retryable: true,
        requiredActions: [sameKeyAction],
        context: {
          stage: "lookup_before_preflight",
          cause: {
            message: expect.any(String),
            requiredActions: [],
            context: {},
            ...(code ? { code, status } : {}),
          },
        },
      });
      if (!code) {
        expect(problem.context.cause).not.toHaveProperty("code");
        expect(problem.context.cause).not.toHaveProperty("retryable");
      }
      expect(problem.context).not.toHaveProperty("preflight");
      expect(f.findAccepted).toHaveBeenCalledTimes(1);
      expect(f.preflight).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(f.queries.count()).toBe(2);
    },
  );

  it("keeps failed lookup two distinct from preflight and redacts both through the wire", async () => {
    const f = await fixture();
    const secret = `sk-${"a".repeat(48)}`;
    const refusal = Object.assign(new Error(`access unavailable ${secret}`), {
      code: "preflight_unavailable",
      status: 403,
      retryable: false,
      requiredActions: [`Restore access ${secret}.`],
      context: { phase: "requirements", detail: secret },
    });
    const lookupError = Object.assign(
      new DaemonTransportError("claudexor.findAccepted", "timeout"),
      {
        context: { transport: "rpc", detail: secret },
        requiredActions: [`Inspect the daemon ${secret}.`],
      },
    );
    f.findAccepted.mockResolvedValueOnce(null).mockRejectedValueOnce(lookupError);
    f.preflight.mockRejectedValue(refusal);
    const response = await f.post(route);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toContain("stack");
    const problem = ControlProblem.parse(JSON.parse(text));
    expect(problem).toMatchObject({
      code: "idempotency_status_unavailable",
      retryable: true,
      requiredActions: [sameKeyAction],
      context: {
        stage: "lookup_after_preflight",
        cause: {
          code: "daemon_busy",
          status: 503,
          retryable: true,
          message: "daemon RPC timeout (claudexor.findAccepted)",
          requiredActions: [expect.stringContaining("Inspect the daemon")],
          context: { transport: "rpc" },
        },
        preflight: {
          code: "preflight_unavailable",
          status: 403,
          retryable: false,
          message: expect.stringContaining("access unavailable"),
          requiredActions: [expect.stringContaining("Restore access")],
          context: { phase: "requirements" },
        },
      },
    });
    expect(f.findAccepted).toHaveBeenCalledTimes(2);
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.queries.count()).toBe(2);
  });

  it("returns the preflight refusal only after two confirmed misses", async () => {
    const f = await fixture();
    f.preflight.mockRejectedValue(
      Object.assign(new Error("access unavailable"), {
        code: "preflight_unavailable",
        status: 403,
        retryable: false,
      }),
    );
    const response = await f.post(route);
    expect(response.status).toBe(403);
    expect(ControlProblem.parse(await response.json())).toMatchObject({
      code: "preflight_unavailable",
      retryable: false,
      context: {},
    });
    expect(f.findAccepted).toHaveBeenCalledTimes(2);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it("recovers a command accepted during failing preflight without enqueuing again", async () => {
    const f = await fixture();
    f.preflight.mockImplementation(async (params) => {
      f.accept(
        params,
        "request-key",
        route === "create" ? "run.create" : "run.retry",
        route === "create" ? params : { retryOf: f.source.runId },
      );
      throw new Error("mutable requirements disappeared");
    });
    const response = await f.post(route);
    expect(response.status).toBe(200);
    const accepted = (await response.json()) as { jobId: string };
    expect(f.store.get(accepted.jobId)?.state).toBe("running");
    expect(f.findAccepted).toHaveBeenCalledTimes(2);
    expect(f.enqueue).not.toHaveBeenCalled();
    const replay = await f.post(route);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ jobId: accepted.jobId });
    expect(f.preflight).toHaveBeenCalledTimes(1);
    expect(f.queries.count()).toBe(3);
  });
});
