import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { payloadRef, readResourceRow, readUploadRow } from "./resource-rows.js";
import { MaintenanceController } from "./maintenance.js";
import {
  builtWorker,
  resourceFixture,
  uploaded,
  uploadRequest,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
const controllers: MaintenanceController[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), "cx-finalize-contract-"));
  roots.push(path);
  return path;
}
async function open(path = root(), clear = true) {
  const f = await resourceFixture(path, { manualTick: true, clear });
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const controller of controllers.splice(0)) await controller.stop();
  for (const f of fixtures.splice(0)) await f.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const count = (f: ResourceFixture, table: string) =>
  Number((f.store.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
const eio = () => Object.assign(new Error("injected link EIO"), { code: "EIO" });

describe("SQL finalize transaction and recovery contract", () => {
  it("retired pending publication settles its obligation without resurrecting a blob", async () => {
    const f = await open();
    const initial = await uploaded(f);
    const link = vi.spyOn(f.blobs, "publishLink").mockImplementation(() => {
      throw eio();
    });
    expect(() => f.resources.finalize(initial.uploadId, undefined, "retired")).toThrow(/EIO/);
    const receipt = readUploadRow(f.store, initial.uploadId)!.finalization!.result;
    f.resources.releaseModel(payloadRef(receipt));
    link.mockRestore();
    expect(f.resources.finalize(initial.uploadId, undefined, "retired")).toEqual(receipt);
    expect(f.obligations.open()[0]?.state).toBe("materialized");
    await f.tick();
    await f.tick();
    await f.resources.drainCleanup();
    expect(f.obligations.open()).toEqual([]);
    expect(existsSync(f.blobs.filePath(receipt.sha256.slice(7)))).toBe(false);
    expect(existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(false);
  });

  it.each([
    ["upload", "UPDATE", "NEW.state='finalizing'"],
    ["resource", "INSERT", "1"],
    ["idempotency", "INSERT", "NEW.operation='finalize'"],
    ["effect_obligation", "INSERT", "1"],
  ])(
    "rolls back tx1 failure at %s without publishing owners or allocating a binding",
    async (table, operation, when) => {
      const f = await open();
      const initial = await uploaded(f);
      const generation = f.store.owners.generationOf(`upload:${initial.uploadId}`);
      f.store
        .prepare(
          `CREATE TEMP TRIGGER fail_finalize BEFORE ${operation} ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT,'tx1 failure'); END`,
        )
        .run();
      expect(() => f.resources.finalize(initial.uploadId, undefined, "finalize")).toThrow(
        /tx1 failure/,
      );
      expect(count(f, "resource")).toBe(0);
      expect(count(f, "idempotency")).toBe(1);
      expect(count(f, "effect_obligation")).toBe(0);
      expect(readUploadRow(f.store, initial.uploadId)).toMatchObject({
        state: "uploaded",
        finalizeSha: null,
      });
      expect(f.store.owners.generationOf(`upload:${initial.uploadId}`)).toBe(generation);
      f.store.prepare("DROP TRIGGER fail_finalize").run();
      expect(f.resources.finalize(initial.uploadId, undefined, "finalize").sizeBytes).toBe(4);
    },
  );

  it("T-FIN-6: exact same-process retry continues link/tx2; repeated EIO never returns the saved result", async () => {
    const f = await open();
    const initial = await uploaded(f);
    const link = vi.spyOn(f.blobs, "publishLink").mockImplementation(() => {
      throw eio();
    });
    for (let i = 0; i < 2; i++)
      expect(() => f.resources.finalize(initial.uploadId, undefined, "finalize")).toThrow(/EIO/);
    const pending = readUploadRow(f.store, initial.uploadId)!;
    expect(pending.state).toBe("finalizing");
    expect(f.obligations.open()[0]?.state).toBe("pending");
    expect(readResourceRow(f.store, pending.resourceId!)?.state).toBe("publishing");
    expect(() => f.resources.finalize(initial.uploadId, undefined, "different-key")).toThrow(
      /idempotency key/,
    );
    expect(() => f.resources.cancel(initial.uploadId)).toThrow(/finalization has already started/);
    link.mockRestore();
    expect(f.resources.finalize(initial.uploadId, undefined, "finalize")).toEqual(
      pending.finalization!.result,
    );
    expect(f.resources.readModel(payloadRef(pending.finalization!.result)).toString()).toBe("test");
    expect(count(f, "resource")).toBe(1);
    expect(count(f, "idempotency")).toBe(2);
    expect(f.obligations.open()[0]?.state).toBe("materialized");
    expect(existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(true);
    await f.tick();
    await f.resources.drainCleanup();
    expect(f.obligations.open()).toEqual([]);
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBeNull();
    expect(existsSync(join(f.store.paths.uploads, `${initial.uploadId}.part`))).toBe(false);
  });

  it.each(["before-tx1", "after-tx1", "after-link", "after-tx2"])(
    "T-FIN-1..4: reopen at %s retains exact receipt and recovers publication",
    async (phase) => {
      const path = root();
      const first = await open(path);
      const initial = await uploaded(first);
      if (phase === "after-tx1")
        vi.spyOn(first.blobs, "publishLink").mockImplementation(() => {
          throw eio();
        });
      if (phase === "after-link")
        first.store
          .prepare(
            "CREATE TEMP TRIGGER fail_tx2 BEFORE UPDATE ON resource WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'tx2 failure'); END",
          )
          .run();
      if (phase !== "before-tx1") {
        if (phase === "after-tx2")
          first.resources.finalize(initial.uploadId, undefined, "finalize");
        else
          expect(() => first.resources.finalize(initial.uploadId, undefined, "finalize")).toThrow();
      }
      const saved = readUploadRow(first.store, initial.uploadId)?.finalization?.result;
      expect(existsSync(join(first.store.paths.uploads, `${initial.uploadId}.part`))).toBe(true);
      await first.close();
      const second = await open(path);
      const recovery = await second.obligations.completeOpen();
      expect(recovery.failed).toEqual([]);
      const receipt = second.resources.finalize(initial.uploadId, undefined, "finalize");
      if (saved) expect(receipt).toEqual(saved);
      expect(second.resources.create(uploadRequest, "create")).toEqual(initial);
      expect(second.resources.readModel(payloadRef(receipt)).toString()).toBe("test");
      expect(count(second, "resource")).toBe(1);
      await second.tick();
      await second.resources.drainCleanup();
      expect(second.obligations.open()).toEqual([]);
      expect(statSync(second.blobs.filePath(receipt.sha256.slice(7))).nlink).toBe(1);
      expect(() => second.resources.status(initial.uploadId)).toThrow(/no such upload/);
    },
  );

  it("reopens between recovery tx2 and materialization without accepting a historical generation", async () => {
    const path = root();
    const first = await open(path);
    const initial = await uploaded(first);
    first.resources.finalize(initial.uploadId, undefined, "finalize");
    await first.close();
    const second = await open(path);
    vi.spyOn(second.obligations, "materialize").mockImplementation(() => {
      throw new Error("recovery materialize interrupted");
    });
    const report = await second.obligations.completeOpen();
    expect(report.failed).toHaveLength(1);
    expect(second.obligations.open()[0]).toMatchObject({
      state: "pending",
      materializedGeneration: null,
    });
    expect(readUploadRow(second.store, initial.uploadId)?.state).toBe("published");
    await second.tick();
    expect(second.obligations.open()).toHaveLength(1);
    await second.close();
    const third = await open(path);
    expect((await third.obligations.completeOpen()).failed).toEqual([]);
    const receipt = third.resources.finalize(initial.uploadId, undefined, "finalize");
    expect(third.resources.readModel(payloadRef(receipt)).toString()).toBe("test");
    expect(count(third, "resource")).toBe(1);
    await third.tick();
    await third.resources.drainCleanup();
    expect(third.obligations.open()).toEqual([]);
  });

  it("T-FIN-5: sweep repairs crash after clear before upload-reference cleanup and part unlink", async () => {
    const f = await open(root(), false);
    const initial = await uploaded(f);
    const receipt = f.resources.finalize(initial.uploadId, undefined, "finalize");
    const blob = f.blobs.filePath(receipt.sha256.slice(7));
    await f.tick();
    expect(f.obligations.open()).toEqual([]);
    expect(statSync(blob).nlink).toBe(2);
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBe(receipt.sha256.slice(7));
    const sweep = new MaintenanceController(f.store, {
      blobs: f.blobs,
      processStartedAt: Date.now() + 1_000,
      workerEntry: builtWorker("maintenance-worker.js"),
    });
    controllers.push(sweep);
    const result = await sweep.sweepOrphans();
    expect(result.removedParts).toEqual([join(f.store.paths.uploads, `${initial.uploadId}.part`)]);
    expect(statSync(blob).nlink).toBe(1);
    expect(readUploadRow(f.store, initial.uploadId)?.finalizeSha).toBeNull();
    expect(f.resources.readModel(payloadRef(receipt)).toString()).toBe("test");
  });

  it("released receipts replay without relinking or new resource allocation", async () => {
    const f = await open();
    const initial = await uploaded(f);
    const receipt = f.resources.finalize(initial.uploadId, undefined, "finalize");
    await f.tick();
    f.resources.releaseModel(payloadRef(receipt));
    await f.tick();
    await f.resources.drainCleanup();
    const link = vi.spyOn(f.blobs, "publishLink");
    expect(f.resources.finalize(initial.uploadId, undefined, "finalize")).toEqual(receipt);
    expect(link).not.toHaveBeenCalled();
    expect(count(f, "resource")).toBe(1);
    expect(existsSync(f.blobs.filePath(receipt.sha256.slice(7)))).toBe(false);
    expect(f.resources.create(uploadRequest, "create")).toEqual(initial);
  });
});
