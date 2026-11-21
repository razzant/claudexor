import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

// Paired-custody routes: the store-identity opt-in on registration, the bound
// address probe and the bound release. The services are mocks; the wire
// shapes, binding validation and typed refusals are the real route code.

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

const project = {
  schema_version: 2,
  id: "prj-1",
  root: "/repo/a",
  created_at: "2030-01-01T00:00:00.000Z",
  updated_at: "2030-01-01T00:00:00.000Z",
  nesting: [],
};

async function serve(services: Record<string, unknown>) {
  const server = new DaemonControlApiServer({
    token: "fixture",
    daemon: {} as unknown as DaemonFacadeClient,
    storeId: () => "store-1",
    services,
  });
  servers.push(server);
  const { host, port } = await server.start();
  const auth = {
    Authorization: "Bearer fixture",
    "X-Claudexor-Protocol-Major": "3",
  };
  return {
    register: (headers: Record<string, string>) =>
      fetch(`http://${host}:${port}/v2/projects`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", ...headers },
        body: JSON.stringify({ root: "/repo/a" }),
      }),
    probe: (query: string) =>
      fetch(`http://${host}:${port}/v2/projects/prj-1/registration?${query}`, { headers: auth }),
    release: (body: unknown, query = "") =>
      fetch(`http://${host}:${port}/v2/projects/prj-1/release${query}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

describe("paired project registration routes", () => {
  it("advertises the probe and release with their exact binding surfaces", () => {
    const probe = OPERATION_CATALOG.operations.find(
      (o) => o.method === "GET" && o.path === "/v2/projects/:id/registration",
    );
    expect(probe).toMatchObject({
      mutability: "read_only",
      requestSchema: null,
      responseSchema: "ControlProjectRegistrationState",
      parameters: [
        expect.objectContaining({ name: "expectedStoreId", required: true }),
        expect.objectContaining({ name: "expectedRoot", required: true }),
        expect.objectContaining({ name: "candidate", required: false }),
      ],
    });
    expect(
      OPERATION_CATALOG.operations.find(
        (o) => o.method === "POST" && o.path === "/v2/projects/:id/release",
      ),
    ).toMatchObject({
      mutability: "mutating",
      requestSchema: "ControlProjectBinding",
      responseSchema: "ControlProjectReleaseReceipt",
      idempotency: "natural",
    });
  });

  it("carries the store-identity opt-in to the service and the response", async () => {
    const register = vi.fn(async (_input: {
      root: string;
      idempotencyKey: string;
      clientId: string;
      includeStoreId?: boolean;
    }) => ({ ...project, created: true, storeId: "store-1" }));
    const call = await serve({ registerProject: register });
    const legacy = await call.register({ "Idempotency-Key": "k1" });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({
      schemaVersion: 2,
      id: "prj-1",
      root: "/repo/a",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      nesting: [],
      created: true,
    });
    const opted = await call.register({
      "Idempotency-Key": "k2",
      "X-Claudexor-Store-Identity": "1",
    });
    expect(opted.status).toBe(200);
    expect(await opted.json()).toEqual({
      schemaVersion: 2,
      id: "prj-1",
      root: "/repo/a",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      nesting: [],
      created: true,
      storeId: "store-1",
    });
    expect(register.mock.calls[0][0]).toMatchObject({
      root: "/repo/a",
      idempotencyKey: "k1",
      clientId: "control-api",
    });
    expect("includeStoreId" in (register.mock.calls[0]![0] as object)).toBe(false);
    expect(register.mock.calls[1][0]).toMatchObject({
      root: "/repo/a",
      idempotencyKey: "k2",
      includeStoreId: true,
    });
  });

  it("probes with exactly the binding pair, and answers 501 without the service", async () => {
    const inspect = vi.fn(async () => ({
      projectId: "prj-1",
      storeId: "store-1",
      root: "/repo/a",
      state: "present",
    }));
    const call = await serve({ inspectProjectRegistration: inspect });
    const good = await call.probe("expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa");
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    expect(await good.json()).toEqual({
      projectId: "prj-1",
      storeId: "store-1",
      root: "/repo/a",
      state: "present",
    });
    expect(inspect.mock.calls[0]).toEqual([
      "prj-1",
      { expectedStoreId: "store-1", expectedRoot: "/repo/a" },
      undefined, // Absent candidate: the call still carries the third argument.
    ]);
    for (const query of ["", "expectedStoreId=store-1", "expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa&extra=1"]) {
      const bad = await call.probe(query);
      expect(bad.status, query).toBe(400);
    }
    expect(inspect).toHaveBeenCalledTimes(1);
    const unsupported = await (await serve({})).probe(
      "expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa",
    );
    expect(unsupported.status).toBe(501);
  });

  it("carries exactly one admitted candidate to the comparison, refusing the rest", async () => {
    const inspect = vi.fn(async (_id: string, _binding: unknown, candidate?: string) => ({
      projectId: "prj-1",
      storeId: "store-1",
      root: "/repo/a",
      state: "present",
      ...(candidate !== undefined ? { candidateMatch: "same" as const } : {}),
    }));
    const call = await serve({ inspectProjectRegistration: inspect });
    const matched = await call.probe(
      "expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa&candidate=%2Falias%2Fof%2Fa",
    );
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual({
      projectId: "prj-1",
      storeId: "store-1",
      root: "/repo/a",
      state: "present",
      candidateMatch: "same",
    });
    expect(inspect.mock.calls[0]).toEqual([
      "prj-1",
      { expectedStoreId: "store-1", expectedRoot: "/repo/a" },
      "/alias/of/a",
    ]);
    const relative = await call.probe(
      "expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa&candidate=alias",
    );
    expect(relative.status).toBe(400);
    const repeated = await call.probe(
      "expectedStoreId=store-1&expectedRoot=%2Frepo%2Fa&candidate=%2Fa&candidate=%2Fa",
    );
    expect(repeated.status).toBe(400);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("releases with the body binding, passing typed refusals through", async () => {
    const release = vi
      .fn()
      .mockResolvedValueOnce({
        projectId: "prj-1",
        storeId: "store-1",
        root: "/repo/a",
        state: "released",
      })
      .mockResolvedValueOnce({
        projectId: "prj-1",
        storeId: "store-1",
        root: "/repo/a",
        state: "absent",
      });
    const call = await serve({ releaseProject: release });
    const binding = { expectedStoreId: "store-1", expectedRoot: "/repo/a" };
    const released = await call.release(binding);
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({
      projectId: "prj-1",
      storeId: "store-1",
      root: "/repo/a",
      state: "released",
    });
    const repeated = await call.release(binding);
    expect(await repeated.json()).toMatchObject({ state: "absent" });
    expect(release.mock.calls).toEqual([
      ["prj-1", binding],
      ["prj-1", binding],
    ]);
    // A missing binding field refuses before the service; an empty body is not a binding.
    const invalid = await call.release({ expectedStoreId: "store-1" });
    expect(invalid.status).toBe(400);
    const query = await call.release(binding, "?unexpected=1");
    expect(query.status).toBe(400);
    expect(release).toHaveBeenCalledTimes(2);
    const busy = Object.assign(
      new Error("project prj-1 has unfinished work or a reserved next message"),
      { code: "project_has_active_run", status: 409 },
    );
    const refused = await serve({ releaseProject: vi.fn().mockRejectedValue(busy) });
    const answer = await refused.release(binding);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "project_has_active_run" });
  });
});
