import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer, type DaemonControlApiOptions } from "./daemon-server.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

const servers: DaemonControlApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});
const storeId = "7f0c2f43-6a39-4b8e-8f39-1c2b9c7d1e55";
const content = { sizeBytes: 5, sha256: `sha256:${"1".repeat(64)}` };
const request = { expectedStoreId: storeId, kind: "file", mime: "text/plain", content };
const state = {
  storeId,
  state: "open",
  uploadId: "upl-1",
  content,
  receivedBytes: 0,
};
async function fixture(services: DaemonControlApiOptions["services"]) {
  const server = new DaemonControlApiServer({
    token: "import-route",
    daemon: { enqueue: vi.fn(), status: vi.fn(), list: vi.fn(async () => []), cancel: vi.fn() },
    services,
  });
  servers.push(server);
  const address = await server.start();
  return async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${address.host}:${address.port}/v2${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer import-route",
        "X-Claudexor-Protocol-Major": "3",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
}

describe("POST /v2/uploads/imports", () => {
  it("is the cataloged keyed-import feature marker", async () => {
    const descriptor = OPERATION_CATALOG.operations.find(
      (operation) => operation.method === "POST" && operation.path === "/v2/uploads/imports",
    );
    expect(descriptor).toMatchObject({
      id: "post:uploads.imports",
      requestSchema: "ControlUploadImportRequest",
      responseSchema: "ControlUploadImport",
      mutability: "mutating",
      idempotency: "key_required",
    });
    const call = await fixture({});
    const live = await call("/operations", undefined);
    expect(live.body.operations.map((operation: { id: string }) => operation.id)).toContain(
      "post:uploads.imports",
    );
  });

  it("passes the exact request and key to the upload owner and validates its answer", async () => {
    const importUpload = vi.fn(async () => state);
    const call = await fixture({ importUpload });
    expect(await call("/uploads/imports", request, { "Idempotency-Key": "k" })).toEqual({
      status: 200,
      body: state,
    });
    expect(importUpload).toHaveBeenCalledWith({ ...request, name: "" }, "k");
    importUpload.mockResolvedValueOnce({ ...state, state: "ready" });
    expect((await call("/uploads/imports", request, { "Idempotency-Key": "k" })).status).toBe(500);
  });

  it("refuses an unkeyed or store-less request before the owner runs", async () => {
    const importUpload = vi.fn(async () => state);
    const call = await fixture({ importUpload });
    expect(await call("/uploads/imports", request)).toMatchObject({
      status: 400,
      body: { code: "idempotency_key_required" },
    });
    const { expectedStoreId: _omitted, ...storeless } = request;
    expect((await call("/uploads/imports", storeless, { "Idempotency-Key": "k" })).status).toBe(
      400,
    );
    expect(
      (await call("/uploads/imports", { ...request, path: "/srv/x" }, { "Idempotency-Key": "k" }))
        .status,
    ).toBe(400);
    expect(importUpload).not.toHaveBeenCalled();
  });

  it("keeps typed owner refusals on the wire", async () => {
    const refusal = (code: string, status: number, context?: Record<string, unknown>) =>
      Object.assign(new Error(code), { code, status, ...(context ? { context } : {}) });
    const importUpload = vi
      .fn()
      .mockRejectedValueOnce(refusal("store_mismatch", 409))
      .mockRejectedValueOnce(
        refusal("upload_import_content_conflict", 409, { uploadId: "upl-1", content }),
      )
      .mockRejectedValueOnce(refusal("upload_import_not_found", 404));
    const call = await fixture({ importUpload });
    const headers = { "Idempotency-Key": "k" };
    expect(await call("/uploads/imports", request, headers)).toMatchObject({
      status: 409,
      body: { code: "store_mismatch" },
    });
    expect(await call("/uploads/imports", request, headers)).toMatchObject({
      status: 409,
      body: { code: "upload_import_content_conflict", context: { uploadId: "upl-1", content } },
    });
    expect(await call("/uploads/imports", request, headers)).toMatchObject({
      status: 404,
      body: { code: "upload_import_not_found" },
    });
  });
});
