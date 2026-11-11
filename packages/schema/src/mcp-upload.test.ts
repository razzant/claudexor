import { describe, expect, it } from "vitest";
import { ControlUploadImport, ControlUploadImportRequest } from "./attachment.js";
import {
  McpStoreIdentityInput,
  McpUploadCreateInput,
  McpUploadFinalizeInput,
  McpUploadImportInput,
  McpUploadImportLocalInput,
} from "./mcp-upload.js";

describe("attachment ingress inputs", () => {
  const request = { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 4 };
  it("requires caller-owned stage keys and rejects model purpose", () => {
    expect(McpUploadCreateInput.parse({ request, idempotencyKey: "create-key" }).request).toEqual(
      request,
    );
    for (const idempotencyKey of [undefined, "", " "]) {
      expect(McpUploadCreateInput.safeParse({ request, idempotencyKey }).success).toBe(false);
    }
    expect(
      McpUploadCreateInput.safeParse({
        request: { ...request, purpose: "model" },
        idempotencyKey: "k",
      }).success,
    ).toBe(false);
    expect(
      McpUploadFinalizeInput.parse({
        uploadId: "u",
        request: { expectedSha256: "sha256:abc" },
        idempotencyKey: "final-key",
      }),
    ).toMatchObject({ idempotencyKey: "final-key" });
    expect(McpUploadFinalizeInput.safeParse({ uploadId: "u", request: {} }).success).toBe(false);
  });
  it("requires an explicit host path and upload identity", () => {
    expect(McpUploadImportLocalInput.parse({ uploadId: "u", path: "/host/note.txt" })).toEqual({
      uploadId: "u",
      path: "/host/note.txt",
    });
    expect(McpUploadImportLocalInput.safeParse({ path: "/host/note.txt" }).success).toBe(false);
    expect(
      McpUploadImportLocalInput.safeParse({ uploadId: "u", path: "/host/note.txt", base64: "abc" })
        .success,
    ).toBe(false);
  });
  it("binds a keyed import to a saved store, exact arguments and an exact digest", () => {
    const call = { expectedStoreId: "store-1", path: "/host/note.txt", idempotencyKey: "k" };
    expect(McpUploadImportInput.parse(call)).toEqual(call);
    for (const field of ["expectedStoreId", "path", "idempotencyKey"] as const) {
      const { [field]: _omitted, ...missing } = call;
      expect(McpUploadImportInput.safeParse(missing).success).toBe(false);
    }
    expect(McpUploadImportInput.safeParse({ ...call, uploadId: "u" }).success).toBe(false);
    expect(McpStoreIdentityInput.safeParse({ storeId: "x" }).success).toBe(false);
    const request = { expectedStoreId: "store-1", kind: "file", mime: "text/plain" };
    expect(ControlUploadImportRequest.parse(request)).toEqual({ ...request, name: "" });
    const content = { sizeBytes: 4, sha256: `sha256:${"a".repeat(64)}` };
    expect(ControlUploadImportRequest.parse({ ...request, content }).content).toEqual(content);
    for (const bad of [
      { ...request, content: { sizeBytes: 4, sha256: "sha256:abc" } },
      { ...request, content: { sizeBytes: 4, sha256: `sha256:${"A".repeat(64)}` } },
      { ...request, path: "/srv/note.txt" },
      { ...request, purpose: "model" },
      { kind: "file", mime: "text/plain" },
    ])
      expect(ControlUploadImportRequest.safeParse(bad).success).toBe(false);
    const resource = {
      resourceId: "r",
      kind: "file",
      mime: "text/plain",
      name: "note.txt",
      sha256: content.sha256,
      sizeBytes: 4,
      createdAt: "2026-10-27T00:00:00.000Z",
      deduplicated: false,
    };
    const ready = {
      storeId: "store-1",
      state: "ready",
      uploadId: "u",
      content,
      receivedBytes: 4,
      resource,
    };
    expect(ControlUploadImport.parse(ready)).toEqual(ready);
    const { resource: _resource, ...open } = ready;
    expect(ControlUploadImport.parse({ ...open, state: "open" }).state).toBe("open");
    expect(ControlUploadImport.safeParse({ ...ready, state: "open" }).success).toBe(false);
    expect(ControlUploadImport.safeParse(open).success).toBe(false);
    expect(ControlUploadImport.safeParse({ ...ready, storeId: undefined }).success).toBe(false);
  });
});
