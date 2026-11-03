/** The one-call import over the REAL control API and SQL upload owner; only daemon discovery is faked. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { uploadQuery } from "./upload-query.js";
import { uploadServices } from "./upload-services.js";
import {
  resourceFixture,
  type ResourceFixture,
} from "../../daemon/src/store/test-support/resource-fixture.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), opened: [] as string[] }));
vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: mocks.connect }));
vi.mock("./local-document-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-document-source.js")>();
  return {
    ...actual,
    // Every source read is observable: replays must not appear here.
    openDocumentSource: (path: string, size: number) => {
      mocks.opened.push(path);
      return actual.openDocumentSource(path, size);
    },
  };
});

const cleanup: Array<() => Promise<void> | void> = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  // This test's removals, taken before its closes: a later test never runs them.
  const ownedRemovals = removals.splice(0).reverse();
  for (const step of cleanup.splice(0).reverse()) await step();
  return () => {
    for (const remove of ownedRemovals) remove();
    vi.restoreAllMocks();
    mocks.opened.length = 0;
  };
});

interface Daemon {
  f: ResourceFixture;
  base: string;
  storeId: string;
  stop(): Promise<void>;
}
async function daemon(root: string): Promise<Daemon> {
  const f = await resourceFixture(root);
  const server = new DaemonControlApiServer({
    token: "import-test",
    daemon: { enqueue: vi.fn(), status: vi.fn(), list: vi.fn(async () => []), cancel: vi.fn() },
    storeId: () => f.store.storeId,
    // The production service wiring over the real SQL resource store.
    services: uploadServices(() => f.resources),
  });
  const address = await server.start();
  const base = `http://${address.host}:${address.port}`;
  mocks.connect.mockResolvedValue({ addr: { baseUrl: base, token: "import-test" } });
  let stopping: Promise<void> | undefined;
  /** One close: a later caller gets its outcome, not a success it never saw (#376). */
  const stop = () =>
    (stopping ??= (async () => {
      await server.stop();
      await f.close();
    })());
  cleanup.push(stop);
  return { f, base, storeId: f.store.storeId!, stop };
}
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "cx-upload-import-"));
  removals.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function http(d: Daemon, path: string, init: RequestInit & { key?: string } = {}) {
  const response = await fetch(`${d.base}/v2${path}`, {
    ...init,
    headers: {
      authorization: "Bearer import-test",
      "x-claudexor-protocol-major": "3",
      ...(init.key ? { "idempotency-key": init.key } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
async function failure(work: Promise<unknown>) {
  const error = await work.then(
    () => {
      throw new Error("expected a typed failure");
    },
    (caught: unknown) => caught as { code?: string; retryable?: boolean; context?: any },
  );
  return error;
}
const resources = (d: Daemon) =>
  Number((d.f.store.prepare("SELECT count(*) AS n FROM resource").get() as { n: number }).n);

describe("one-call keyed local import", () => {
  it("returns the original resource after the source changed or vanished, before any source read", async () => {
    const dir = workspace();
    const d = await daemon(join(dir, "store"));
    const path = join(dir, "brief.txt");
    const bytes = Buffer.from("first edition\n");
    writeFileSync(path, bytes);
    const identity = await uploadQuery("store_identity", {});
    expect(identity).toMatchObject({ protocolMajor: 3, storeId: d.storeId });
    const args = { expectedStoreId: d.storeId, path, idempotencyKey: "brief-1" };
    const ready = await uploadQuery("import", args);
    expect(ready).toMatchObject({
      storeId: d.storeId,
      state: "ready",
      content: { sizeBytes: bytes.length, sha256: digest(bytes) },
      resource: { kind: "file", mime: "text/plain", name: "brief.txt", sha256: digest(bytes) },
    });
    expect(mocks.opened).toEqual([path, path]);
    mocks.opened.length = 0;
    writeFileSync(path, "second edition, other length\n");
    expect(await uploadQuery("import", args)).toEqual(ready);
    rmSync(path);
    expect(await uploadQuery("import", args)).toEqual(ready);
    expect(mocks.opened).toEqual([]);
    // Other arguments under the used key: typed conflict and no new effect.
    for (const changed of [{ name: "renamed.txt" }, { path: join(dir, "other.txt") }]) {
      expect(await failure(uploadQuery("import", { ...args, ...changed }))).toMatchObject({
        code: "idempotency_conflict",
      });
    }
    expect(resources(d)).toBe(1);
    expect(mocks.opened).toEqual([]);
    // A new edition is an explicit new key.
    writeFileSync(path, "second edition\n");
    const edition = await uploadQuery("import", { ...args, idempotencyKey: "brief-2" });
    const id = (value: Record<string, unknown>) =>
      (value.resource as { resourceId: string }).resourceId;
    expect(id(edition)).not.toBe(id(ready));
  });

  it("refuses another store before touching the file", async () => {
    const dir = workspace();
    const d = await daemon(join(dir, "store"));
    const path = join(dir, "brief.txt");
    writeFileSync(path, "bytes\n");
    const wrong = "00000000-0000-4000-8000-000000000000";
    expect(
      await failure(uploadQuery("import", { expectedStoreId: wrong, path, idempotencyKey: "k" })),
    ).toMatchObject({ code: "store_mismatch" });
    expect(mocks.opened).toEqual([]);
    expect(resources(d)).toBe(0);
    expect(await failure(uploadQuery("import", { path, idempotencyKey: "k" }))).toBeInstanceOf(
      Error,
    );
    expect(mocks.opened).toEqual([]);
  });

  it("completes accepted bytes after a lost response without the source", async () => {
    const dir = workspace();
    const d = await daemon(join(dir, "store"));
    const path = join(dir, "notes.md");
    const bytes = Buffer.from("# accepted\n");
    writeFileSync(path, bytes);
    const args = { expectedStoreId: d.storeId, path, idempotencyKey: "lost" };
    // The last replay never answers: the transfer was accepted, the response is lost.
    const realFetch = globalThis.fetch;
    let posts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/v2/uploads/imports") && ++posts === 3)
        throw new TypeError("fetch failed");
      return realFetch(input, init);
    });
    expect(await failure(uploadQuery("import", args))).toMatchObject({
      code: "upload_import_uncertain",
      retryable: true,
      context: { state: "open", content: { sha256: digest(bytes) } },
    });
    vi.mocked(globalThis.fetch).mockRestore();
    rmSync(path);
    mocks.opened.length = 0;
    const ready = await uploadQuery("import", args);
    expect(ready).toMatchObject({ state: "ready", resource: { sha256: digest(bytes) } });
    expect(mocks.opened).toEqual([]);
  });

  it("keeps an unfinished import honest when its source changed or vanished", async () => {
    const dir = workspace();
    const d = await daemon(join(dir, "store"));
    const path = join(dir, "draft.txt");
    const bytes = Buffer.from("declared bytes\n");
    writeFileSync(path, bytes);
    const body = {
      expectedStoreId: d.storeId,
      kind: "file",
      mime: "text/plain",
      name: "draft.txt",
      source: path,
      content: { sizeBytes: bytes.length, sha256: digest(bytes) },
    };
    // Another client bound the key and declared the content, then lost its bytes.
    const begun = await http(d, "/uploads/imports", {
      method: "POST",
      key: "draft",
      body: JSON.stringify(body),
    });
    expect(begun).toMatchObject({ status: 200, body: { state: "open" } });
    const args = { expectedStoreId: d.storeId, path, idempotencyKey: "draft" };
    writeFileSync(path, "changed bytes!!\n");
    expect(await failure(uploadQuery("import", args))).toMatchObject({
      code: "upload_import_source_changed",
      context: { uploadId: begun.body.uploadId, state: "open", content: body.content },
    });
    rmSync(path);
    expect(await failure(uploadQuery("import", args))).toMatchObject({
      code: "upload_import_source_unavailable",
      context: { uploadId: begun.body.uploadId, state: "open" },
    });
    expect(resources(d)).toBe(0);
    writeFileSync(path, bytes);
    expect(await uploadQuery("import", args)).toMatchObject({ state: "ready" });
  });

  it("replays across a daemon restart and completes a byte receipt left before the restart", async () => {
    const dir = workspace();
    const store = join(dir, "store");
    let d = await daemon(store);
    const path = join(dir, "kept.txt");
    const bytes = Buffer.from("kept across restart\n");
    writeFileSync(path, bytes);
    const done = { expectedStoreId: d.storeId, path, idempotencyKey: "done" };
    const ready = await uploadQuery("import", done);
    // An HTTP client got its PUT receipt, then the daemon stopped before its replay.
    const pendingBody = {
      expectedStoreId: d.storeId,
      kind: "file",
      mime: "text/plain",
      name: "kept.txt",
      content: { sizeBytes: bytes.length, sha256: digest(bytes) },
    };
    const begun = await http(d, "/uploads/imports", {
      method: "POST",
      key: "receipt",
      body: JSON.stringify(pendingBody),
    });
    const put = await http(d, `/uploads/${begun.body.uploadId}/bytes`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    expect(put).toMatchObject({ status: 200, body: { state: "uploaded" } });
    await d.stop();
    rmSync(path);
    d = await daemon(store);
    mocks.opened.length = 0;
    expect(await uploadQuery("import", done)).toEqual(ready);
    const recovered = await http(d, "/uploads/imports", {
      method: "POST",
      key: "receipt",
      body: JSON.stringify(pendingBody),
    });
    expect(recovered).toMatchObject({
      status: 200,
      body: { state: "ready", storeId: d.storeId, resource: { sha256: digest(bytes) } },
    });
    expect(mocks.opened).toEqual([]);
  });
});
