import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { createAccountEvidence, createSqlDaemonServices, EngineStore } from "@claudexor/daemon";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { DurableJournal } from "../../daemon/src/store/test-support/fixtures/legacy/journal/index.js";
import { ResourceStore as FrozenResourceStore } from "../../daemon/src/store/test-support/fixtures/legacy/daemon/resource-store.js";
import { controlServices } from "./control-services.js";
import { openSqlStoreAfterTransport } from "./sql-startup-storage.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

// Deterministic native read failures; real chmod is bypassed by privileged users.
const faults = vi.hoisted(() => ({
  match: null as ((path: string) => boolean) | null,
  code: "EACCES",
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const readFileSync = (path: unknown, ...args: unknown[]) => {
    if (faults.match?.(String(path)))
      throw Object.assign(new Error(`sentinel native failure at ${String(path)}`), {
        code: faults.code,
        path: String(path),
      });
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...args);
  };
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(readFileSync as typeof actual.readFileSync),
  };
});

const TOKEN = "upload-binding-http";
const DAY = 24 * 60 * 60 * 1_000;
const dist = (name: string) => resolve(import.meta.dirname, "../../daemon/dist/store", name);
const request = {
  purpose: "model" as const,
  kind: "file" as const,
  mime: "application/json",
  name: "request.json",
  sizeBytes: 4,
};
const cleanups: Array<() => void | Promise<void>> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  faults.match = null;
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});
async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}
const digest = (operation: "create" | "finalize", key: string) =>
  createHash("sha256").update(`${operation}\0${key}`).digest("hex");
const keyFile = (root: string, operation: "create" | "finalize", key: string) =>
  join(root, "resource-store", "idempotency", `${digest(operation, key)}.json`);

/** A historical root migrated by the shipped import worker and publication. */
async function migratedRoot(seed: (legacy: FrozenResourceStore) => Promise<void>) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "upload-binding-http-")));
  removals.push(() => fs.rmSync(root, { recursive: true, force: true }));
  new DurableJournal({ rootDir: join(root, "journal"), partition: "global" }).close();
  await seed(new FrozenResourceStore(join(root, "resource-store")));
  const store = await openSqlStoreAfterTransport({
    daemonDir: root,
    advanceFloor: () => {},
    importWorkerEntry: dist("maintenance-worker.js"),
    flusherWorkerEntry: dist("flusher-worker.js"),
  });
  try {
    expect(
      store.prepare("SELECT value FROM meta WHERE key='legacy_idempotency_dir'").get(),
    ).toEqual({ value: "present" });
  } finally {
    await store.close();
  }
  return root;
}

/** Serve one restart of that root through the daemon's resource composition and HTTP. */
async function serve(root: string, now?: () => Date) {
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: dist("flusher-worker.js"),
    ...(now ? { now } : {}),
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [] });
  await graph.recoverAfterStartup();
  const services = controlServices(
    undefined as never,
    undefined as never,
    undefined as never,
    {} as never,
    undefined as never,
    undefined as never,
    undefined as never,
    () => graph.resources,
    undefined as never,
    createAccountEvidence(),
    () => [],
  );
  const server = new DaemonControlApiServer({ token: TOKEN, daemon: {} as never, services });
  const { host, port } = await server.start();
  let closing: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const close = () =>
    (closing ??= (async () => {
      await server.stop();
      await graph.close();
      await store.close();
    })());
  cleanups.push(close);
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${TOKEN}`,
      "X-Claudexor-Protocol-Major": String(CONTROL_PROTOCOL_MAJOR),
      ...(key ? { "Idempotency-Key": key } : {}),
    };
    let payload: string | Buffer | undefined;
    if (Buffer.isBuffer(body)) {
      headers["content-type"] = "application/octet-stream";
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetch(`http://${host}:${port}/v2${path}`, {
      method,
      headers,
      body: payload,
    });
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      text,
      body: (text ? JSON.parse(text) : undefined) as any,
    };
  };
  const count = (sql: string, ...args: string[]) =>
    Number((store.prepare(sql).get(...args) as { n: number }).n);
  const facts = () => ({
    uploads: count("SELECT count(*) AS n FROM upload"),
    resources: count("SELECT count(*) AS n FROM resource"),
    bindings: count("SELECT count(*) AS n FROM idempotency WHERE owner='upload'"),
    parts: fs
      .readdirSync(join(root, "resource-store", "uploads"))
      .filter((name) => name.endsWith(".part")).length,
  });
  const targetBindings = (uploadId: string) =>
    count("SELECT count(*) AS n FROM idempotency WHERE owner='upload' AND target_id=?", uploadId);
  return {
    store,
    graph,
    call,
    close,
    facts,
    targetBindings,
    create: (key: string, input: object = request) => call("POST", "/uploads", input, key),
    bytes: (id: string, value = "test") => call("PUT", `/uploads/${id}/bytes`, Buffer.from(value)),
    finalize: (id: string, key: string, body: object = {}) =>
      call("POST", `/uploads/${id}/finalize`, body, key),
  };
}
type Reply = Awaited<ReturnType<Awaited<ReturnType<typeof serve>>["call"]>>;

/** The refusal names a usable address without echoing the key, path, bytes or native text. */
function expectRefusal(
  reply: Reply,
  root: string,
  operation: "create" | "finalize",
  key: string,
  reason: "read_failed" | "invalid",
  errno?: string,
) {
  const keyDigest = digest(operation, key);
  const file = `resource-store/idempotency/${keyDigest}.json`;
  expect(reply.status).toBe(503);
  expect(reply.type).toContain("application/problem+json");
  expect(reply.body).toMatchObject({
    code: "legacy_upload_binding_unavailable",
    retryable: true,
  });
  expect(reply.body.context).toEqual({ operation, keyDigest, reason, ...(errno ? { errno } : {}) });
  expect(reply.body.message).toContain(keyDigest);
  expect(reply.body.message).toContain(file);
  expect(reply.body.message).toContain("same Idempotency-Key");
  expect(reply.body.requiredActions).toEqual([
    expect.stringContaining(file),
    expect.stringContaining("same Idempotency-Key"),
  ]);
  expect(reply.text).not.toMatch(/new key|fresh key|different key/i);
  for (const secret of [key, root, "sentinel"]) expect(reply.text).not.toContain(secret);
}

describe("legacy upload bindings through the daemon HTTP resource owner", () => {
  it("admits new keys on a migrated root through create, bytes and finalize with only addressed point reads", async () => {
    const root = await migratedRoot(async (legacy) => {
      const kept = legacy.create(request, "legacy-kept");
      await legacy.write(kept.uploadId, chunks("test"));
      legacy.finalize(kept.uploadId, undefined, "legacy-kept-finalize");
    });
    const dir = join(root, "resource-store", "idempotency");
    const before = new Map(
      fs.readdirSync(dir).map((name) => [name, fs.readFileSync(join(dir, name))]),
    );
    const s = await serve(root);
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.readdirSync).mockClear();
    const created = await s.create("fresh-create");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: "open", receivedBytes: 0, expectedBytes: 4 });
    const id = created.body.uploadId as string;
    const written = await s.bytes(id);
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({ uploadId: id, state: "uploaded", receivedBytes: 4 });
    const expectedSha256 = `sha256:${createHash("sha256").update("test").digest("hex")}`;
    const finalized = await s.finalize(id, "fresh-finalize", { expectedSha256 });
    expect(finalized.status).toBe(201);
    expect(finalized.body).toMatchObject({ sha256: expectedSha256, sizeBytes: 4 });
    // Exact replay is now an indexed SQL hit; it reads no historical file again.
    expect((await s.create("fresh-create")).body).toEqual(created.body);
    expect((await s.finalize(id, "fresh-finalize", { expectedSha256 })).body).toEqual(
      finalized.body,
    );
    const legacyReads = vi
      .mocked(fs.readFileSync)
      .mock.calls.map(([name]) => String(name))
      .filter((name) => name.startsWith(dir + sep));
    expect(legacyReads).toEqual([
      keyFile(root, "create", "fresh-create"),
      keyFile(root, "finalize", "fresh-finalize"),
    ]);
    expect(vi.mocked(fs.readdirSync).mock.calls.filter(([name]) => String(name) === dir)).toEqual(
      [],
    );
    expect(
      s.graph.resources
        .readModel({ resourceId: finalized.body.resourceId, sha256: expectedSha256, sizeBytes: 4 })
        .toString(),
    ).toBe("test");
    expect(
      new Map(fs.readdirSync(dir).map((name) => [name, fs.readFileSync(join(dir, name))])),
    ).toEqual(before);
  });

  it("replays valid historical receipts and refuses the same key for a different request", async () => {
    let created: unknown, opened: unknown, resource: unknown;
    const root = await migratedRoot(async (legacy) => {
      created = legacy.create(request, "legacy-create");
      await legacy.write((created as { uploadId: string }).uploadId, chunks("test"));
      resource = legacy.finalize(
        (created as { uploadId: string }).uploadId,
        undefined,
        "legacy-finalize",
      );
      opened = legacy.create(request, "legacy-open");
    });
    const s = await serve(root);
    const base = s.facts();
    const id = (created as { uploadId: string }).uploadId;
    expect(await s.create("legacy-create")).toMatchObject({ status: 201, body: created });
    expect(await s.finalize(id, "legacy-finalize")).toMatchObject({ status: 201, body: resource });
    const conflict = await s.create("legacy-open", { ...request, sizeBytes: 9 });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
    expect(await s.create("legacy-open")).toMatchObject({ status: 201, body: opened });
    // Three adopted keys; the finalize adoption keeps its published target for lifetime accounting.
    expect(s.facts()).toEqual({
      ...base,
      bindings: base.bindings + 3,
      uploads: base.uploads + 1,
    });
  });

  it.each(["raw-key-c0ffee", "model"])("refuses damaged %s keys", async (prefix) => {
    const key = `${prefix}-create`,
      finalizeKey = `${prefix}-finalize`;
    let created: unknown, resource: unknown;
    const root = await migratedRoot(async (legacy) => {
      created = legacy.create(request, key);
      await legacy.write((created as { uploadId: string }).uploadId, chunks("test"));
      resource = legacy.finalize(
        (created as { uploadId: string }).uploadId,
        undefined,
        finalizeKey,
      );
    });
    const id = (created as { uploadId: string }).uploadId;
    const createFile = keyFile(root, "create", key),
      finalizeFile = keyFile(root, "finalize", finalizeKey);
    const originalCreate = fs.readFileSync(createFile, "utf8"),
      originalFinalize = fs.readFileSync(finalizeFile, "utf8");
    const s = await serve(root);
    const base = s.facts();
    for (const body of [
      '{"operation":"create","sentinel-malformed',
      JSON.stringify({ ...JSON.parse(originalCreate), key: "identity-sentinel" }),
      JSON.stringify({ ...JSON.parse(originalCreate), result: { schema: "sentinel" } }),
    ]) {
      fs.writeFileSync(createFile, body);
      expectRefusal(await s.create(key), root, "create", key, "invalid");
      expect(s.facts()).toEqual(base);
      expect(fs.readFileSync(createFile, "utf8")).toBe(body);
    }
    fs.writeFileSync(createFile, originalCreate);
    for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
      faults.code = code;
      faults.match = (path) => path === createFile;
      expectRefusal(await s.create(key), root, "create", key, "read_failed", code);
      expect(s.facts()).toEqual(base);
    }
    faults.match = null;
    fs.writeFileSync(finalizeFile, "{sentinel");
    expectRefusal(await s.finalize(id, finalizeKey), root, "finalize", finalizeKey, "invalid");
    expect(s.facts()).toEqual(base);
    // Repair is restoring the original record; the same keys then replay their receipts.
    fs.writeFileSync(finalizeFile, originalFinalize);
    expect(await s.create(key)).toMatchObject({ status: 201, body: created });
    expect(await s.finalize(id, finalizeKey)).toMatchObject({ status: 201, body: resource });
    const adopted = s.facts();
    expect(adopted).toEqual({ ...base, bindings: base.bindings + 2, uploads: base.uploads + 1 });
    // SQL is authoritative once adopted; a later damaged copy cannot veto it.
    fs.writeFileSync(createFile, "{sentinel");
    fs.writeFileSync(finalizeFile, "{sentinel");
    expect(await s.create(key)).toMatchObject({ status: 201, body: created });
    expect(await s.finalize(id, finalizeKey)).toMatchObject({ status: 201, body: resource });
    expect(s.facts()).toEqual(adopted);
  });

  it("refuses every SQL miss, including fresh keys, while the historical directory is unreadable", async () => {
    let adopted: unknown;
    const root = await migratedRoot(async (legacy) => {
      adopted = legacy.create(request, "legacy-adopted");
    });
    const s = await serve(root);
    expect(await s.create("legacy-adopted")).toMatchObject({ status: 201, body: adopted });
    const native = await s.create("sql-native");
    const id = native.body.uploadId as string;
    expect((await s.bytes(id)).status).toBe(200);
    const base = s.facts();
    const dir = join(root, "resource-store", "idempotency");
    for (const code of ["EACCES", "ENOTDIR", "EIO"]) {
      faults.code = code;
      faults.match = (path) => path.startsWith(dir + sep);
      // Purpose=model and daemon-looking key names remain ordinary caller replay.
      for (const fresh of [`fresh-a-${code}`, `model-create-${code}`])
        expectRefusal(await s.create(fresh), root, "create", fresh, "read_failed", code);
      for (const finalizeKey of [`fresh-finalize-${code}`, `model-finalize-${code}`])
        expectRefusal(
          await s.finalize(id, finalizeKey),
          root,
          "finalize",
          finalizeKey,
          "read_failed",
          code,
        );
      expect(await s.create("legacy-adopted")).toMatchObject({ status: 201, body: adopted });
      expect(await s.create("sql-native")).toMatchObject({ status: 201, body: native.body });
      expect(s.facts()).toEqual(base);
      expect((await s.call("GET", `/uploads/${id}`)).body).toMatchObject({ state: "uploaded" });
    }
    faults.match = null;
    const finalized = await s.finalize(id, "fresh-finalize-EIO");
    expect(finalized.status).toBe(201);
    expect(finalized.body.sizeBytes).toBe(4);
    expect(await s.create("fresh-a-EIO")).toMatchObject({ status: 201, body: { state: "open" } });
  });

  it("deletes known-expired SQL bindings before refusing a damaged copy; repair decides expiry, not replay", async () => {
    let created: unknown, resource: unknown;
    const root = await migratedRoot(async (legacy) => {
      created = legacy.create(request, "life-create");
      await legacy.write((created as { uploadId: string }).uploadId, chunks("test"));
      resource = legacy.finalize(
        (created as { uploadId: string }).uploadId,
        undefined,
        "life-finalize",
      );
    });
    const id = (created as { uploadId: string }).uploadId;
    let clock = Date.parse("2026-10-10T10:00:00Z");
    const now = () => new Date(clock);
    let s = await serve(root, now);
    expect(await s.create("life-create")).toMatchObject({ status: 201, body: created });
    expect(await s.finalize(id, "life-finalize")).toMatchObject({ status: 201, body: resource });
    expect(s.targetBindings(id)).toBe(2);
    const { resourceId, sha256, sizeBytes } = resource as {
      resourceId: string;
      sha256: string;
      sizeBytes: number;
    };
    s.graph.resources.releaseModel({ resourceId, sha256, sizeBytes });
    const released = clock;
    const createFile = keyFile(root, "create", "life-create"),
      finalizeFile = keyFile(root, "finalize", "life-finalize");
    const originalCreate = fs.readFileSync(createFile),
      originalFinalize = fs.readFileSync(finalizeFile);
    fs.writeFileSync(createFile, "{sentinel");
    fs.writeFileSync(finalizeFile, "{sentinel");
    clock = released + 30 * DAY - 1;
    expect(await s.create("life-create")).toMatchObject({ status: 201, body: created });
    expect(await s.finalize(id, "life-finalize")).toMatchObject({ status: 201, body: resource });
    clock = released + 30 * DAY;
    const base = s.facts();
    expectRefusal(await s.create("life-create"), root, "create", "life-create", "invalid");
    // Not zero writes: the expired target's SQL bindings were already removed.
    expect(s.targetBindings(id)).toBe(0);
    expect(s.facts()).toEqual({ ...base, bindings: base.bindings - 2 });
    expectRefusal(
      await s.finalize(id, "life-finalize"),
      root,
      "finalize",
      "life-finalize",
      "invalid",
    );
    await s.close();
    s = await serve(root, now);
    expectRefusal(await s.create("life-create"), root, "create", "life-create", "invalid");
    expect(s.targetBindings(id)).toBe(0);
    // Repair makes the known release decidable again: key reuse, not the expired receipt.
    fs.writeFileSync(createFile, originalCreate);
    fs.writeFileSync(finalizeFile, originalFinalize);
    const reused = await s.create("life-create");
    expect(reused.status).toBe(201);
    expect(reused.body.uploadId).not.toBe(id);
    expect(reused.body.state).toBe("open");
    const old = await s.finalize(id, "life-finalize");
    expect(old.status).toBe(404);
    expect(old.body.code).toBe("upload_not_found");
    expect(fs.readFileSync(createFile)).toEqual(originalCreate);
    expect(fs.readFileSync(finalizeFile)).toEqual(originalFinalize);
  });
});
