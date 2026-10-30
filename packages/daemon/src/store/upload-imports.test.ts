import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { putUploadInTx, readUploadRow } from "./resource-rows.js";
import { runMutation } from "./mutation.js";
import { chunks, resourceFixture, type ResourceFixture } from "./test-support/resource-fixture.js";

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "cx-upload-imports-"));
  roots.push(path);
  return path;
}
async function open(path = root()) {
  const f = await resourceFixture(path, { manualTick: true });
  fixtures.push(f);
  return f;
}
async function close(f: ResourceFixture) {
  fixtures.splice(fixtures.indexOf(f), 1);
  await f.close();
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) await f.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const bytes = Buffer.from("keyed import bytes\n");
const content = {
  sizeBytes: bytes.length,
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
};
const semantic = { kind: "file", mime: "text/plain", name: "brief.txt", source: "/host/brief.txt" };
const body = (f: ResourceFixture, extra: Record<string, unknown> = {}) => ({
  expectedStoreId: f.store.storeId,
  ...semantic,
  ...extra,
});
const count = (f: ResourceFixture, table: string) =>
  Number((f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
const effects = (f: ResourceFixture) =>
  ["upload", "idempotency", "resource", "effect_obligation"].map((table) => count(f, table));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected a typed failure");
};
async function* broken(first: Uint8Array): AsyncIterable<Uint8Array> {
  yield first;
  throw Object.assign(new Error("client connection reset"), { code: "ECONNRESET" });
}

describe("keyed upload import over the upload owner", () => {
  it("replays a completed import as its original resource and binds the exact arguments", async () => {
    const f = await open();
    expect(code(() => f.resources.importUpload(body(f), "k1"))).toBe("upload_import_not_found");
    expect(effects(f)).toEqual([0, 0, 0, 0]);
    const begun = f.resources.importUpload(body(f, { content }), "k1");
    expect(begun).toMatchObject({ storeId: f.store.storeId, state: "open", content });
    expect(f.resources.importUpload(body(f), "k1")).toEqual(begun);
    await f.resources.write(begun.uploadId, chunks(bytes));
    const ready = f.resources.importUpload(body(f), "k1");
    expect(ready).toMatchObject({ state: "ready", uploadId: begun.uploadId, content });
    expect(ready.resource).toMatchObject({ ...content, kind: "file", name: "brief.txt" });
    const [attachment] = f.resources.resolve([{ resourceId: ready.resource!.resourceId }]);
    expect(readFileSync(attachment!.path)).toEqual(bytes);
    const settled = effects(f);
    for (const replay of [body(f), body(f, { content })])
      expect(f.resources.importUpload(replay, "k1")).toEqual(ready);
    // Other arguments or other content under the same key are refused without effects.
    expect(code(() => f.resources.importUpload(body(f, { name: "other.txt" }), "k1"))).toBe(
      "idempotency_conflict",
    );
    expect(code(() => f.resources.importUpload(body(f, { source: "/host/b.txt" }), "k1"))).toBe(
      "idempotency_conflict",
    );
    const edition = { sizeBytes: 3, sha256: `sha256:${"a".repeat(64)}` };
    let conflict: unknown;
    try {
      f.resources.importUpload(body(f, { content: edition }), "k1");
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      code: "upload_import_content_conflict",
      status: 409,
      context: { uploadId: begun.uploadId, content },
    });
    expect(effects(f)).toEqual(settled);
    // The ordinary finalize stage cannot complete or re-key an import upload.
    expect(code(() => f.resources.finalize(begun.uploadId, content.sha256, "other"))).toBe(
      "upload_not_found",
    );
  });

  it("refuses another store before any lookup or effect", async () => {
    const f = await open();
    const wrong = "00000000-0000-4000-8000-000000000000";
    expect(
      code(() => f.resources.importUpload(body(f, { content, expectedStoreId: wrong }), "k")),
    ).toBe("store_mismatch");
    expect(effects(f)).toEqual([0, 0, 0, 0]);
    const begun = f.resources.importUpload(body(f, { content }), "k");
    expect(code(() => f.resources.importUpload(body(f, { expectedStoreId: wrong }), "k"))).toBe(
      "store_mismatch",
    );
    expect(f.resources.importUpload(body(f), "k")).toEqual(begun);
    expect(() => f.resources.importUpload({ ...semantic, content }, "k")).toThrow();
  });

  it("returns an unverified or interrupted transfer to open, unlike an ordinary upload", async () => {
    const f = await open();
    const begun = f.resources.importUpload(body(f, { content }), "k");
    const wrong = Buffer.alloc(bytes.length, 0x41);
    await expect(f.resources.write(begun.uploadId, chunks(wrong))).rejects.toMatchObject({
      code: "digest_mismatch",
    });
    expect(f.resources.importUpload(body(f), "k")).toMatchObject({
      state: "open",
      receivedBytes: 0,
    });
    await expect(f.resources.write(begun.uploadId, broken(bytes.subarray(0, 4)))).rejects.toThrow(
      /connection reset/,
    );
    expect(f.resources.status(begun.uploadId)).toMatchObject({ state: "open", receivedBytes: 0 });
    await expect(
      f.resources.write(begun.uploadId, chunks(bytes, Buffer.from("x"))),
    ).rejects.toMatchObject({ code: "upload_size_exceeded" });
    expect(f.resources.status(begun.uploadId).state).toBe("open");
    await f.resources.write(begun.uploadId, chunks(bytes));
    expect(f.resources.importUpload(body(f), "k").state).toBe("ready");
    // The ordinary stage keeps its documented single-shot cancellation.
    const ordinary = f.resources.create(
      { kind: "file", mime: "text/plain", name: "o.txt", sizeBytes: bytes.length },
      "ordinary",
    );
    await expect(
      f.resources.write(ordinary.uploadId, broken(bytes.subarray(0, 4))),
    ).rejects.toThrow();
    expect(f.resources.status(ordinary.uploadId).state).toBe("cancelled");
  });

  it("keeps an explicit cancel terminal even when the active writer fails afterwards", async () => {
    const f = await open();
    const begun = f.resources.importUpload(body(f, { content }), "k");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    async function* slow(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 4);
      await gate;
      yield bytes.subarray(4);
    }
    const writing = f.resources.write(begun.uploadId, slow());
    await vi.waitFor(() => expect(f.resources.status(begun.uploadId).receivedBytes).toBe(4));
    expect(f.resources.cancel(begun.uploadId).state).toBe("cancelled");
    release();
    await expect(writing).rejects.toMatchObject({ code: "upload_cancelled" });
    expect(f.resources.importUpload(body(f), "k")).toMatchObject({ state: "cancelled" });
    await expect(f.resources.write(begun.uploadId, chunks(bytes))).rejects.toMatchObject({
      code: "upload_not_open",
    });
    expect(f.resources.importUpload(body(f, { content }), "k").state).toBe("cancelled");
    expect(count(f, "resource")).toBe(0);
  });

  it("refuses the ordinary finalize stage on an import upload and publishes only by replay", async () => {
    const f = await open();
    const begun = f.resources.importUpload(body(f, { content }), "k");
    await f.resources.write(begun.uploadId, chunks(bytes));
    expect(code(() => f.resources.finalize(begun.uploadId, content.sha256, "user-key"))).toBe(
      "upload_import_owned",
    );
    expect(count(f, "resource")).toBe(0);
    expect(f.resources.importUpload(body(f), "k").state).toBe("ready");
  });

  it("survives restart after the byte receipt, after publication, and during a transfer", async () => {
    const path = root();
    const first = await open(path);
    const storeId = first.store.storeId;
    const received = first.resources.importUpload(body(first, { content }), "receipt");
    await first.resources.write(received.uploadId, chunks(bytes));
    const published = first.resources.importUpload(body(first, { content }), "published");
    await first.resources.write(published.uploadId, chunks(bytes));
    const ready = first.resources.importUpload(body(first), "published");
    const streaming = first.resources.importUpload(body(first, { content }), "streaming");
    // A crashed writer leaves exactly this row behind.
    const row = readUploadRow(first.store, streaming.uploadId)!;
    runMutation(first.store, (tx) =>
      putUploadInTx(tx, {
        ...row,
        status: { ...row.status, state: "uploading", receivedBytes: 4 },
      }),
    );
    await close(first);

    const second = await open(path);
    expect(second.store.storeId).toBe(storeId);
    expect(second.resources.status(received.uploadId).state).toBe("uploaded");
    const recovered = second.resources.importUpload(body(second), "receipt");
    expect(recovered).toMatchObject({ state: "ready", resource: { sha256: content.sha256 } });
    expect(second.resources.importUpload(body(second), "published")).toEqual(ready);
    expect(second.resources.importUpload(body(second), "streaming")).toMatchObject({
      state: "open",
      receivedBytes: 0,
    });
    await close(second);
    const third = await open(path);
    expect(third.resources.importUpload(body(third), "receipt")).toEqual(recovered);
    expect(count(third, "resource")).toBe(2);
  });

  it("recovers an interrupted publication under the same import key after restart", async () => {
    const path = root();
    const first = await open(path);
    const begun = first.resources.importUpload(body(first, { content }), "k");
    await first.resources.write(begun.uploadId, chunks(bytes));
    vi.spyOn(first.blobs, "publishLink").mockImplementation(() => {
      throw Object.assign(new Error("injected link EIO"), { code: "EIO" });
    });
    expect(() => first.resources.importUpload(body(first), "k")).toThrow(/EIO/);
    const pending = readUploadRow(first.store, begun.uploadId)!;
    expect(pending.state).toBe("finalizing");
    await close(first);
    const second = await open(path);
    expect((await second.obligations.completeOpen()).failed).toEqual([]);
    const ready = second.resources.importUpload(body(second), "k");
    expect(ready).toMatchObject({ state: "ready", resource: pending.finalization!.result });
    expect(count(second, "resource")).toBe(1);
  });

  it("imports credential-named and credential-shaped files exactly (INV-146)", async () => {
    const f = await open();
    // Split so no literal key block lives in this source file.
    const secret = Buffer.from(
      "-----BEGIN " + "PRIVATE KEY-----\nAAAA\n-----END " + "PRIVATE KEY-----\n",
    );
    const secretContent = {
      sizeBytes: secret.length,
      sha256: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    };
    const begun = f.resources.importUpload(body(f, { content: secretContent, name: ".env" }), "s");
    await f.resources.write(begun.uploadId, chunks(secret));
    const finished = f.resources.importUpload(body(f, { name: ".env" }), "s");
    expect(finished.state).not.toBe("cancelled");
    expect(count(f, "resource")).toBe(1);
  });
});
