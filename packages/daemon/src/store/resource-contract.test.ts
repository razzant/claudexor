import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceStorePort } from "../store-contracts.js";
import { ResourceStore as FrozenResourceStore } from "./test-support/fixtures/legacy/daemon/resource-store.js";
import {
  chunks,
  resourceFixture,
  uploaded,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";
import { readUploadRow, putResourceInTx, putUploadInTx, readResourceRow } from "./resource-rows.js";
import type { SqlWriteContext } from "./mutation.js";
import { lookupIdempotency } from "./idempotency.js";
import { uploadKeyDigest } from "./upload-binding-retention.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    writeSync: vi.fn(actual.writeSync),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const ids = vi.hoisted(() => ({ counters: new Map<string, number>() }));
vi.mock("@claudexor/util", async (original) => ({
  ...(await original<object>()),
  newId: (prefix: string) => {
    const count = (ids.counters.get(prefix) ?? 0) + 1;
    ids.counters.set(prefix, count);
    return `${prefix}_fixture_${count}`;
  },
}));
vi.mock("./test-support/fixtures/legacy/util/index.js", async (original) => ({
  ...(await original<object>()),
  newId: (prefix: string) => {
    const count = (ids.counters.get(prefix) ?? 0) + 1;
    ids.counters.set(prefix, count);
    return `${prefix}_fixture_${count}`;
  },
}));
const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
function root() {
  const path = fs.mkdtempSync(join(tmpdir(), "cx-resource-contract-"));
  roots.push(path);
  return path;
}
async function fixture() {
  const f = await resourceFixture(root());
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(fs.readdirSync).mockReset();
  vi.mocked(fs.writeSync).mockReset();
  vi.mocked(fs.openSync).mockReset();
  vi.mocked(fs.closeSync).mockReset();
  for (const f of fixtures.splice(0)) await f.close();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});
function failure(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    const e = error as Error & { code?: string; status?: number };
    return { message: e.message, code: e.code, status: e.status };
  }
  throw new Error("expected refusal");
}

describe("SQL ResourceStore contract", () => {
  it.each([0, 70_000, 2_097_153])(
    "keeps all %i binary model bytes through upload, restart and read",
    async (size) => {
      const path = root();
      const first = await resourceFixture(path);
      fixtures.push(first);
      const bytes = Buffer.alloc(size);
      for (let i = 0; i < size; i++) bytes[i] = i % 251;
      const initial = first.resources.create(
        { ...uploadRequest, sizeBytes: size },
        `binary-${size}`,
      );
      await first.resources.write(
        initial.uploadId,
        chunks(bytes.subarray(0, 31), bytes.subarray(31)),
      );
      const receipt = first.resources.finalize(initial.uploadId, undefined, `binary-final-${size}`);
      await first.close();
      const second = await resourceFixture(path);
      fixtures.push(second);
      expect((await second.obligations.completeOpen()).failed).toEqual([]);
      expect(
        second.resources.readModel({
          resourceId: receipt.resourceId,
          sha256: receipt.sha256,
          sizeBytes: size,
        }),
      ).toEqual(bytes);
      expect(
        second.resources.finalize(initial.uploadId, undefined, `binary-final-${size}`),
      ).toEqual(receipt);
    },
  );

  it("maps file ENOSPC to store_full, closes descriptors and preserves the cancelled receipt", async () => {
    const f = await fixture();
    vi.mocked(fs.openSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    expect(() => f.resources.create(uploadRequest, "no-space")).toThrow(
      expect.objectContaining({ code: "store_full", status: 507 }),
    );
    expect(f.store.prepare("SELECT 1 FROM upload").get()).toBeUndefined();
    const initial = f.resources.create(uploadRequest, "stream-full");
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    const closed = vi.mocked(fs.closeSync).mockClear();
    await expect(f.resources.write(initial.uploadId, chunks("test"))).rejects.toMatchObject({
      code: "store_full",
      status: 507,
    });
    expect(closed).toHaveBeenCalledOnce();
    expect(f.resources.status(initial.uploadId)).toMatchObject({
      state: "cancelled",
      receivedBytes: 0,
    });
    await f.resources.drainCleanup();
    expect(fs.existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(false);
    // The successfully recovered ordinary upload still works after the failed write.
    const recovered = await uploaded(f, "recovered");
    expect(f.resources.finalize(recovered.uploadId, undefined, "recovered-final").sizeBytes).toBe(
      4,
    );
  });

  it("matches the frozen oracle's exact replies, replay conflicts, digest checks and public status", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    async function scenario(store: ResourceStorePort) {
      const request = { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 4 };
      const create = store.create(request, "create");
      await store.write(create.uploadId, chunks("te", "st"));
      const written = store.status(create.uploadId);
      const digestFailure = failure(() =>
        store.finalize(create.uploadId, `sha256:${"0".repeat(64)}`, "bad-sha"),
      );
      const resource = store.finalize(create.uploadId, undefined, "finalize");
      const attachments = store.resolve([{ resourceId: resource.resourceId }]).map((a) => ({
        ...a,
        path: basename(a.path),
        bytes: fs.readFileSync(a.path).toString("base64"),
      }));
      const second = store.create(request, "second");
      await store.write(second.uploadId, chunks("test"));
      const duplicate = store.finalize(second.uploadId, undefined, "duplicate");
      return {
        create,
        written,
        digestFailure,
        resource,
        attachments,
        duplicate,
        createReplay: store.create(request, "create"),
        finalizeReplay: store.finalize(create.uploadId, undefined, "finalize"),
        status: failure(() => store.status(create.uploadId)),
        createConflict: failure(() => store.create({ ...request, name: "other" }, "create")),
        finalizeConflict: failure(() => store.finalize("other", undefined, "finalize")),
      };
    }
    ids.counters.clear();
    const expected = await scenario(new FrozenResourceStore(root()));
    ids.counters.clear();
    const f = await fixture();
    const actual = await scenario(f.resources);
    expect(actual).toEqual(expected);
    expect(
      f.resources.create(
        { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 4 },
        "create",
      ),
    ).toEqual(expected.create);
  });

  it("retains model bytes exactly, enforces purpose/digest, shares blobs and releases metadata truthfully", async () => {
    const f = await fixture();
    const bytes = Buffer.from('{"secret":"sk-proj-' + "x".repeat(70) + '"}');
    const a = f.resources.publishModel(bytes);
    const b = f.resources.publishModel(bytes);
    expect(f.resources.readModel(a)).toEqual(bytes);
    expect(() => f.resources.resolve([{ resourceId: a.resourceId }])).toThrow(/purpose/);
    expect(() => f.resources.readModel({ ...a, sizeBytes: 1 })).toThrow(/does not match/);
    await f.tick();
    f.resources.releaseModel(a);
    await f.resources.drainCleanup();
    expect(() => f.resources.readModel(a)).toThrow(/no such resource/);
    expect(f.resources.readModel(b)).toEqual(bytes);
    expect(readResourceRow(f.store, a.resourceId)?.state).toBe("released");
    f.resources.releaseModel(b);
    await f.resources.drainCleanup();
    expect(fs.existsSync(f.blobs.filePath(a.sha256.slice(7)))).toBe(false);
    expect(f.resources.listModelResources()).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it("keeps sensitive names/content checks for attachments and rejects short or oversized streams", async () => {
    const f = await fixture();
    expect(() => f.resources.create({ ...uploadRequest, name: ".env" }, "sensitive-name")).toThrow(
      /sensitive/,
    );
    const bad = f.resources.create(uploadRequest, "short");
    await expect(f.resources.write(bad.uploadId, chunks("x"))).rejects.toMatchObject({
      code: "upload_size_mismatch",
    });
    expect(f.resources.status(bad.uploadId).state).toBe("cancelled");
    const big = f.resources.create(uploadRequest, "big");
    await expect(f.resources.write(big.uploadId, chunks("12345"))).rejects.toMatchObject({
      code: "upload_size_exceeded",
    });
    const text = "OPENAI_API_KEY=sk-proj-" + "a".repeat(70);
    const secret = f.resources.create(
      { kind: "file", mime: "text/plain", name: "x.txt", sizeBytes: text.length },
      "content",
    );
    await f.resources.write(secret.uploadId, chunks(text));
    expect(() => f.resources.finalize(secret.uploadId, undefined, "secret-finalize")).toThrow(
      /sensitive/,
    );
    await f.resources.drainCleanup();
    expect(f.resources.status(secret.uploadId).state).toBe("cancelled");
    expect(fs.existsSync(join(f.store.paths.uploads, `${secret.uploadId}.part`))).toBe(false);
  });

  it("commits chunk progress, observes cancellation during the stream and closes before protected unlink", async () => {
    const f = await fixture();
    const initial = f.resources.create(uploadRequest, "progress");
    async function* stream() {
      yield Buffer.from("te");
      expect(f.resources.status(initial.uploadId)).toMatchObject({
        state: "uploading",
        receivedBytes: 2,
      });
      expect(readUploadRow(f.store, initial.uploadId)?.status.receivedBytes).toBe(2);
      expect(f.resources.cancel(initial.uploadId).state).toBe("cancelled");
      expect(fs.existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(true);
      yield Buffer.from("st");
    }
    await expect(f.resources.write(initial.uploadId, stream())).rejects.toMatchObject({
      code: "upload_cancelled",
    });
    await f.resources.drainCleanup();
    expect(fs.existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(false);
    expect(f.resources.create(uploadRequest, "progress")).toEqual(initial);
    expect(readUploadRow(f.store, initial.uploadId)?.state).toBe("discarded");
  });

  it("uses pure import row reducers and never scans metadata directories on reads", async () => {
    const f = await fixture();
    const initial = await uploaded(f);
    const r = f.resources.finalize(initial.uploadId, undefined, "f");
    const rr = readResourceRow(f.store, r.resourceId)!;
    const ur = readUploadRow(f.store, initial.uploadId)!;
    const before = f.store.owners.generationOf(`blob:${r.sha256.slice(7)}`);
    const sql: SqlWriteContext = {
      prepare: f.store.prepare.bind(f.store),
      get inTransaction() {
        return f.store.inTransaction;
      },
    };
    f.store.transaction(() => {
      putResourceInTx(sql, rr);
      putUploadInTx(sql, ur);
    });
    expect(f.store.owners.generationOf(`blob:${r.sha256.slice(7)}`)).toBe(before);
    expect(() => putResourceInTx(sql, rr)).toThrow(/transaction/);
    const scan = vi
      .mocked(fs.readdirSync)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("directory scan forbidden");
      });
    expect(
      f.resources
        .readModel({ resourceId: r.resourceId, sha256: r.sha256, sizeBytes: r.sizeBytes })
        .toString(),
    ).toBe("test");
    expect(f.resources.listModelResources()).toHaveLength(1);
    expect(
      lookupIdempotency(
        f.store,
        { owner: "upload", pid: 0, keyDigest: uploadKeyDigest("create", "create") },
        (
          f.store
            .prepare("SELECT request_digest FROM idempotency WHERE operation='create'")
            .get() as { request_digest: string }
        ).request_digest,
      )?.result,
    ).toEqual(initial);
    expect(scan).not.toHaveBeenCalled();
  });
});
