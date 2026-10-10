import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlUploadCreateRequest, type ModelPayloadRef } from "@claudexor/schema";
import { ResourceStore } from "./resource-store.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    renameSync: vi.fn(original.renameSync),
    rmSync: vi.fn(original.rmSync),
    readFileSync: vi.fn(original.readFileSync),
    writeFileSync: vi.fn(original.writeFileSync),
  };
});

const original = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
function fixture(): { root: string; store: ResourceStore } {
  const root = fs.mkdtempSync(join(tmpdir(), "claudexor-model-resources-"));
  roots.push(root);
  return { root, store: new ResourceStore(root) };
}
afterEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(original.renameSync);
  vi.mocked(fs.rmSync).mockImplementation(original.rmSync);
  vi.mocked(fs.readFileSync).mockImplementation(original.readFileSync);
  vi.mocked(fs.writeFileSync).mockImplementation(original.writeFileSync);
  for (const root of roots.splice(0)) original.rmSync(root, { recursive: true, force: true });
});

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function refOf(resource: ModelPayloadRef): ModelPayloadRef {
  return {
    resourceId: resource.resourceId,
    sha256: resource.sha256,
    sizeBytes: resource.sizeBytes,
  };
}
async function* stream(bytes: Buffer): AsyncIterable<Uint8Array> {
  // Split in the middle of a multibyte UTF-8 character as well as the large body.
  yield bytes.subarray(0, 1);
  yield bytes.subarray(1, 1024);
  yield bytes.subarray(1024);
}
async function upload(store: ResourceStore, bytes: Buffer, key: string, model = true) {
  const status = store.create(
    {
      ...(model ? { purpose: "model" } : {}),
      kind: "file",
      mime: "application/json",
      name: "input.json",
      sizeBytes: bytes.length,
    },
    `create-${key}`,
  );
  await store.write(status.uploadId, stream(bytes));
  return status;
}

describe("model-purpose resources", () => {
  it("streams more than 10 MiB with exact UTF-8 and token-like fixture bytes, outside Agents", async () => {
    const { root, store } = fixture();
    const fake = `ghp_${"z".repeat(24)}`;
    const bytes = Buffer.concat([
      Buffer.from(`Я🦉\r\n${fake}\u0000`),
      Buffer.alloc(11 * 1024 * 1024, 97),
    ]);
    const status = await upload(store, bytes, "large");
    const resource = store.finalize(status.uploadId, digest(bytes), "final-large");
    expect(resource.purpose).toBe("model");
    // Buffer.equals proves byte identity without a multi-million-element
    // assertion diff consuming gigabytes of the test worker's heap.
    expect(store.readModel(refOf(resource)).equals(bytes)).toBe(true);
    expect(new ResourceStore(root).readModel(refOf(resource)).equals(bytes)).toBe(true);
    vi.mocked(fs.readFileSync).mockClear();
    expect(() => store.resolve([{ resourceId: resource.resourceId }])).toThrowError(
      expect.objectContaining({ code: "resource_purpose_mismatch" }),
    );
    expect(
      vi
        .mocked(fs.readFileSync)
        .mock.calls.some(([path]) => dirname(String(path)) === join(root, "blobs")),
    ).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(join(root, "blobs", resource.sha256.slice(7))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the legacy upload shape and generic secret fence intact", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("plain legacy attachment\r\n");
    const status = await upload(store, bytes, "legacy", false);
    expect(
      ControlUploadCreateRequest.parse({ kind: "file", mime: "text/plain", sizeBytes: 1 }),
    ).not.toHaveProperty("purpose");
    const resource = store.finalize(status.uploadId, digest(bytes), "final-legacy");
    expect(resource).not.toHaveProperty("purpose");
    expect(
      JSON.parse(fs.readFileSync(join(root, "resources", `${resource.resourceId}.json`), "utf8")),
    ).not.toHaveProperty("purpose");
    const restarted = new ResourceStore(root);
    expect(restarted.resolve([{ resourceId: resource.resourceId }])).toHaveLength(1);
    expect(() => restarted.readModel(refOf(resource))).toThrowError(
      expect.objectContaining({ code: "resource_purpose_mismatch" }),
    );
    const fake = Buffer.from(`ghp_${"z".repeat(24)}`);
    const denied = await upload(store, fake, "denied", false);
    expect(() => store.finalize(denied.uploadId, digest(fake), "final-denied")).toThrowError(
      expect.objectContaining({ code: "sensitive_resource_rejected" }),
    );
    expect(() =>
      store.create(
        {
          purpose: "model",
          kind: "file",
          mime: "application/json",
          name: "credentials.json",
          sizeBytes: 0,
        },
        "sensitive-name",
      ),
    ).toThrowError(expect.objectContaining({ code: "sensitive_resource_rejected" }));
  });

  it("publishes only the supplied byte view and checks references, contents and purpose", () => {
    const { root, store } = fixture();
    const bytes = Buffer.from(`prefix-🦉\r\n${"ghp_" + "z".repeat(24)}-suffix`);
    const view = bytes.subarray(7, bytes.length - 7);
    const ref = store.publishModel(view);
    expect(ref.sizeBytes).toBe(view.length);
    expect(store.readModel(ref)).toEqual(view);
    expect(store.listModelResources()).toEqual([{ ...ref, createdAt: expect.any(String) }]);
    for (const changed of [
      { ...ref, sizeBytes: ref.sizeBytes + 1 },
      { ...ref, sha256: `sha256:${"0".repeat(64)}` },
    ]) {
      expect(() => store.readModel(changed)).toThrowError(
        expect.objectContaining({ code: "resource_digest_mismatch" }),
      );
      expect(() => store.releaseModel(changed)).toThrowError(
        expect.objectContaining({ code: "resource_digest_mismatch" }),
      );
    }
    expect(() => store.readModel({ ...ref, resourceId: "../outside" })).toThrowError(
      expect.objectContaining({ code: "invalid_resource_id" }),
    );
    fs.writeFileSync(join(root, "blobs", ref.sha256.slice(7)), Buffer.alloc(view.length, 120));
    expect(() => store.readModel(ref)).toThrowError(
      expect.objectContaining({ code: "resource_digest_mismatch" }),
    );
  });

  it("releases exact resources idempotently without deleting a sibling's shared blob", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("identical bytes");
    const first = store.publishModel(bytes);
    const second = store.publishModel(bytes);
    const ordinaryUpload = await upload(store, bytes, "shared-attachment", false);
    const ordinary = store.finalize(ordinaryUpload.uploadId, digest(bytes), "final-shared");
    const blob = join(root, "blobs", first.sha256.slice(7));
    store.expireModel(first, "2026-01-31T00:00:00.000Z");
    store.expireModel(first, "2026-01-31T00:00:00.000Z");
    expect(store.readModel(second)).toEqual(bytes);
    store.releaseModel(second);
    expect(fs.existsSync(blob)).toBe(true);
    expect(store.resolve([{ resourceId: ordinary.resourceId }])).toHaveLength(1);
    expect(() => store.releaseModel(refOf(ordinary))).toThrowError(
      expect.objectContaining({ code: "resource_purpose_mismatch" }),
    );
    expect(store.listModelResources()).toEqual([]);
    const lone = store.publishModel(Buffer.from("unique bytes"));
    store.releaseModel(lone);
    expect(fs.existsSync(join(root, "blobs", lone.sha256.slice(7)))).toBe(false);
    expect(new ResourceStore(root).listModelResources()).toEqual([]);
  });

  it("keeps the metadata retry target if cleanup fails after unlinking the blob", () => {
    const { root, store } = fixture();
    const ref = store.publishModel(Buffer.from("cleanup crash"));
    vi.mocked(fs.rmSync).mockImplementation((path, options) => {
      original.rmSync(path, options);
      if (dirname(String(path)) === join(root, "blobs")) throw new Error("simulated cleanup crash");
    });
    expect(() => store.releaseModel(ref)).toThrow("simulated cleanup crash");
    expect(fs.existsSync(join(root, "resources", `${ref.resourceId}.json`))).toBe(true);
    vi.mocked(fs.rmSync).mockImplementation(original.rmSync);
    new ResourceStore(root).releaseModel(ref);
    expect(fs.readdirSync(join(root, "resources"))).toEqual([]);
  });
});

describe("resource result write failure", () => {
  it("removes an unpublished partial result when writing fails before finalization", () => {
    const { root, store } = fixture();
    vi.mocked(fs.writeFileSync).mockImplementation((path, data, options) => {
      original.writeFileSync(path, data, options);
      if (typeof path === "number") throw new Error("simulated result write failure");
    });
    expect(() => store.publishModel(Buffer.from("partial result"))).toThrow(
      "simulated result write failure",
    );
    expect(fs.readdirSync(join(root, "uploads"))).toEqual([]);
    expect(store.listModelResources()).toEqual([]);
    expect(fs.readdirSync(join(root, "blobs"))).toEqual([]);
  });
});

describe("resource finalize crash recovery", () => {
  it("preserves an unavailable finalization for exact retry without blocking other resources", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("pending bytes");
    const status = await upload(store, bytes, "damaged");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      original.renameSync(from, to);
      if (dirname(String(to)) === join(root, "blobs")) throw new Error("simulated rename crash");
    });
    expect(() => store.finalize(status.uploadId, digest(bytes), "final-damaged")).toThrow(
      "simulated rename crash",
    );
    vi.mocked(fs.renameSync).mockImplementation(original.renameSync);
    original.rmSync(join(root, "blobs", digest(bytes).slice(7)));
    const restarted = new ResourceStore(root);
    expect(() => restarted.finalize(status.uploadId, digest(bytes), "final-damaged")).toThrowError(
      expect.objectContaining({ code: "resource_unavailable" }),
    );
    const healthy = restarted.publishModel(Buffer.from("healthy"));
    expect(restarted.readModel(healthy).toString()).toBe("healthy");
  });

  it("does not publish a truncated uploaded file even when no expected hash was supplied", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("complete");
    const status = await upload(store, bytes, "truncated");
    fs.writeFileSync(join(root, "uploads", `${status.uploadId}.part`), "short");
    expect(() => store.finalize(status.uploadId, undefined, "final-truncated")).toThrowError(
      expect.objectContaining({ code: "upload_size_mismatch" }),
    );
    expect(store.listModelResources()).toEqual([]);
  });

  it.each(["binding", "blob", "resource", "idempotency", "cleanup"])(
    "recovers the same immutable resource after a crash at %s",
    async (point) => {
      const { root, store } = fixture();
      const bytes = Buffer.from("Я\r\nfull model payload");
      const status = await upload(store, bytes, point);
      let expected: ModelPayloadRef | undefined;
      let crashed = false;
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        original.renameSync(from, to);
        const parent = dirname(String(to));
        if (String(to) === join(root, "uploads", `${status.uploadId}.json`)) {
          const saved = JSON.parse(original.readFileSync(to, "utf8"));
          if (saved.finalization) expected = refOf(saved.finalization.result);
        }
        const hit =
          point === "binding"
            ? !!expected && parent === join(root, "uploads")
            : point === "blob"
              ? parent === join(root, "blobs")
              : point === "resource"
                ? parent === join(root, "resources")
                : point === "idempotency" && parent === join(root, "idempotency");
        if (hit && !crashed) {
          crashed = true;
          throw new Error(`simulated ${point} crash`);
        }
      });
      vi.mocked(fs.rmSync).mockImplementation((path, options) => {
        original.rmSync(path, options);
        if (
          point === "cleanup" &&
          String(path) === join(root, "uploads", `${status.uploadId}.json`) &&
          !crashed
        ) {
          crashed = true;
          throw new Error("simulated cleanup crash");
        }
      });
      expect(() => store.finalize(status.uploadId, digest(bytes), `final-${point}`)).toThrow(
        `simulated ${point} crash`,
      );
      expect(expected).toBeDefined();
      vi.mocked(fs.renameSync).mockImplementation(original.renameSync);
      vi.mocked(fs.rmSync).mockImplementation(original.rmSync);
      const restarted = new ResourceStore(root);
      const result = restarted.finalize(status.uploadId, digest(bytes), `final-${point}`);
      expect(refOf(result)).toEqual(expected);
      expect(restarted.readModel(refOf(result))).toEqual(bytes);
      expect(fs.readdirSync(join(root, "uploads"))).toEqual([]);
      expect(fs.readdirSync(join(root, "resources"))).toHaveLength(1);
      expect(() =>
        restarted.finalize(status.uploadId, `sha256:${"0".repeat(64)}`, `final-${point}`),
      ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
      restarted.releaseModel(refOf(result));
      const afterRelease = new ResourceStore(root);
      expect(afterRelease.finalize(status.uploadId, digest(bytes), `final-${point}`)).toEqual(
        result,
      );
      expect(afterRelease.listModelResources()).toEqual([]);
      expect(fs.readdirSync(join(root, "blobs"))).toEqual([]);
    },
  );

  it("resumes same-process finalize only under its original key, not a different purpose", async () => {
    const { root, store } = fixture();
    const bytes = Buffer.from("retry bytes");
    const status = await upload(store, bytes, "same-process");
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("metadata unavailable");
    });
    expect(() => store.finalize(status.uploadId, digest(bytes), "final-same")).toThrow(
      "metadata unavailable",
    );
    expect(() => store.finalize(status.uploadId, digest(bytes), "different-key")).toThrowError(
      expect.objectContaining({ code: "idempotency_conflict" }),
    );
    expect(() => store.cancel(status.uploadId)).toThrowError(
      expect.objectContaining({ code: "upload_finalizing" }),
    );
    const result = store.finalize(status.uploadId, digest(bytes), "final-same");
    expect(new ResourceStore(root).readModel(refOf(result))).toEqual(bytes);
    expect(() =>
      store.create(
        {
          purpose: "model",
          kind: "file",
          mime: "application/json",
          name: "input.json",
          sizeBytes: bytes.length,
        },
        "create-same-process",
      ),
    ).not.toThrow();
    expect(() =>
      store.create(
        { kind: "file", mime: "application/json", name: "input.json", sizeBytes: bytes.length },
        "create-same-process",
      ),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });
});
