import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { RETAINED_OUTPUT_PATH } from "@claudexor/event-log";
import { readArtifact, type ArtifactReadResult } from "./artifact-read.js";
import { handleArtifactServeRoute, type ArtifactServeContext } from "./artifact-serve-routes.js";

function text(result: ArtifactReadResult): string {
  expect(result.kind).toBe("body");
  if (result.kind !== "body") throw new Error("Expected artifact body");
  return Buffer.from(result.body).toString("utf8");
}

function response() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  });
}

describe("finite artifact bulk reads", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-artifact-read-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps list ordering, MIME, hidden git exclusion and both response envelopes", () => {
    mkdirSync(join(root, "sub"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "hidden"), "hidden");
    writeFileSync(join(root, "sub", "note.md"), "note");
    writeFileSync(join(root, "image.png"), new Uint8Array([0, 1, 2]));
    const artifacts = [
      { path: "image.png", kind: "file", bytes: 3, mime: "image/png" },
      { path: "sub", kind: "directory" },
      { path: "sub/note.md", kind: "file", bytes: 4, mime: "text/plain" },
    ];
    for (const owner of [
      { kind: "run", id: "r" },
      { kind: "project", id: "p" },
    ] as const) {
      const result = readArtifact({ kind: "list", root, owner });
      expect(JSON.parse(text(result))).toEqual({
        [owner.kind === "run" ? "runId" : "projectId"]: owner.id,
        artifacts,
      });
    }
    expect(
      JSON.parse(
        text(
          readArtifact({
            kind: "list",
            root: null,
            owner: { kind: "run", id: "none" },
          }),
        ),
      ),
    ).toEqual({ runId: "none", artifacts: [] });
  });

  it("serves credential-shaped text, patch, binary and `.env` artifacts exactly (INV-146)", () => {
    const secret = "sk-proj-" + "a".repeat(48);
    const source = `const token = '${secret}';\n`;
    writeFileSync(join(root, "note.ts"), source);
    expect(text(readArtifact({ kind: "fetch", root, relative: "note.ts" }))).toBe(source);
    for (const relative of ["patch.diff", ".env"]) {
      writeFileSync(join(root, relative), secret);
      expect(text(readArtifact({ kind: "fetch", root, relative }))).toBe(secret);
    }
    const bytes = new Uint8Array([0, ...Buffer.from(secret), 255]);
    writeFileSync(join(root, "binary.bin"), bytes);
    expect(readArtifact({ kind: "fetch", root, relative: "binary.bin" })).toMatchObject({
      kind: "body",
      contentType: "application/octet-stream",
      body: bytes,
    });
  });

  it("keeps existing preview caps but transfers the complete retained output", () => {
    const output = "x".repeat(4 * 1024 * 1024 + 1);
    mkdirSync(join(root, "final"));
    writeFileSync(join(root, "preview.txt"), output);
    writeFileSync(join(root, RETAINED_OUTPUT_PATH), output);
    expect(readArtifact({ kind: "fetch", root, relative: "preview.txt" })).toMatchObject({
      kind: "error",
      status: 413,
      body: { bytes: output.length },
    });
    const full = readArtifact({
      kind: "fetch",
      root,
      relative: RETAINED_OUTPUT_PATH,
      runArtifact: true,
    });
    expect(text(full)).toBe(output);
    expect(readArtifact({ kind: "fetch", root, relative: "../preview.txt" })).toMatchObject({
      kind: "error",
      status: 404,
    });
  });

  it("checks the current tombstone when a queued run artifact job actually executes", () => {
    const request = {
      kind: "list" as const,
      root,
      owner: { kind: "run" as const, id: "r" },
      runArtifact: true,
    };
    expect(readArtifact(request).kind).toBe("body");
    writeFileSync(
      join(root, "tombstone.yaml"),
      stringify({
        run_id: "r",
        deleted_at: "2026-10-27T00:00:00.000Z",
        reason: "retention",
      }),
    );
    expect(readArtifact(request)).toMatchObject({
      kind: "error",
      status: 410,
      body: { code: "run_expired_by_retention" },
    });
  });

  it("returns exclusively owned body bytes transferable without a retained-output copy", () => {
    writeFileSync(join(root, "small.txt"), "small response");
    writeFileSync(join(root, "large.txt"), "x".repeat(128 * 1024));
    for (const relative of ["small.txt", "large.txt"]) {
      const result = readArtifact({ kind: "fetch", root, relative });
      if (result.kind !== "body") throw new Error("Expected artifact body");
      const expected = text(result);
      expect(result.body.byteOffset).toBe(0);
      expect(result.body.byteLength).toBe(result.body.buffer.byteLength);
      const received = structuredClone(result, { transfer: [result.body.buffer as ArrayBuffer] });
      expect(result.body.byteLength).toBe(0);
      expect(text(received)).toBe(expected);
    }
  });
});

describe("artifact routes delegate bulk work", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cx-artifact-route-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function context(read: ArtifactServeContext["readArtifact"]): ArtifactServeContext {
    return {
      findRun: async () => ({
        id: "r",
        state: "succeeded",
        runDir: root,
        params: { scope: { kind: "project", root } },
      }),
      resolveProjectRoot: async () => root,
      readArtifact: read,
      json: vi.fn(),
    };
  }

  it.each([
    ["/runs/r/artifacts", "list", true, "run"],
    ["/runs/r/artifacts/note.md", "fetch", true, "run"],
    ["/runs/r/produced", "list", false, "run"],
    ["/runs/r/produced/note.md", "fetch", false, "run"],
    ["/projects/p/outputs", "list", false, "project"],
    ["/projects/p/outputs/note.md", "fetch", false, "project"],
  ] as const)("%s submits one plain addressed job", async (path, kind, runArtifact, owner) => {
    const body = Buffer.from("{}");
    const read = vi.fn<ArtifactServeContext["readArtifact"]>(async () => ({
      kind: "body",
      contentType: "application/json",
      body,
    }));
    const res = response();
    expect(
      await handleArtifactServeRoute(context(read), "GET", path, res as unknown as ServerResponse),
    ).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    const request = read.mock.calls[0]![0];
    expect(request).toMatchObject({ kind, root: runArtifact ? root : join(root, "artifacts") });
    expect(request.runArtifact ?? false).toBe(runArtifact);
    if (request.kind === "fetch") expect(request.relative).toBe("note.md");
    else expect(request.owner.kind).toBe(owner);
    expect(res.end).toHaveBeenCalledWith(body);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("cancels a queued read on disconnect and emits no late response", async () => {
    let entered!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const ctx = context(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          entered();
        }),
    );
    const res = response();
    const pending = handleArtifactServeRoute(
      ctx,
      "GET",
      "/runs/r/artifacts",
      res as unknown as ServerResponse,
    );
    await enqueued;
    res.destroyed = true;
    res.emit("close");
    expect(await pending).toBe(true);
    expect(aborted).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(ctx.json).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("preserves typed executor failures for the server's problem response", async () => {
    const failure = Object.assign(new Error("worker unavailable"), {
      status: 503,
      code: "bulk_worker_crashed",
    });
    const ctx = context(async () => {
      throw failure;
    });
    const res = response();
    await expect(
      handleArtifactServeRoute(ctx, "GET", "/runs/r/artifacts", res as unknown as ServerResponse),
    ).rejects.toBe(failure);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("never submits a job for a disconnected response at entry", async () => {
    const read = vi.fn<ArtifactServeContext["readArtifact"]>();
    const res = response();
    res.destroyed = true;
    expect(
      await handleArtifactServeRoute(
        context(read),
        "GET",
        "/runs/r/artifacts",
        res as unknown as ServerResponse,
      ),
    ).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
