import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResourceStore } from "./resource-store.js";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

describe("ResourceStore", () => {
  it("streams, fsyncs, finalizes, resolves by immutable id and deduplicates blobs", async () => {
    const store = new ResourceStore(mkdtempSync(join(tmpdir(), "claudexor-resources-")));
    const bytes = Buffer.from("generic sentinel");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    const first = store.create(
      {
        kind: "file",
        mime: "text/plain",
        name: "note.txt",
        sizeBytes: bytes.length,
      },
      "create-first",
    );
    await expect(
      store.write(first.uploadId, chunks("generic ", "sentinel")),
    ).resolves.toMatchObject({
      state: "uploaded",
      receivedBytes: bytes.length,
    });
    const resource = store.finalize(first.uploadId, digest, "finalize-first");
    expect(resource).toMatchObject({
      sha256: digest,
      sizeBytes: bytes.length,
      deduplicated: false,
    });
    const [resolved] = store.resolve([{ resourceId: resource.resourceId }]);
    expect(resolved?.sha256).toBe(digest);
    expect(readFileSync(resolved?.path ?? "", "utf8")).toBe("generic sentinel");

    const second = store.create(
      {
        kind: "file",
        mime: "text/plain",
        name: "copy.txt",
        sizeBytes: bytes.length,
      },
      "create-second",
    );
    await store.write(second.uploadId, chunks("generic sentinel"));
    expect(store.finalize(second.uploadId, undefined, "finalize-second").deduplicated).toBe(true);
  });

  it("reports progress and cancels without producing a resource", async () => {
    const store = new ResourceStore(mkdtempSync(join(tmpdir(), "claudexor-resource-cancel-")));
    const upload = store.create(
      { kind: "image", mime: "image/png", name: "x.png", sizeBytes: 4 },
      "create-cancel",
    );
    expect(store.status(upload.uploadId)).toMatchObject({ state: "open", receivedBytes: 0 });
    expect(store.cancel(upload.uploadId)).toMatchObject({ state: "cancelled" });
    expect(() => store.finalize(upload.uploadId, undefined, "finalize-cancel")).toThrow(
      /cancelled/,
    );
  });

  it("fails closed on size or digest mismatch", async () => {
    const store = new ResourceStore(mkdtempSync(join(tmpdir(), "claudexor-resource-mismatch-")));
    const short = store.create(
      { kind: "file", mime: "text/plain", name: "x", sizeBytes: 2 },
      "create-short",
    );
    await expect(store.write(short.uploadId, chunks("x"))).rejects.toThrow(/size mismatch/);

    const badDigest = store.create(
      { kind: "file", mime: "text/plain", name: "x", sizeBytes: 1 },
      "create-digest",
    );
    await store.write(badDigest.uploadId, chunks("x"));
    expect(() =>
      store.finalize(badDigest.uploadId, `sha256:${"0".repeat(64)}`, "finalize-digest"),
    ).toThrow(/digest does not match/);
  });

  it("returns the original create/finalize result and rejects key reuse with another digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-resource-idem-"));
    const store = new ResourceStore(root);
    const request = { kind: "file", mime: "text/plain", name: "x", sizeBytes: 1 };
    const upload = store.create(request, "same-create");
    expect(store.create(request, "same-create")).toEqual(upload);
    expect(() => store.create({ ...request, name: "other" }, "same-create")).toThrowError(
      expect.objectContaining({ code: "idempotency_conflict" }),
    );
    await store.write(upload.uploadId, chunks("x"));
    const resource = store.finalize(upload.uploadId, undefined, "same-finalize");
    expect(store.finalize(upload.uploadId, undefined, "same-finalize")).toEqual(resource);
    expect(() =>
      store.finalize(upload.uploadId, `sha256:${"0".repeat(64)}`, "same-finalize"),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));

    const restarted = new ResourceStore(root);
    expect(restarted.finalize(upload.uploadId, undefined, "same-finalize")).toEqual(resource);
  });

  it("restores an idempotent upload handle after daemon restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-resource-create-restart-"));
    const request = { kind: "file", mime: "text/plain", name: "x", sizeBytes: 1 };
    const first = new ResourceStore(root);
    const upload = first.create(request, "restart-create");
    const restarted = new ResourceStore(root);
    expect(restarted.create(request, "restart-create")).toEqual(upload);
    await expect(restarted.write(upload.uploadId, chunks("x"))).resolves.toMatchObject({
      state: "uploaded",
    });
  });

  it("rejects sensitive names and content before availability or vendor resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-resource-sensitive-"));
    const store = new ResourceStore(root);
    expect(() =>
      store.create(
        { kind: "file", mime: "application/json", name: "credentials.json", sizeBytes: 2 },
        "sensitive-name",
      ),
    ).toThrowError(expect.objectContaining({ code: "sensitive_resource_rejected" }));
    expect(readdirSync(join(root, "uploads"))).toEqual([]);

    const tokenLike = `ghp_${"z".repeat(24)}`;
    const bytes = Buffer.from(JSON.stringify({ authorization: tokenLike }));
    const upload = store.create(
      { kind: "file", mime: "application/json", name: "input.json", sizeBytes: bytes.length },
      "sensitive-content",
    );
    await store.write(upload.uploadId, chunks(bytes.toString("utf8")));
    let finalizeError: unknown;
    try {
      store.finalize(upload.uploadId, undefined, "sensitive-finalize");
    } catch (error) {
      finalizeError = error;
    }
    expect(finalizeError).toMatchObject({ code: "sensitive_resource_rejected", status: 422 });
    expect(String(finalizeError)).not.toContain(tokenLike);
    expect(store.status(upload.uploadId).state).toBe("cancelled");
    expect(existsSync(join(root, "uploads", `${upload.uploadId}.part`))).toBe(false);
    expect(readdirSync(join(root, "blobs"))).toEqual([]);
    expect(readdirSync(join(root, "resources"))).toEqual([]);

    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(join(root, "blobs", digest.slice("sha256:".length)), bytes);
    writeFileSync(
      join(root, "resources", "res-seeded.json"),
      JSON.stringify({
        resourceId: "res-seeded",
        kind: "file",
        mime: "application/json",
        name: "input.json",
        sha256: digest,
        sizeBytes: bytes.length,
        createdAt: "2026-07-15T00:00:00Z",
        deduplicated: false,
      }),
    );
    let resolveError: unknown;
    try {
      store.resolve([{ resourceId: "res-seeded" }]);
    } catch (error) {
      resolveError = error;
    }
    expect(resolveError).toMatchObject({ code: "sensitive_resource_rejected", status: 422 });
    expect(String(resolveError)).not.toContain(tokenLike);
  });
});
