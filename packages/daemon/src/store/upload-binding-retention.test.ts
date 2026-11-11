import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as timers from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { hashJson } from "@claudexor/util";
import { payloadRef, putResourceInTx, readResourceRow } from "./resource-rows.js";
import { queryPlan } from "./retention.js";
import { RETENTION_AGE_REVISIT_MS } from "./retention-pages.js";
import {
  parseLegacyUploadBinding,
  UPLOAD_BINDING_RETENTION_MS,
  UPLOAD_BINDING_WINDOW_END_SQL,
  UPLOAD_BINDING_WINDOW_SQL,
  UploadBindings,
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
// The scan's yield, counted: one call per window it read.
vi.mock("node:timers/promises", async (original) => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setImmediate: vi.fn(actual.setImmediate) };
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
  // Reset, not clear: a one-off yield a test queued and did not use must not reach the next test.
  vi.mocked(timers.setImmediate).mockReset();
  for (const f of fixtures.splice(0)) await f.close();
  return () => {
    for (const path of ownedRoots) fs.rmSync(path, { recursive: true, force: true });
    clock = Date.parse("2026-10-10T10:00:00Z");
  };
});
/** A scan that reached the last key and deleted `removed` bindings. */
const finished = (removed: number) => ({ removed, interrupted: false });
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
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(0));
    f.resources.releaseModel(payloadRef(a));
    const released = clock;
    clock = released + UPLOAD_BINDING_RETENTION_MS - 1;
    expect(f.resources.create(uploadRequest, "create")).toEqual(first);
    expect(f.resources.finalize(first.uploadId, undefined, "finalize")).toEqual(a);
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(0));
    clock += 1;
    // The finished scan is not due again a millisecond later; a new scanner (a
    // restarted daemon's) is, and finds the lifetime over at exactly 30 days.
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(0));
    expect(await new UploadBindings(f.store).prune()).toEqual(finished(2));
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
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(2));
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
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(0));
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
    expect(await f.resources.pruneUploadBindings()).toEqual(finished(2));
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

describe("upload binding scan", () => {
  /** `count` finalized uploads (two bindings each), released at the current clock when asked. */
  async function uploads(f: ResourceFixture, count: number, release = false) {
    for (let i = 0; i < count; i += 1) {
      const upload = await uploaded(f, `create-${i}`);
      const resource = f.resources.finalize(upload.uploadId, undefined, `finalize-${i}`);
      if (release) f.resources.releaseModel(payloadRef(resource));
    }
  }
  const yields = () => vi.mocked(timers.setImmediate).mock.calls.length;
  /** The scan's next `after` yields pass; the one after them cancels it. */
  async function cancelAfter(turns: number): Promise<AbortSignal> {
    const stop = new AbortController();
    const actual =
      await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    const mock = vi.mocked(timers.setImmediate).mockClear();
    for (let i = 0; i < turns; i += 1) mock.mockImplementationOnce(actual.setImmediate);
    mock.mockImplementationOnce(((...args: Parameters<typeof actual.setImmediate>) => {
      stop.abort();
      return actual.setImmediate(...args);
    }) as typeof timers.setImmediate);
    return stop.signal;
  }

  it.each([3, 9])(
    "reads one window per turn whatever the store holds (%i uploads)",
    async (count) => {
      const f = await open();
      await uploads(f, count);
      vi.mocked(timers.setImmediate).mockClear();
      const order: string[] = [];
      setImmediate(() => order.push("another caller"));
      expect(
        await new UploadBindings(f.store).prune({ window: 4 }).then((scan) => {
          order.push("scan finished");
          return scan;
        }),
      ).toEqual(finished(0));
      // Two bindings per upload, four examined per synchronous read.
      expect(yields()).toBe(Math.ceil((count * 2) / 4));
      expect(order).toEqual(["another caller", "scan finished"]);
    },
  );

  it("both scan statements seek by key: no read grows with the store", async () => {
    const f = await open();
    // The window end reads the next rows of the primary key and nothing else.
    expect(queryPlan(f.store, UPLOAD_BINDING_WINDOW_END_SQL).join("\n")).toContain(
      "SEARCH idempotency USING PRIMARY KEY (owner=? AND pid=? AND key_digest>?)",
    );
    // The candidates stay inside (after, end] and reach upload and resource by id.
    const plan = queryPlan(f.store, UPLOAD_BINDING_WINDOW_SQL);
    expect(plan).toEqual(
      expect.arrayContaining([
        "SEARCH i USING PRIMARY KEY (owner=? AND pid=? AND key_digest>? AND key_digest<?)",
        expect.stringMatching(/^SEARCH u USING INDEX \S+ \(id=\?\)$/),
        expect.stringMatching(/^SEARCH r USING INDEX \S+ \(id=\?\)$/),
      ]),
    );
    expect(plan.filter((line) => line.startsWith("SCAN"))).toEqual([]);
  });

  it("a read returns one window's targets and a transaction settles one batch at most", async () => {
    const f = await open();
    await uploads(f, 6, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    // Every binding is eligible: the worst case for both bounds.
    const read: number[] = [];
    const prepare = f.store.prepare.bind(f.store);
    vi.spyOn(f.store, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sql !== UPLOAD_BINDING_WINDOW_SQL) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const result = (value as (...args: unknown[]) => unknown).apply(target, args);
            if (key === "all") read.push((result as unknown[]).length);
            return result;
          };
        },
      });
    });
    const left: number[] = [];
    const actual =
      await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    vi.mocked(timers.setImmediate)
      .mockClear()
      .mockImplementation(((...args: Parameters<typeof actual.setImmediate>) => {
        left.push(bindings(f));
        return actual.setImmediate(...args);
      }) as typeof timers.setImmediate);
    expect(await new UploadBindings(f.store).prune({ window: 4, batch: 2 })).toEqual(finished(12));
    vi.mocked(timers.setImmediate).mockImplementation(actual.setImmediate);
    // Four bindings per window hold at most four targets.
    expect(read.length).toBeGreaterThan(1);
    expect(Math.max(...read)).toBeLessThanOrEqual(4);
    // Between two yields at most one batch of two targets (four bindings) went.
    const steps = [12, ...left, 0].map((n, i, all) => (i ? all[i - 1]! - n : 0));
    expect(Math.max(...steps)).toBeLessThanOrEqual(4);
    expect(bindings(f)).toBe(0);
  });

  it("settles at most 100 targets in one transaction with the production options", async () => {
    const f = await open();
    await uploads(f, 101, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    const transaction = f.store.transaction.bind(f.store);
    const deleted: number[] = [];
    vi.spyOn(f.store, "transaction").mockImplementation(((body: () => unknown) => {
      const before = bindings(f);
      const result = transaction(body);
      deleted.push(before - bindings(f));
      return result;
    }) as never);
    expect(await new UploadBindings(f.store).prune()).toEqual(finished(202));
    // Two bindings per target: one full batch, then the rest.
    expect(deleted).toEqual([200, 2]);
  }, 60_000);

  it("a failed delete transaction rejects the scan, keeps what was settled and leaves the scan due", async () => {
    const f = await open();
    await uploads(f, 6, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    const scanner = new UploadBindings(f.store);
    const transaction = f.store.transaction.bind(f.store);
    let calls = 0;
    const failing = vi.spyOn(f.store, "transaction").mockImplementation(((body: () => unknown) => {
      if ((calls += 1) === 2) throw new Error("fixture: the second batch cannot commit");
      return transaction(body);
    }) as never);
    await expect(scanner.prune({ window: 4, batch: 2 })).rejects.toThrow();
    // The first batch of two targets stays deleted.
    expect(bindings(f)).toBe(8);
    failing.mockRestore();
    // Nothing was stamped as finished, so the same scanner scans again at once.
    expect(await scanner.prune({ window: 4, batch: 2 })).toEqual(finished(8));
    expect(bindings(f)).toBe(0);
  });

  it("deletes every expired target across windows and batches, and nothing else", async () => {
    const f = await open();
    await uploads(f, 5, true);
    const kept = await uploaded(f, "kept");
    const live = f.resources.finalize(kept.uploadId, undefined, "kept-finalize");
    clock += UPLOAD_BINDING_RETENTION_MS;
    expect(await new UploadBindings(f.store).prune({ window: 3, batch: 2 })).toEqual(finished(10));
    expect(bindings(f)).toBe(2);
    expect(f.resources.create(uploadRequest, "kept")).toEqual(kept);
    expect(f.resources.finalize(kept.uploadId, undefined, "kept-finalize")).toEqual(live);
  });

  it.each([
    // The yield after the first window: the next step would be a read.
    ["before its next read", 100],
    // The yield before the first batch: the next step would be a settle.
    ["before its next settle", 1],
  ])(
    "a scan cancelled %s stops there, says so and is not stamped as finished",
    async (_where, batch) => {
      const f = await open();
      await uploads(f, 6, true);
      clock += UPLOAD_BINDING_RETENTION_MS;
      const scanner = new UploadBindings(f.store);
      expect(await scanner.prune({ signal: await cancelAfter(0), window: 4, batch })).toEqual({
        removed: 0,
        interrupted: true,
      });
      // One window was read and nothing after it: no further read, no deletion.
      expect(yields()).toBe(1);
      expect(bindings(f)).toBe(12);
      // An interrupted scan is not a finished one: the next call scans at once, from the first key.
      expect(await scanner.prune({ window: 4, batch })).toEqual(finished(12));
      expect(bindings(f)).toBe(0);
    },
  );

  it("a cancelled scan keeps the batches it settled and leaves the rest to the next scan", async () => {
    const f = await open();
    await uploads(f, 6, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    const scanner = new UploadBindings(f.store);
    // One target (two bindings) per batch: two batches settle before the third yield cancels.
    expect(await scanner.prune({ signal: await cancelAfter(2), window: 4, batch: 1 })).toEqual({
      removed: 4,
      interrupted: true,
    });
    expect(bindings(f)).toBe(8);
    expect(await scanner.prune({ window: 4, batch: 1 })).toEqual(finished(8));
    expect(bindings(f)).toBe(0);
  });

  it("a scan whose signal is already aborted reads nothing and reports the interruption", async () => {
    const f = await open();
    await uploads(f, 2, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    const prepare = vi.spyOn(f.store, "prepare");
    expect(await new UploadBindings(f.store).prune({ signal: AbortSignal.abort() })).toEqual({
      removed: 0,
      interrupted: true,
    });
    expect(prepare.mock.calls.every(([sql]) => !sql.includes("idempotency"))).toBe(true);
    expect(bindings(f)).toBe(4);
  });

  it("confirms each target when its batch is deleted, not when its window was read", async () => {
    const f = await open();
    const upload = await uploaded(f, "revived");
    const resource = f.resources.finalize(upload.uploadId, undefined, "revived-finalize");
    f.resources.releaseModel(payloadRef(resource));
    await uploads(f, 2, true);
    clock += UPLOAD_BINDING_RETENTION_MS;
    const actual =
      await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    // Every window is read before the one batch settles; meanwhile one resource is live again.
    vi.mocked(timers.setImmediate)
      .mockClear()
      .mockImplementationOnce(((...args: Parameters<typeof actual.setImmediate>) => {
        f.store.transaction(() =>
          putResourceInTx(f.store, {
            resource,
            state: "ready",
            releasedAt: null,
            expiresAt: null,
          }),
        );
        return actual.setImmediate(...args);
      }) as typeof timers.setImmediate);
    expect(await new UploadBindings(f.store).prune({ batch: 100 })).toEqual(finished(4));
    expect(bindings(f)).toBe(2);
    expect(f.resources.create(uploadRequest, "revived")).toEqual(upload);
    expect(f.resources.finalize(upload.uploadId, undefined, "revived-finalize")).toEqual(resource);
  });

  it("does not repeat a finished scan before the age revisit, but scans when the clock moved back", async () => {
    const f = await open();
    await uploads(f, 3, true);
    await uploaded(f, "kept");
    const scanner = new UploadBindings(f.store);
    clock += UPLOAD_BINDING_RETENTION_MS;
    expect(await scanner.prune()).toEqual(finished(6));
    clock += RETENTION_AGE_REVISIT_MS - 1;
    vi.mocked(timers.setImmediate).mockClear();
    expect(await scanner.prune()).toEqual(finished(0));
    expect(yields()).toBe(0);
    // No scan is due, so a cancelled pass cut nothing short.
    expect(await scanner.prune({ signal: AbortSignal.abort() })).toEqual(finished(0));
    clock += 1;
    expect(await scanner.prune()).toEqual(finished(0));
    expect(yields()).toBe(1);
    // A clock set back proves no elapsed time: the scan runs instead of waiting for it to catch up.
    clock -= 24 * 60 * 60 * 1_000;
    vi.mocked(timers.setImmediate).mockClear();
    expect(await scanner.prune()).toEqual(finished(0));
    expect(yields()).toBe(1);
  });

  it("finds an expired resource that has no release time by its expiry", async () => {
    const f = await open();
    const upload = await uploaded(f);
    const resource = f.resources.finalize(upload.uploadId, undefined, "finalize");
    f.store.transaction(() =>
      putResourceInTx(f.store, {
        resource,
        state: "expired",
        releasedAt: null,
        expiresAt: new Date(clock).toISOString(),
      }),
    );
    clock += UPLOAD_BINDING_RETENTION_MS - 1;
    expect(await new UploadBindings(f.store).prune()).toEqual(finished(0));
    clock += 1;
    expect(await new UploadBindings(f.store).prune()).toEqual(finished(2));
    expect(bindings(f)).toBe(0);
  });

  it("leaves a binding younger than the lifetime to a later scan while lookup applies the lifetime", async () => {
    const path = root();
    const legacyRoot = join(path, "daemon", "resource-store");
    const old = new FrozenResourceStore(legacyRoot);
    const initial = old.create(uploadRequest, "old-create");
    await old.write(initial.uploadId, chunks("test"));
    const resource = old.finalize(initial.uploadId, undefined, "old-finalize");
    const f = await open(path);
    const released = clock;
    f.store.transaction(() =>
      putResourceInTx(f.store, {
        resource,
        state: "released",
        releasedAt: new Date(released).toISOString(),
        expiresAt: null,
      }),
    );
    legacyMarker(f, "present");
    // The historical receipt is adopted a day before its resource's lifetime ends.
    clock = released + UPLOAD_BINDING_RETENTION_MS - 24 * 60 * 60 * 1_000;
    expect(f.resources.finalize(initial.uploadId, undefined, "old-finalize")).toEqual(resource);
    expect(bindings(f)).toBe(1);
    clock = released + UPLOAD_BINDING_RETENTION_MS;
    expect(await new UploadBindings(f.store).prune()).toEqual(finished(0));
    expect(bindings(f)).toBe(1);
    // The read applies the exact lifetime and frees the row itself.
    expect(() => f.resources.finalize(initial.uploadId, undefined, "old-finalize")).toThrow(
      /no such upload/,
    );
    expect(bindings(f)).toBe(0);
  });
});
