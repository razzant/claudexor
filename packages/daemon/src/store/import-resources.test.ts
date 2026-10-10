import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashJson } from "@claudexor/util";
import { legacyOracle } from "./test-support/legacy-oracle.js";
import { runLegacyImport } from "./importer.js";
import { readResourceRow, readUploadRow } from "./resource-rows.js";
import { ImportContext } from "./import-context.js";
import { uploadKeyDigest } from "./upload-binding-retention.js";
import { prepareImportResources } from "./import-resources.js";

const reads = vi.hoisted(() => ({ forbidKeys: false, paths: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      reads.paths.push(String(args[0]));
      if (reads.forbidKeys && basename(String(args[0])) === "idempotency")
        throw new Error("full legacy key scan");
      return actual.readdirSync(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  reads.forbidKeys = false;
  reads.paths = [];
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});
async function* chunks(value: string) {
  yield Buffer.from(value);
}
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "cx-import-resource-")));
  roots.push(root);
  const resources = join(root, "resource-store"),
    journalRoot = join(root, "journal");
  fs.mkdirSync(journalRoot, { mode: 0o700 });
  const legacy = new legacyOracle.daemonResourceStore.ResourceStore(resources);
  return {
    root,
    resources,
    legacy,
    options: {
      databasePath: join(root, "engine.sqlite.import"),
      journalRoot,
      resourceStoreDir: resources,
      partitions: [],
    },
  };
}
function snapshot(root: string) {
  const out = new Map<string, string>();
  for (const dir of ["resources", "uploads", "blobs", "idempotency"])
    for (const name of fs.readdirSync(join(root, dir))) {
      const path = join(root, dir, name);
      out.set(path, createHash("sha256").update(fs.readFileSync(path)).digest("hex"));
    }
  return out;
}
function unchanged(before: Map<string, string>) {
  for (const [path, sha] of before)
    expect(createHash("sha256").update(fs.readFileSync(path)).digest("hex")).toBe(sha);
}

describe("legacy resource metadata import", () => {
  it("keeps exact frozen resource/upload metadata and bytes without scanning the lazy key directory", async () => {
    const f = fixture();
    const request = {
      purpose: "model",
      kind: "file",
      name: "fixture.json",
      mime: "application/json",
      sizeBytes: 4,
    };
    const first = f.legacy.create(request, "first");
    await f.legacy.write(first.uploadId, chunks("test"));
    const resource = f.legacy.finalize(first.uploadId, undefined, "finalize");
    const open = f.legacy.create(request, "open");
    const cancelled = f.legacy.create(request, "cancelled");
    f.legacy.cancel(cancelled.uploadId);
    const before = snapshot(f.resources);
    reads.forbidKeys = true;
    reads.paths = [];
    const receipt = await runLegacyImport(f.options);
    expect(receipt.resources).toEqual({
      resources: 1,
      uploads: 2,
      ignoredUploads: [],
      legacyIdempotency: "present",
    });
    expect(reads.paths.some((path) => basename(path) === "idempotency")).toBe(false);
    unchanged(before);
    const db = new DatabaseSync(f.options.databasePath);
    try {
      const sql = new ImportContext(db, join(f.resources, "blobs"));
      expect(readResourceRow(sql, resource.resourceId)?.resource).toEqual(resource);
      expect(readUploadRow(sql, open.uploadId)?.status).toEqual(open);
      expect(readUploadRow(sql, cancelled.uploadId)).toMatchObject({
        state: "discarded",
        status: { state: "cancelled" },
      });
      expect(
        db.prepare("SELECT count(*) AS n FROM idempotency WHERE owner='upload'").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
    expect((await runLegacyImport(f.options)).resources).toEqual(receipt.resources);
    unchanged(before);
  });

  it("carries pending finalize identity into one obligation and preserves an already released receipt", async () => {
    const f = fixture(),
      time = "2026-10-10T00:00:00.000Z";
    const request = {
      purpose: "model",
      kind: "file",
      name: "fixture.json",
      mime: "application/json",
      sizeBytes: 4,
    };
    const upload = f.legacy.create(request, "pending");
    await f.legacy.write(upload.uploadId, chunks("test"));
    const result = {
      resourceId: "resource-pending",
      ...request,
      sha256: `sha256:${createHash("sha256").update("test").digest("hex")}`,
      createdAt: time,
      deduplicated: false,
    };
    const requestDigest = hashJson({ uploadId: upload.uploadId, expectedSha256: null });
    const binding = { operation: "finalize", key: "final", requestDigest, result };
    const file = join(f.resources, "uploads", `${upload.uploadId}.json`);
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...original, finalization: binding }));
    const before = snapshot(f.resources);
    const first = await runLegacyImport(f.options);
    expect(first.resources.resources).toBe(1);
    unchanged(before);
    let db = new DatabaseSync(f.options.databasePath);
    try {
      const sql = new ImportContext(db, join(f.resources, "blobs"));
      expect(readUploadRow(sql, upload.uploadId)).toMatchObject({
        state: "finalizing",
        resourceId: result.resourceId,
        finalization: { keyDigest: uploadKeyDigest("finalize", "final"), requestDigest, result },
      });
      expect(readResourceRow(sql, result.resourceId)?.state).toBe("publishing");
      expect(db.prepare("SELECT state FROM effect_obligation").all()).toEqual([
        { state: "pending" },
      ]);
    } finally {
      db.close();
    }
    // Legacy finalize already returned and resource metadata was subsequently released.
    // Its exact key receipt survives; importing must not recreate resource bytes.
    fs.writeFileSync(
      join(f.resources, "idempotency", `${uploadKeyDigest("finalize", "final")}.json`),
      JSON.stringify(binding),
    );
    await runLegacyImport(f.options);
    db = new DatabaseSync(f.options.databasePath);
    try {
      const sql = new ImportContext(db, join(f.resources, "blobs"));
      expect(readUploadRow(sql, upload.uploadId)?.state).toBe("published");
      expect(readResourceRow(sql, result.resourceId)).toBeUndefined();
      expect(db.prepare("SELECT count(*) AS n FROM effect_obligation").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it("reports legacy-ignored upload files and Level 1 refuses metadata drift", async () => {
    const f = fixture();
    fs.writeFileSync(join(f.resources, "uploads", "bad.json"), "{");
    const receipt = await runLegacyImport(f.options);
    expect(receipt.resources.ignoredUploads).toEqual(["bad.json"]);
    const prepared = prepareImportResources(f.resources);
    fs.writeFileSync(join(f.resources, "uploads", "bad.json"), "changed");
    const db = new DatabaseSync(f.options.databasePath);
    try {
      expect(() => prepared.verify(new ImportContext(db, join(f.resources, "blobs")))).toThrow(
        expect.objectContaining({ code: "store_import_source_changed" }),
      );
    } finally {
      db.close();
    }
  });
});
