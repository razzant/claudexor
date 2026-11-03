import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashJson } from "@claudexor/util";
import { payloadRef, putResourceInTx, readResourceRow } from "./resource-rows.js";
import {
  parseLegacyUploadBinding,
  UPLOAD_BINDING_RETENTION_MS,
  uploadKeyDigest,
} from "./upload-binding-retention.js";
import { ResourceStore as FrozenResourceStore } from "./test-support/fixtures/legacy/daemon/resource-store.js";
import {
  chunks,
  resourceFixture,
  uploaded,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";
import { afterEachClosed } from "../../../cli/src/test-support/after-each-closed.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});
const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
let clock = Date.parse("2026-10-10T10:00:00Z");
function root() {
  const path = fs.mkdtempSync(join(tmpdir(), "cx-binding-retention-"));
  roots.push(path);
  return path;
}
async function open(path = root()) {
  const f = await resourceFixture(path, { now: () => new Date(clock) });
  fixtures.push(f);
  return f;
}
afterEachClosed(async () => {
  // This test's entries, taken before its closes: a later test never removes them.
  const ownedRoots = roots.splice(0);
  vi.mocked(fs.readdirSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  for (const f of fixtures.splice(0)) await f.close();
  return () => {
    for (const path of ownedRoots) fs.rmSync(path, { recursive: true, force: true });
    clock = Date.parse("2026-10-10T10:00:00Z");
  };
});
const bindings = (f: ResourceFixture) =>
  Number(
    (
      f.store.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='upload'").get() as {
        n: number;
      }
    ).n,
  );
function legacyMarker(f: ResourceFixture, value: string) {
  f.store.transaction(() =>
    f.store
      .prepare(
        "INSERT INTO meta(key,value) VALUES('legacy_idempotency_dir',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(value),
  );
}
/** The refusal names its operation, digest and reason, never the raw key. */
function refusal(
  operation: "create" | "finalize",
  key: string,
  reason: "read_failed" | "invalid",
  errno?: string,
) {
  const keyDigest = uploadKeyDigest(operation, key);
  return expect.objectContaining({
    code: "legacy_upload_binding_unavailable",
    status: 503,
    retryable: true,
    message: expect.not.stringContaining(key),
    context: { operation, keyDigest, reason, ...(errno ? { errno } : {}) },
    requiredActions: [
      expect.stringContaining(`resource-store/idempotency/${keyDigest}.json`),
      expect.stringContaining("same Idempotency-Key"),
    ],
  });
}

describe("upload binding retention and legacy point replay", () => {
  it("uses exactly sha256(operation NUL raw key) and validates legacy records without inventing fields", () => {
    expect(uploadKeyDigest("create", "key")).toBe(
      "b1349c0393c10640d69f9073d21f9ff22afc650b9430d4dcf9ba411f2f14c842",
    );
    expect(
      parseLegacyUploadBinding(
        {
          operation: "create",
          key: "k",
          requestDigest: "saved",
          result: { uploadId: "upl-1", state: "open", receivedBytes: 0, expectedBytes: 4 },
        },
        "create",
        "k",
      )?.requestDigest,
    ).toBe("saved");
    expect(
      parseLegacyUploadBinding(
        { operation: "finalize", key: "k", requestDigest: "saved", result: {} },
        "create",
        "k",
      ),
    ).toBeUndefined();
  });

  it("expires both keys at 30 days after release, keeps shared-byte and other upload lifetimes separate", async () => {
    const f = await open();
    const first = await uploaded(f);
    const a = f.resources.finalize(first.uploadId, undefined, "finalize");
    const second = await uploaded(f, "second");
    const b = f.resources.finalize(second.uploadId, undefined, "second-finalize");
    clock += 90 * 24 * 60 * 60 * 1_000;
    expect(f.resources.pruneUploadBindings()).toBe(0);
    f.resources.releaseModel(payloadRef(a));
    const released = clock;
    clock = released + UPLOAD_BINDING_RETENTION_MS - 1;
    expect(f.resources.create(uploadRequest, "create")).toEqual(first);
    expect(f.resources.finalize(first.uploadId, undefined, "finalize")).toEqual(a);
    expect(f.resources.pruneUploadBindings()).toBe(0);
    clock += 1;
    expect(f.resources.pruneUploadBindings()).toBe(2);
    expect(bindings(f)).toBe(2);
    expect(f.resources.readModel(payloadRef(b)).toString()).toBe("test");
    expect(f.resources.create(uploadRequest, "create").uploadId).not.toBe(first.uploadId);
    expect(() => f.resources.finalize(first.uploadId, undefined, "finalize")).toThrow(
      /no such upload/,
    );
    expect(readResourceRow(f.store, a.resourceId)?.releasedAt).toBe(
      new Date(released).toISOString(),
    );
  });

  it("honors known expiry timestamps, leaves unknown legacy release and cancelled uploads unexpired", async () => {
    const f = await open();
    const initial = await uploaded(f);
    const resource = f.resources.finalize(initial.uploadId, undefined, "f");
    f.resources.expireModel(payloadRef(resource), new Date(clock).toISOString());
    clock += UPLOAD_BINDING_RETENTION_MS;
    expect(f.resources.pruneUploadBindings()).toBe(2);
    const cancelled = f.resources.create(uploadRequest, "cancelled");
    f.resources.cancel(cancelled.uploadId);
    const second = await uploaded(f, "unknown");
    const other = f.resources.finalize(second.uploadId, undefined, "unknown-finalize");
    f.store.transaction(() =>
      putResourceInTx(f.store, {
        resource: other,
        state: "released",
        releasedAt: null,
        expiresAt: null,
      }),
    );
    clock += UPLOAD_BINDING_RETENTION_MS * 10;
    expect(f.resources.pruneUploadBindings()).toBe(0);
    expect(f.resources.create(uploadRequest, "cancelled")).toEqual(cancelled);
    expect(f.resources.finalize(second.uploadId, undefined, "unknown-finalize")).toEqual(other);
  });

  it("adopts only addressed legacy create/finalize JSON and never resurrects them after SQL cleanup", async () => {
    const path = root();
    const legacyRoot = join(path, "daemon", "resource-store");
    const old = new FrozenResourceStore(legacyRoot);
    const initial = old.create(uploadRequest, "old-create");
    await old.write(initial.uploadId, chunks("test"));
    const resource = old.finalize(initial.uploadId, undefined, "old-finalize");
    const originalCreate = fs.readFileSync(
      join(legacyRoot, "idempotency", `${uploadKeyDigest("create", "old-create")}.json`),
    );
    const f = await open(path);
    f.store.transaction(() =>
      putResourceInTx(f.store, { resource, state: "ready", releasedAt: null, expiresAt: null }),
    );
    legacyMarker(f, "present");
    const scan = vi
      .mocked(fs.readdirSync)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("no directory scans");
      });
    const reads = vi.mocked(fs.readFileSync).mockClear();
    expect(f.resources.create(uploadRequest, "old-create")).toEqual(initial);
    expect(f.resources.finalize(initial.uploadId, undefined, "old-finalize")).toEqual(resource);
    expect(bindings(f)).toBe(2);
    expect(scan).not.toHaveBeenCalled();
    expect(reads.mock.calls.map(([name]) => String(name))).toEqual([
      join(legacyRoot, "idempotency", `${uploadKeyDigest("create", "old-create")}.json`),
      join(legacyRoot, "idempotency", `${uploadKeyDigest("finalize", "old-finalize")}.json`),
    ]);
    f.resources.releaseModel(payloadRef(resource));
    clock += UPLOAD_BINDING_RETENTION_MS;
    expect(f.resources.pruneUploadBindings()).toBe(2);
    expect(() => f.resources.finalize(initial.uploadId, undefined, "old-finalize")).toThrow(
      /no such upload/,
    );
    expect(f.resources.create(uploadRequest, "old-create").uploadId).not.toBe(initial.uploadId);
    expect(
      fs.readFileSync(
        join(legacyRoot, "idempotency", `${uploadKeyDigest("create", "old-create")}.json`),
      ),
    ).toEqual(originalCreate);
    expect(scan).not.toHaveBeenCalled();
  });

  it("keeps pid0 bindings across global quarantine and disables legacy reads when marked absent", async () => {
    const f = await open();
    const initial = await uploaded(f);
    const resource = f.resources.finalize(initial.uploadId, undefined, "f");
    f.store.transaction(() => {
      f.store.prepare("UPDATE partition SET status='quarantined' WHERE name='global'").run();
      f.store.prepare("UPDATE meta SET value='999' WHERE key='global_pid'").run();
    });
    expect(f.resources.create(uploadRequest, "create")).toEqual(initial);
    expect(f.resources.finalize(initial.uploadId, undefined, "f")).toEqual(resource);
    legacyMarker(f, "absent");
    const reads = vi.mocked(fs.readFileSync).mockClear();
    f.resources.create(uploadRequest, "new");
    expect(reads).not.toHaveBeenCalled();
    legacyMarker(f, "present");
    const dir = join(f.store.paths.resourceStore, "idempotency");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, `${uploadKeyDigest("create", "conflict")}.json`),
      JSON.stringify({
        operation: "create",
        key: "conflict",
        requestDigest: hashJson({ ...uploadRequest, sizeBytes: 9 }),
        result: initial,
      }),
    );
    expect(() => f.resources.create(uploadRequest, "conflict")).toThrow(/idempotency key/);
    fs.writeFileSync(join(dir, `${uploadKeyDigest("finalize", "raw-bad-key")}.json`), "{invalid");
    expect(() => f.resources.finalize("unknown", undefined, "raw-bad-key")).toThrow(
      refusal("finalize", "raw-bad-key", "invalid"),
    );
  });

  it("refuses present invalid create keys without minting an upload and retries after repair", async () => {
    const f = await open();
    legacyMarker(f, "present");
    const dir = join(f.store.paths.resourceStore, "idempotency");
    fs.mkdirSync(dir, { recursive: true });
    const key = "raw-key-historical";
    const path = join(dir, `${uploadKeyDigest("create", key)}.json`);
    const record = {
      operation: "create",
      key,
      requestDigest: hashJson(uploadRequest),
      result: { uploadId: "upl-legacy", state: "open", receivedBytes: 0, expectedBytes: 4 },
    };
    const before = bindings(f);
    for (const body of [
      "{invalid",
      JSON.stringify({ ...record, key: "other" }),
      JSON.stringify({ ...record, result: {} }),
    ]) {
      fs.writeFileSync(path, body);
      expect(() => f.resources.create(uploadRequest, key)).toThrow(
        refusal("create", key, "invalid"),
      );
      expect(bindings(f)).toBe(before);
      expect(f.store.prepare("SELECT count(*) AS n FROM upload").get()).toEqual({ n: 0 });
    }
    fs.writeFileSync(path, JSON.stringify(record));
    expect(f.resources.create(uploadRequest, key).uploadId).toBe("upl-legacy");
    expect(bindings(f)).toBe(before + 1);
    // SQL is now authoritative; a corrupt legacy copy cannot overwrite the adopted receipt.
    fs.writeFileSync(path, "{invalid");
    expect(f.resources.create(uploadRequest, key).uploadId).toBe("upl-legacy");
  });

  it("treats only ENOENT as absence; a non-ENOENT read failure is retryable", async () => {
    const f = await open();
    legacyMarker(f, "present");
    const key = "read-failure";
    const path = join(
      f.store.paths.resourceStore,
      "idempotency",
      `${uploadKeyDigest("create", key)}.json`,
    );
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
      vi.mocked(fs.readFileSync).mockImplementation(((name: string, ...args: unknown[]) => {
        if (String(name) === path) throw Object.assign(new Error(`denied ${path}`), { code, path });
        return (actual.readFileSync as (...args: unknown[]) => unknown)(name, ...args);
      }) as typeof fs.readFileSync);
      expect(() => f.resources.create(uploadRequest, key)).toThrow(
        refusal("create", key, "read_failed", code),
      );
      // The native message and absolute path stay on the local cause only.
      expect(() => f.resources.create(uploadRequest, key)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining("denied"),
          cause: expect.objectContaining({ code }),
        }),
      );
      expect(() => f.resources.create(uploadRequest, key)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(f.store.paths.resourceStore),
        }),
      );
      expect(f.store.prepare("SELECT count(*) AS n FROM upload").get()).toEqual({ n: 0 });
    }
    vi.mocked(fs.readFileSync).mockImplementation(actual.readFileSync);
    // The missing file is a confirmed ENOENT, so a new command can now be admitted.
    expect(f.resources.create(uploadRequest, key).state).toBe("open");
  });
});
