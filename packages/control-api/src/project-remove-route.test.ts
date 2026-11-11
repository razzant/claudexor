import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonFacadeClient } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

const receipt = {
  projectId: "prj-1",
  root: "/repo/a",
  registryRemoved: true,
  journalPartitionArchived: true,
  archivedPartitionPath: "partition:project:prj-1@e1",
  artifactsRetained: true,
  activeRunCheck: "snapshot",
};

async function serve(removeProject: (...args: unknown[]) => Promise<unknown>) {
  const server = new DaemonControlApiServer({
    token: "fixture",
    daemon: {} as unknown as DaemonFacadeClient,
    services: { removeProject },
  });
  servers.push(server);
  const { host, port } = await server.start();
  return (path: string) =>
    fetch(`http://${host}:${port}/v2${path}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer fixture", "X-Claudexor-Protocol-Major": "3" },
    });
}

describe("DELETE /v2/projects/:id trashed-thread opt-in (#333)", () => {
  it("advertises the exact optional query on the unchanged operation", () => {
    const remove = OPERATION_CATALOG.operations.find(
      (op) => op.method === "DELETE" && op.path === "/v2/projects/:id",
    );
    expect(remove).toMatchObject({
      mutability: "mutating",
      requestSchema: null,
      responseSchema: "ControlProjectRemoveReceipt",
      idempotency: "natural",
      parameters: [
        expect.objectContaining({
          name: "trashedThreads",
          location: "query",
          required: false,
          repeatable: false,
          enum: ["purge"],
        }),
      ],
    });
    expect(remove?.summary).toContain("trashedThreads=purge");
  });

  it("calls the unchanged service shape by default and passes only the exact opt-in", async () => {
    const service = vi.fn(async (_id: unknown, options?: unknown) =>
      options ? { ...receipt, purgedThreads: [] } : receipt,
    );
    const call = await serve(service);
    const plain = await call("/projects/prj-1");
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual(receipt);
    expect(service.mock.calls[0]).toEqual(["prj-1"]);
    const opted = await call("/projects/prj-1?trashedThreads=purge");
    expect(opted.status).toBe(200);
    expect(await opted.json()).toEqual({ ...receipt, purgedThreads: [] });
    expect(service.mock.calls[1]).toEqual(["prj-1", { trashedThreads: "purge" }]);
  });

  it("refuses a repeated or inexact opt-in value before the service runs", async () => {
    const service = vi.fn(async () => receipt);
    const call = await serve(service);
    for (const query of [
      "trashedThreads",
      "trashedThreads=",
      "trashedThreads=true",
      "trashedThreads=Purge",
      "trashedThreads=purge&trashedThreads=purge",
      "trashedThreads=purge&trashedThreads=true",
      "unrelated=1&trashedThreads=yes",
    ]) {
      const response = await call(`/projects/prj-1?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
    expect(service).not.toHaveBeenCalled();
  });

  it("keeps ignoring other query parameters, so a misspelled name gets the default removal", async () => {
    const service = vi.fn(async (_id: unknown, options?: unknown) =>
      options ? { ...receipt, purgedThreads: [] } : receipt,
    );
    const call = await serve(service);
    for (const query of [
      "trashedThread=purge",
      "TrashedThreads=purge",
      "trashed_threads=purge",
      "purge=true",
      "unrelated=1",
    ]) {
      const response = await call(`/projects/prj-1?${query}`);
      expect(response.status, query).toBe(200);
      expect(await response.json()).toEqual(receipt);
      expect(service.mock.lastCall, query).toEqual(["prj-1"]);
    }
    const opted = await call("/projects/prj-1?unrelated=1&trashedThreads=purge");
    expect(opted.status).toBe(200);
    expect(service.mock.lastCall).toEqual(["prj-1", { trashedThreads: "purge" }]);
  });

  it("keeps typed refusals and rejects a receipt outside the contract", async () => {
    const refusal = Object.assign(new Error("project prj-1 still has 1 thread(s)"), {
      code: "project_has_threads",
      status: 409,
    });
    const call = await serve(
      vi
        .fn()
        .mockRejectedValueOnce(refusal)
        .mockResolvedValueOnce({
          ...receipt,
          purgedThreads: [{ threadId: "th-a", cleanup: "unknown", cleanupError: null }],
        }),
    );
    const refused = await call("/projects/prj-1?trashedThreads=purge");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "project_has_threads" });
    const invalid = await call("/projects/prj-1?trashedThreads=purge");
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toMatchObject({ code: "invalid_service_response" });
  });
});
