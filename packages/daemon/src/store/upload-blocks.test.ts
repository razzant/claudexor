import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";
import { EXTERNAL_WRITE_BLOCK_BYTES } from "./external-files.js";
import {
  resourceFixture,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

/** Every positioned write of an upload part, as the pool received it. */
const parts = vi.hoisted(() => ({ writes: [] as number[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!String(args[0]).endsWith(".part")) return handle;
      const write = handle.write.bind(handle);
      handle.write = (async (...writeArgs: Parameters<typeof write>) => {
        const written = await write(...writeArgs);
        parts.writes.push(written.bytesWritten);
        return written;
      }) as typeof handle.write;
      return handle;
    },
  };
});

const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
afterEachClosed(async () => {
  parts.writes.length = 0;
  for (const opened of fixtures.splice(0)) await opened.close();
  const owned = roots.splice(0);
  return () => {
    for (const root of owned) rmSync(root, { recursive: true, force: true });
  };
});
async function fixture(): Promise<ResourceFixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cx-upload-blocks-")));
  roots.push(root);
  const opened = await resourceFixture(root);
  fixtures.push(opened);
  return opened;
}
async function* network(body: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < body.length; offset += size)
    yield Buffer.from(body.subarray(offset, offset + size));
}

describeStore("an upload is accepted in large blocks", () => {
  it("writes a body sent in 64 KiB chunks as 1 MiB O_DSYNC blocks, byte-exact", async () => {
    const f = await fixture();
    const body = randomBytes(3 * EXTERNAL_WRITE_BLOCK_BYTES + 768 * 1024);
    const sha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const status = f.resources.create({ ...uploadRequest, sizeBytes: body.length }, "blocks");
    expect(await f.resources.write(status.uploadId, network(body, 64 * 1024))).toMatchObject({
      state: "uploaded",
      receivedBytes: body.length,
    });
    expect(parts.writes).toEqual([
      EXTERNAL_WRITE_BLOCK_BYTES,
      EXTERNAL_WRITE_BLOCK_BYTES,
      EXTERNAL_WRITE_BLOCK_BYTES,
      768 * 1024,
    ]);
    expect(readFileSync(join(f.store.paths.uploads, `${status.uploadId}.part`))).toEqual(body);
    const finalized = await f.resources.finalize(status.uploadId, sha256, "blocks-final");
    expect(finalized).toMatchObject({ sha256 });
  });

  it("refuses the chunk that exceeds the declared size before writing it, and a wrong total", async () => {
    const f = await fixture();
    const body = randomBytes(EXTERNAL_WRITE_BLOCK_BYTES / 2);
    const over = f.resources.create({ ...uploadRequest, sizeBytes: body.length - 1 }, "over");
    await expect(f.resources.write(over.uploadId, network(body, 4096))).rejects.toMatchObject({
      code: "upload_size_exceeded",
    });
    expect(parts.writes).toEqual([]);
    const short = f.resources.create({ ...uploadRequest, sizeBytes: body.length + 1 }, "short");
    await expect(f.resources.write(short.uploadId, network(body, 4096))).rejects.toMatchObject({
      code: "upload_size_mismatch",
    });
    expect(parts.writes).toEqual([body.length]);
  });
});
