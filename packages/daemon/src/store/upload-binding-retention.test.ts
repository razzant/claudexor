import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashJson } from "@claudexor/util";
import { payloadRef, putResourceInTx, readResourceRow } from "./resource-rows.js";
import {
  parseLegacyUploadBinding,
  UPLOAD_BINDING_RETENTION_MS,
  uploadKeyDigest,
} from "./upload-binding-retention.js";
import { ResourceStore as FrozenResourceStore } from "./test-support/legacy/daemon/resource-store.js";
import {
  chunks,
  resourceFixture,
  uploaded,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

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
afterEach(async () => {
  vi.mocked(fs.readdirSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  for (const f of fixtures.splice(0)) await f.close();
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
  clock = Date.parse("2026-10-10T10:00:00Z");
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
    fs.writeFileSync(join(dir, `${uploadKeyDigest("finalize", "bad")}.json`), "{invalid");
    expect(() => f.resources.finalize("unknown", undefined, "bad")).toThrow(/no such upload/);
  });
});
