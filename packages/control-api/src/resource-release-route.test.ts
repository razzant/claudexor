import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const storeId = "7f0c2f43-6a39-4b8e-8f39-1c2b9c7d1e55";
const sha256 = `sha256:${"2".repeat(64)}`;
const receipt = {
  storeId,
  resourceId: "res-1",
  sha256,
  state: "released",
  releasedAt: "2026-11-04T12:00:00.000Z",
};
async function fixture(services: DaemonControlApiOptions["services"]) {
  const server = new DaemonControlApiServer({
    token: "release-route",
    daemon: { enqueue: vi.fn(), status: vi.fn(), list: vi.fn(async () => []), cancel: vi.fn() },
    services,
  });
  servers.push(server);
  const address = await server.start();
  return async (path: string, body?: unknown) => {
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer release-route",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

describe("POST /v2/resources/:id/release (#249)", () => {
  it("is the cataloged managed-lifetime marker the host gates on", async () => {
    const descriptor = OPERATION_CATALOG.operations.find(
      (operation) => operation.method === "POST" && operation.path === "/v2/resources/:id/release",
    );
    expect(descriptor).toMatchObject({
      requestSchema: "ControlResourceReleaseRequest",
      responseSchema: "ControlResourceRelease",
      mutability: "mutating",
      idempotency: "natural",
    });
    const call = await fixture({});
    const live = await call("/operations");
    expect(
      live.body.operations.some(
        (operation: { path: string }) => operation.path === "/v2/resources/:id/release",
      ),
    ).toBe(true);
  });

  it("passes the id and exact body to the owner, needs no key and validates the receipt", async () => {
    const releaseResource = vi.fn(async () => receipt);
    const call = await fixture({ releaseResource });
    const body = { expectedStoreId: storeId, sha256 };
    expect(await call("/resources/res-1/release", body)).toEqual({ status: 200, body: receipt });
    expect(releaseResource).toHaveBeenCalledWith("res-1", body);
    // A receipt that violates its schema is never forwarded as success.
    releaseResource.mockResolvedValueOnce({ ...receipt, state: "ready" } as never);
    expect((await call("/resources/res-1/release", body)).status).toBe(500);
    // Unknown fields and a missing store are refused before the owner runs.
    releaseResource.mockClear();
    expect((await call("/resources/res-1/release", { ...body, force: true })).status).toBe(400);
    expect((await call("/resources/res-1/release", { sha256 })).status).toBe(400);
    expect(releaseResource).not.toHaveBeenCalled();
  });

  it("keeps the owner's typed refusals on the wire", async () => {
    const refusal = (code: string, status: number) =>
      Object.assign(new Error(code), { code, status });
    const releaseResource = vi
      .fn()
      .mockRejectedValueOnce(refusal("resource_lifetime_indefinite", 409))
      .mockRejectedValueOnce(refusal("store_mismatch", 409));
    const call = await fixture({ releaseResource });
    const body = { expectedStoreId: storeId, sha256 };
    expect(await call("/resources/res-1/release", body)).toMatchObject({
      status: 409,
      body: { code: "resource_lifetime_indefinite" },
    });
    expect(await call("/resources/res-1/release", body)).toMatchObject({
      status: 409,
      body: { code: "store_mismatch" },
    });
  });
});
