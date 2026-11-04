import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";
import {
  chunks,
  resourceFixture,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      reads.paths.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "cx-finalize-digest-"));
  roots.push(path);
  return path;
}
async function open(path = root()): Promise<ResourceFixture> {
  const opened = await resourceFixture(path);
  fixtures.push(opened);
  return opened;
}
afterEachClosed(async () => {
  const ownedRoots = roots.splice(0);
  const owned = fixtures.splice(0);
  reads.paths.length = 0;
  for (const opened of owned) await opened.close();
  return () => {
    for (const path of ownedRoots) rmSync(path, { recursive: true, force: true });
  };
});

function partReads(dir: string): string[] {
  return reads.paths.filter((path) => path.startsWith(dir) && path.endsWith(".part"));
}

/** The write-time digests the upload owner still holds in memory. */
function heldDigests(f: ResourceFixture): ReadonlyMap<string, string> {
  return (f.resources as unknown as { uploads: { digests: Map<string, string> } }).uploads.digests;
}

describe("finalize uses the write-time digest", () => {
  it("does not read the part on the hot path, including a rejected expected digest", async () => {
    const f = await open();
    const body = Buffer.from("testdata");
    const initial = f.resources.create({ ...uploadRequest, sizeBytes: body.length }, "hot");
    await f.resources.write(initial.uploadId, chunks(body));
    reads.paths.length = 0;
    expect(() =>
      f.resources.finalize(initial.uploadId, `sha256:${"ab".repeat(32)}`, "bad-sha"),
    ).toThrow(expect.objectContaining({ code: "digest_mismatch" }));
    expect(partReads(f.store.paths.uploads)).toEqual([]);
    expect([...heldDigests(f).keys()]).toEqual([initial.uploadId]);
    reads.paths.length = 0;
    const receipt = f.resources.finalize(initial.uploadId, undefined, "hot-final");
    expect(partReads(f.store.paths.uploads)).toEqual([]);
    expect(heldDigests(f).size).toBe(0);
    expect(
      f.resources.readModel({
        resourceId: receipt.resourceId,
        sha256: receipt.sha256,
        sizeBytes: receipt.sizeBytes,
      }),
    ).toEqual(body);
    const result = f.resources.publishModel(Buffer.from('{"answer":1}'));
    expect(f.resources.readModel(result).toString()).toBe('{"answer":1}');
    expect(heldDigests(f).size).toBe(0);
  });

  it("still reads when replaying a publication, deduplicating, or recovering after restart", async () => {
    const path = root();
    const first = await open(path);
    const body = Buffer.from("testdata");
    const request = { ...uploadRequest, sizeBytes: body.length };
    const initial = first.resources.create(request, "replay");
    await first.resources.write(initial.uploadId, chunks(body));
    const link = vi.spyOn(first.blobs, "publishLink").mockImplementation(() => {
      throw Object.assign(new Error("injected link EIO"), { code: "EIO" });
    });
    expect(() => first.resources.finalize(initial.uploadId, undefined, "replay")).toThrow(/EIO/);
    link.mockRestore();
    reads.paths.length = 0;
    const replayed = first.resources.finalize(initial.uploadId, undefined, "replay");
    expect(partReads(first.store.paths.uploads).length).toBeGreaterThan(0);
    expect(
      first.resources.readModel({
        resourceId: replayed.resourceId,
        sha256: replayed.sha256,
        sizeBytes: replayed.sizeBytes,
      }),
    ).toEqual(body);

    const duplicate = first.resources.create(request, "dedup");
    await first.resources.write(duplicate.uploadId, chunks(body));
    reads.paths.length = 0;
    const again = first.resources.finalize(duplicate.uploadId, undefined, "dedup");
    expect(again.deduplicated).toBe(true);
    expect(reads.paths).toContain(first.blobs.filePath(again.sha256.slice(7)));

    const interrupted = first.resources.create(request, "recover");
    await first.resources.write(interrupted.uploadId, chunks(Buffer.from("other!!!")));
    vi.spyOn(first.blobs, "publishLink").mockImplementation(() => {
      throw Object.assign(new Error("injected link EIO"), { code: "EIO" });
    });
    expect(() => first.resources.finalize(interrupted.uploadId, undefined, "recover")).toThrow(
      /EIO/,
    );
    await first.close();
    const second = await open(path);
    reads.paths.length = 0;
    expect((await second.obligations.completeOpen()).failed).toEqual([]);
    expect(partReads(second.store.paths.uploads).length).toBeGreaterThan(0);
    expect(
      second.resources
        .readModel({
          resourceId: replayed.resourceId,
          sha256: replayed.sha256,
          sizeBytes: replayed.sizeBytes,
        })
        .toString(),
    ).toBe("testdata");
  });

  it("reads the part when the write-time digest was lost on restart", async () => {
    const path = root();
    const first = await open(path);
    const initial = first.resources.create(uploadRequest, "cold");
    await first.resources.write(initial.uploadId, chunks("test"));
    await first.close();
    const second = await open(path);
    reads.paths.length = 0;
    const receipt = second.resources.finalize(initial.uploadId, undefined, "cold");
    expect(partReads(second.store.paths.uploads)).toContain(
      join(second.store.paths.uploads, `${initial.uploadId}.part`),
    );
    expect(
      second.resources
        .readModel({
          resourceId: receipt.resourceId,
          sha256: receipt.sha256,
          sizeBytes: receipt.sizeBytes,
        })
        .toString(),
    ).toBe("test");
  });
});
