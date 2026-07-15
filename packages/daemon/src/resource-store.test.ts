import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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

    const first = store.create({
      kind: "file",
      mime: "text/plain",
      name: "note.txt",
      sizeBytes: bytes.length,
    });
    await expect(
      store.write(first.uploadId, chunks("generic ", "sentinel")),
    ).resolves.toMatchObject({
      state: "uploaded",
      receivedBytes: bytes.length,
    });
    const resource = store.finalize(first.uploadId, digest);
    expect(resource).toMatchObject({
      sha256: digest,
      sizeBytes: bytes.length,
      deduplicated: false,
    });
    const [resolved] = store.resolve([{ resourceId: resource.resourceId }]);
    expect(resolved?.sha256).toBe(digest);
    expect(readFileSync(resolved?.path ?? "", "utf8")).toBe("generic sentinel");

    const second = store.create({
      kind: "file",
      mime: "text/plain",
      name: "copy.txt",
      sizeBytes: bytes.length,
    });
    await store.write(second.uploadId, chunks("generic sentinel"));
    expect(store.finalize(second.uploadId).deduplicated).toBe(true);
  });

  it("reports progress and cancels without producing a resource", async () => {
    const store = new ResourceStore(mkdtempSync(join(tmpdir(), "claudexor-resource-cancel-")));
    const upload = store.create({ kind: "image", mime: "image/png", name: "x.png", sizeBytes: 4 });
    expect(store.status(upload.uploadId)).toMatchObject({ state: "open", receivedBytes: 0 });
    expect(store.cancel(upload.uploadId)).toMatchObject({ state: "cancelled" });
    expect(() => store.finalize(upload.uploadId)).toThrow(/cancelled/);
  });

  it("fails closed on size or digest mismatch", async () => {
    const store = new ResourceStore(mkdtempSync(join(tmpdir(), "claudexor-resource-mismatch-")));
    const short = store.create({ kind: "file", mime: "text/plain", name: "x", sizeBytes: 2 });
    await expect(store.write(short.uploadId, chunks("x"))).rejects.toThrow(/size mismatch/);

    const badDigest = store.create({ kind: "file", mime: "text/plain", name: "x", sizeBytes: 1 });
    await store.write(badDigest.uploadId, chunks("x"));
    expect(() => store.finalize(badDigest.uploadId, `sha256:${"0".repeat(64)}`)).toThrow(
      /digest does not match/,
    );
  });
});
