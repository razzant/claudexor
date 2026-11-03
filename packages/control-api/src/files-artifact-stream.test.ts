import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { stringify } from "yaml";
import { readArtifact } from "./artifact-read.js";
import { locateFilesArtifact, streamFilesArtifact } from "./files-artifact-stream.js";
import { readFilesWorkProduct } from "./files-work-product.js";
import { inRunProjection } from "./projection-context.js";
import { readRawTextArtifact } from "./run-artifact-read.js";

const digest = (data: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

describe("immutable artifact transfer after a finite manifest lookup", () => {
  let root: string;
  const relative = "final/files/output.bin";
  const payload = Buffer.alloc(128 * 1024, 0x51);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-artifact-stream-"));
    mkdirSync(join(root, "final/files"), { recursive: true });
    writeFileSync(join(root, relative), payload);
    const manifest = JSON.stringify({
      version: 1,
      sourceRoot: root,
      executionRoot: join(root, "execution"),
      isolation: "envelope",
      scopePaths: ["output.bin"],
      complete: true,
      entries: [
        {
          path: "output.bin",
          before: null,
          after: {
            kind: "file",
            sha256: digest(payload),
            sizeBytes: payload.byteLength,
            mode: 0o644,
            artifactPath: relative,
          },
        },
      ],
    });
    writeFileSync(join(root, "final/files/manifest.json"), manifest);
    writeFileSync(
      join(root, "final/work_product.yaml"),
      stringify({
        id: "wp",
        kind: "files",
        source_task_id: "task",
        producer_attempt_id: "attempt",
        files: { manifest: "final/files/manifest.json" },
        meta: { manifest_sha256: digest(manifest) },
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }), 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

  function response() {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setImmediate(callback);
      },
    });
    return { stream: Object.assign(stream, { writeHead: vi.fn() }), chunks };
  }

  it("returns a plain descriptor then streams complete bytes with response backpressure", async () => {
    const result = readArtifact({ kind: "fetch", root, relative, runArtifact: true });
    if (result.kind !== "files") throw new Error("Expected immutable file descriptor");
    expect(structuredClone(result)).toEqual(result);
    expect(result.transfer).toEqual({
      path: realpathSync(join(root, relative)),
      expectedHash: digest(payload),
      expectedSize: payload.byteLength,
      contentType: "application/octet-stream",
    });
    const { stream, chunks } = response();
    await streamFilesArtifact(result.transfer, stream as unknown as ServerResponse);
    expect(Buffer.concat(chunks)).toEqual(payload);
    expect(stream.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": payload.byteLength,
      ETag: `"${digest(payload)}"`,
    });
  });

  it("refuses bytes changed after lookup before sending any response headers", async () => {
    const transfer = locateFilesArtifact(root, relative)!;
    writeFileSync(join(root, relative), Buffer.alloc(payload.length, 0x52));
    const { stream, chunks } = response();
    await expect(
      streamFilesArtifact(transfer, stream as unknown as ServerResponse),
    ).rejects.toThrow("Files artifact digest mismatch");
    expect(stream.writeHead).not.toHaveBeenCalled();
    expect(chunks).toEqual([]);
    stream.destroy();
  });

  it("retains exact manifest hash and typed content while leaving unrelated files ordinary", () => {
    const transfer = locateFilesArtifact(root, "final/files/manifest.json")!;
    expect(transfer.contentType).toBe("application/json");
    expect(locateFilesArtifact(root, "other.txt")).toBeNull();
    writeFileSync(join(root, "final/files/manifest.json"), "{}");
    expect(() => locateFilesArtifact(root, relative)).toThrow("Files manifest digest mismatch");
  });

  it("does not open or write an already-cancelled transfer", async () => {
    const transfer = locateFilesArtifact(root, relative)!;
    rmSync(join(root, relative));
    const abort = new AbortController();
    const reason = new Error("reader disconnected");
    abort.abort(reason);
    const { stream } = response();
    await expect(
      streamFilesArtifact(transfer, stream as unknown as ServerResponse, abort.signal),
    ).rejects.toBe(reason);
    expect(stream.writeHead).not.toHaveBeenCalled();
    stream.destroy();
  });

  it.each([true, false])(
    "memoizes Files authority and presentation independently within a request (raw first=%s)",
    (rawFirst) => {
      const record = { id: "r", state: "succeeded", runDir: root };
      const path = join(root, "final/work_product.yaml");
      const original = readFileSync(path, "utf8");
      inRunProjection(() => {
        if (rawFirst) expect(readRawTextArtifact(record, "final/work_product.yaml")).toBe(original);
        else expect(readFilesWorkProduct(record)?.manifestPath).toBe("final/files/manifest.json");
        expect(readRawTextArtifact(record, "final/work_product.yaml")).toBe(original);
        expect(readFilesWorkProduct(record)?.manifestPath).toBe("final/files/manifest.json");
        writeFileSync(path, "not-a-work-product");
        expect(readFilesWorkProduct(record)?.manifestPath).toBe("final/files/manifest.json");
        expect(readRawTextArtifact(record, "final/work_product.yaml")).toBe(original);
      });
      expect(() => readFilesWorkProduct(record)).toThrow();
      expect(readRawTextArtifact(record, "final/work_product.yaml")).toBe("not-a-work-product");
    },
  );
});
