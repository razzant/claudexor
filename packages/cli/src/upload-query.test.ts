import { createHash } from "node:crypto";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadQuery } from "./upload-query.js";
import { openDocumentSource } from "./local-document-source.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  connect: vi.fn(),
  descriptors: [] as number[],
  handles: [] as Array<{ fd: number }>,
  /** Runs once a real descriptor is open, before its opener sees it. */
  opened: vi.fn(),
}));
vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: mocks.connect }));
vi.mock("./live.js", () => ({ controlApiFetch: mocks.fetch }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      mocks.handles.push(handle);
      await mocks.opened();
      return handle;
    },
  };
});
vi.mock("./local-document-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-document-source.js")>();
  return {
    ...actual,
    async openDocumentSource(...args: Parameters<typeof actual.openDocumentSource>) {
      const source = await actual.openDocumentSource(...args);
      mocks.descriptors.push(source.fd);
      return source;
    },
  };
});
const roots: string[] = [];
function file(name = "note.txt", bytes = "document") {
  const root = mkdtempSync(join(tmpdir(), "ingress-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}
const status = (state = "open") => ({
  uploadId: "u",
  state,
  receivedBytes: state === "uploaded" ? 8 : 0,
  expectedBytes: 8,
});
afterEach(() => {
  for (const fd of mocks.descriptors.splice(0)) expect(() => fstatSync(fd)).toThrow();
  for (const handle of mocks.handles.splice(0)) expect(handle.fd).toBe(-1);
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function connect() {
  mocks.connect.mockResolvedValue({ addr: { baseUrl: "http://fixture", token: "t" } });
}

describe("thin upload translation and recovery", () => {
  it("recovers finalize by its original key/body after status absence", async () => {
    connect();
    const input = {
      uploadId: "u",
      idempotencyKey: "final-key",
      request: { expectedSha256: "sha256:saved" },
    };
    const resource = {
      resourceId: "r",
      kind: "file",
      mime: "text/plain",
      name: "note.txt",
      sizeBytes: 8,
      sha256: "sha256:saved",
      createdAt: "2026-10-26T00:00:00.000Z",
      deduplicated: false,
    };
    mocks.fetch
      .mockRejectedValueOnce(new Error("lost finalize"))
      .mockResolvedValueOnce(
        Response.json(
          { code: "upload_not_found", message: "gone", retryable: false },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(Response.json(resource));
    await expect(uploadQuery("finalize", input)).rejects.toThrow("lost finalize");
    await expect(uploadQuery("status", { uploadId: "u" })).rejects.toMatchObject({
      code: "upload_not_found",
    });
    expect(await uploadQuery("finalize", input)).toEqual(resource);
    expect(mocks.fetch.mock.calls[0]).toEqual(mocks.fetch.mock.calls[2]);
    expect(mocks.fetch.mock.calls.map((c) => c[2]?.method)).toEqual(["POST", "GET", "POST"]);
  });
  it("reports malformed successful protocol responses as typed operational failures", async () => {
    connect();
    mocks.fetch.mockResolvedValue(Response.json({ invalid: "status" }));
    await expect(uploadQuery("status", { uploadId: "u" })).rejects.toMatchObject({
      category: "operational",
      code: "invalid_response",
    });
  });
  it("retains upload identity on sensitive source refusal before any PUT", async () => {
    connect();
    const path = file(".env");
    mocks.fetch.mockResolvedValue(Response.json(status()));
    await expect(uploadQuery("import_local", { uploadId: "u", path })).rejects.toMatchObject({
      code: "sensitive_resource_rejected",
      context: { uploadId: "u" },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("forwards exact create/finalize keys and request bodies, including replay after lost responses", async () => {
    connect();
    const request = { kind: "file", mime: "text/plain", name: "note.txt", sizeBytes: 8 };
    mocks.fetch
      .mockRejectedValueOnce(new Error("lost create"))
      .mockResolvedValueOnce(Response.json(status()));
    await expect(uploadQuery("create", { request, idempotencyKey: "create-key" })).rejects.toThrow(
      "lost create",
    );
    expect(await uploadQuery("create", { request, idempotencyKey: "create-key" })).toEqual(
      status(),
    );
    expect(mocks.fetch.mock.calls[0]).toEqual(mocks.fetch.mock.calls[1]);
    expect(mocks.fetch.mock.calls[1]?.[2]).toMatchObject({
      headers: { "Idempotency-Key": "create-key" },
      body: JSON.stringify(request),
    });
    const finalize = {
      uploadId: "u",
      request: { expectedSha256: "sha256:saved" },
      idempotencyKey: "final-key",
    };
    mocks.fetch
      .mockRejectedValueOnce(new Error("lost finalize"))
      .mockRejectedValueOnce(new Error("lost again"));
    await expect(uploadQuery("finalize", finalize)).rejects.toThrow("lost finalize");
    await expect(uploadQuery("finalize", finalize)).rejects.toThrow("lost again");
    expect(mocks.fetch.mock.calls[2]).toEqual(mocks.fetch.mock.calls[3]);
    expect(mocks.fetch.mock.calls[3]?.[2]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "final-key" },
      body: JSON.stringify(finalize.request),
    });
    expect(mocks.fetch.mock.calls.some((call) => call[2]?.method === "DELETE")).toBe(false);
  });
  it("streams one PUT, returns digest, and recovers uploaded digest without a second PUT", async () => {
    connect();
    const path = file();
    const puts: Buffer[] = [];
    mocks.fetch.mockImplementation(async (_addr, _path, init) => {
      if (init?.method === "PUT") {
        for await (const chunk of init.body as ReadableStream<Uint8Array>)
          puts.push(Buffer.from(chunk));
        return Response.json(status("uploaded"));
      }
      return Response.json(status(puts.length ? "uploaded" : "open"));
    });
    const expectedSha256 = `sha256:${createHash("sha256").update("document").digest("hex")}`;
    expect(await uploadQuery("import_local", { uploadId: "u", path })).toEqual({
      ...status("uploaded"),
      expectedSha256,
    });
    expect(Buffer.concat(puts).toString()).toBe("document");
    expect(await uploadQuery("import_local", { uploadId: "u", path })).toEqual({
      ...status("uploaded"),
      expectedSha256,
    });
    expect(mocks.fetch.mock.calls.filter((c) => c[2]?.method === "PUT")).toHaveLength(1);
  });
  it("retains digest/upload identity after uncertain PUT, with no cancel or finalize", async () => {
    connect();
    const path = file();
    mocks.fetch
      .mockResolvedValueOnce(Response.json(status()))
      .mockImplementationOnce(async (_addr, _path, init) => {
        for await (const _chunk of init.body as ReadableStream<Uint8Array>) {
          /* drain upload */
        }
        throw new Error("lost PUT response");
      });
    await expect(uploadQuery("import_local", { uploadId: "u", path })).rejects.toMatchObject({
      context: { uploadId: "u", expectedSha256: expect.stringMatching(/^sha256:/) },
    });
    expect(mocks.fetch.mock.calls).toHaveLength(2);
  });
  it("closes an unconsumed source after an early typed PUT rejection", async () => {
    connect();
    const path = file();
    mocks.fetch.mockResolvedValueOnce(Response.json(status())).mockResolvedValueOnce(
      Response.json(
        {
          code: "upload_not_open",
          message: "upload already sealed",
          retryable: false,
          context: { state: "uploaded" },
        },
        { status: 409 },
      ),
    );
    await expect(uploadQuery("import_local", { uploadId: "u", path })).rejects.toMatchObject({
      code: "upload_not_open",
      context: { uploadId: "u", state: "uploaded" },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("forwards host cancellation, closes the source, and never cancels the upload implicitly", async () => {
    connect();
    const path = file();
    const abort = new AbortController();
    mocks.fetch
      .mockResolvedValueOnce(Response.json(status()))
      .mockImplementationOnce(async (_addr, _path, init) => {
        expect(init.signal).toBe(abort.signal);
        abort.abort();
        throw abort.signal.reason;
      });
    await expect(
      uploadQuery("import_local", { uploadId: "u", path }, false, abort.signal),
    ).rejects.toMatchObject({ context: { uploadId: "u" } });
    expect(mocks.fetch.mock.calls.map((c) => c[2]?.method)).toEqual([undefined, "PUT"]);
  });
  it("preserves a changed-source refusal through a wrapped fetch failure", async () => {
    connect();
    const path = file();
    mocks.fetch
      .mockResolvedValueOnce(Response.json(status()))
      .mockImplementationOnce(async (_addr, _path, init) => {
        try {
          for await (const _chunk of init.body as ReadableStream<Uint8Array>)
            writeFileSync(path, "mutated!");
        } catch (cause) {
          throw new TypeError("fetch failed", { cause });
        }
        throw new Error("source change must fail");
      });
    await expect(uploadQuery("import_local", { uploadId: "u", path })).rejects.toMatchObject({
      code: "attachment_source_changed",
      context: { uploadId: "u" },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds stream chunks and accepts a zero-byte regular file", async () => {
    for (const bytes of ["", "x".repeat(130_000)]) {
      const path = file("bounded.txt", bytes);
      const source = await openDocumentSource(path, bytes.length);
      let count = 0;
      try {
        for await (const chunk of source.chunks()) {
          expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
          count += chunk.byteLength;
        }
        expect(count).toBe(bytes.length);
        expect(source.expectedSha256).toBe(
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        );
      } finally {
        await source.close();
      }
    }
  });
  it.each(["uploading", "cancelled"])(
    "observes %s without touching source bytes",
    async (state) => {
      connect();
      mocks.fetch.mockResolvedValue(Response.json(status(state)));
      expect(await uploadQuery("import_local", { uploadId: "u", path: "/missing/file" })).toEqual(
        status(state),
      );
      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves typed protocol refusals and does not treat a status 404 as finalization failure", async () => {
    connect();
    mocks.fetch.mockResolvedValue(
      Response.json(
        { code: "upload_not_found", message: "gone", retryable: false, context: { uploadId: "u" } },
        { status: 404 },
      ),
    );
    await expect(uploadQuery("status", { uploadId: "u" })).rejects.toMatchObject({
      code: "upload_not_found",
      context: { uploadId: "u" },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects model-purpose input, non-absolute paths and belt access before connection", async () => {
    await expect(
      uploadQuery("create", {
        request: { kind: "file", mime: "text/plain", sizeBytes: 1, purpose: "model" },
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
    await expect(
      uploadQuery("import_local", { uploadId: "u", path: "relative.txt" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(uploadQuery("status", { uploadId: "u" }, true)).rejects.toMatchObject({
      code: "delegation_forbidden",
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

describe("explicit local document descriptor", () => {
  it("closes a descriptor when selection changes before open validation completes", async () => {
    const path = file();
    const dir = dirname(path);
    roots.push(`${dir}.old`);
    // Once the selected file is open, its path comes to name another file. Its directory
    // moves, so the open file itself is untouched: only the check after open sees it.
    mocks.opened.mockImplementationOnce(() => {
      renameSync(dir, `${dir}.old`);
      mkdirSync(dir);
      writeFileSync(path, "replaced");
    });
    await expect(openDocumentSource(path, 8)).rejects.toMatchObject({
      code: "attachment_source_changed",
    });
    expect(mocks.handles).toHaveLength(1);
    expect(mocks.handles[0]?.fd).toBe(-1);
  });
  it("rejects sensitive paths, directory and symlink inputs", async () => {
    const path = file();
    const root = join(path, "..");
    const link = join(root, "link.txt");
    symlinkSync(path, link);
    const dir = join(root, "dir");
    mkdirSync(dir);
    const sensitive = file(".env");
    for (const bad of [link, dir])
      await expect(openDocumentSource(bad, 8)).rejects.toThrow(/regular/);
    await expect(openDocumentSource(sensitive, 8)).rejects.toMatchObject({
      code: "sensitive_resource_rejected",
    });
    const store = join(root, ".aws");
    mkdirSync(store);
    writeFileSync(join(store, "data.txt"), "document");
    const alias = join(root, "ordinary");
    symlinkSync(store, alias);
    await expect(openDocumentSource(join(alias, "data.txt"), 8)).rejects.toMatchObject({
      code: "sensitive_resource_rejected",
    });
  });
  it("detects same-size replacement and in-place mutation, and closes its descriptor", async () => {
    for (const replace of [false, true]) {
      const path = file();
      const source = await openDocumentSource(path, 8);
      try {
        if (replace) renameSync(path, `${path}.old`);
        writeFileSync(path, "replaced");
        await expect(async () => {
          for await (const _ of source.chunks()) {
            /* drain */
          }
        }).rejects.toMatchObject({ code: "attachment_source_changed" });
      } finally {
        await source.close();
      }
      expect(() => fstatSync(source.fd)).toThrow();
    }
  });
});
