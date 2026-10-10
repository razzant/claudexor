import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MaintenanceController } from "./maintenance.js";
import { runMutation } from "./mutation.js";
import { putUploadInTx, readUploadRow, payloadRef } from "./resource-rows.js";
import { cleanupUploadPart } from "./uploads.js";
import {
  builtWorker,
  resourceFixture,
  uploaded,
  type ResourceFixture,
} from "./test-support/resource-fixture.js";

const roots: string[] = [];
const fixtures: ResourceFixture[] = [];
const controllers: MaintenanceController[] = [];
async function fixture(root?: string) {
  const path = root ?? mkdtempSync(join(tmpdir(), "cx-resource-race-"));
  if (!root) roots.push(path);
  const f = await resourceFixture(path, { manualTick: true });
  fixtures.push(f);
  return { ...f, root: path };
}
function maintenance(f: ResourceFixture) {
  const controller = new MaintenanceController(f.store, {
    blobs: f.blobs,
    workerEntry: builtWorker("maintenance-worker.js"),
    processStartedAt: Date.now() + 1_000,
  });
  controllers.push(controller);
  return controller;
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.stop();
  for (const f of fixtures.splice(0)) await f.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const settleTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("resource owner generation races", () => {
  it("drops an inline row in the same transaction as its last resource owner, then collects the file", async () => {
    const f = await fixture();
    const bytes = Buffer.from("test");
    const body = f.blobs.prepareBody(bytes);
    f.store.transaction(() => f.blobs.insertRow(body));
    const first = f.resources.publishModel(bytes);
    const second = f.resources.publishModel(bytes);
    await f.tick();
    await f.resources.drainCleanup();
    f.resources.releaseModel(first);
    expect(
      f.store.prepare("SELECT inline FROM blob WHERE sha256=?").get(body.sha256),
    ).toBeDefined();
    const generation = f.store.owners.generationOf(`blob:${body.sha256}`);
    f.store
      .prepare(
        "CREATE TEMP TRIGGER reject_inline_delete AFTER DELETE ON blob BEGIN SELECT RAISE(ABORT, 'inline cleanup failure'); END",
      )
      .run();
    expect(() => f.resources.releaseModel(second)).toThrow(/inline cleanup failure/);
    expect(
      f.store.prepare("SELECT inline FROM blob WHERE sha256=?").get(body.sha256),
    ).toBeDefined();
    expect(f.resources.readModel(second)).toEqual(bytes);
    expect(f.store.owners.generationOf(`blob:${body.sha256}`)).toBe(generation);
    f.store.prepare("DROP TRIGGER reject_inline_delete").run();
    f.resources.releaseModel(second);
    expect(
      f.store.prepare("SELECT inline FROM blob WHERE sha256=?").get(body.sha256),
    ).toBeUndefined();
    expect(existsSync(f.blobs.filePath(body.sha256))).toBe(true);
    await f.tick();
    await f.resources.drainCleanup();
    expect(existsSync(f.blobs.filePath(body.sha256))).toBe(false);
  });

  it("T-GC-3: real publication/release ABA while GC waits requires the newer barrier", async () => {
    const f = await fixture();
    const a = f.resources.publishModel(Buffer.from("test"));
    const sha = a.sha256.slice(7);
    await f.tick();
    await f.resources.drainCleanup();
    f.resources.releaseModel(a);
    const g1 = f.store.owners.generationOf(`blob:${sha}`)!;
    let g2 = 0;
    const off = f.store.onSynced((g) => {
      if (g < g1 || g2) return;
      const b = f.resources.publishModel(Buffer.from("test"));
      f.resources.releaseModel(b);
      g2 = f.store.owners.generationOf(`blob:${sha}`)!;
    });
    await f.tick();
    await settleTick();
    off();
    expect(g2).toBeGreaterThan(g1);
    expect(f.store.acknowledgedGeneration).toBeLessThan(g2);
    expect(existsSync(f.blobs.filePath(sha))).toBe(true);
    await f.tick();
    await settleTick();
    await f.tick();
    await f.resources.drainCleanup();
    expect(existsSync(f.blobs.filePath(sha))).toBe(false);
    expect(f.store.prepare("SELECT 1 FROM blob WHERE sha256=?").get(sha)).toBeUndefined();
  });

  it("T-FIN-7: rowless part survives insert-delete ABA until the latest upload barrier", async () => {
    const f = await fixture();
    const initial = await uploaded(f);
    const row = readUploadRow(f.store, initial.uploadId)!;
    const part = join(f.store.paths.uploads, `${initial.uploadId}.part`);
    const remove = () =>
      runMutation(f.store, (tx) => {
        tx.prepare("DELETE FROM upload WHERE id=?").run(initial.uploadId);
        tx.changes.uploadChanged(initial.uploadId);
      });
    remove();
    const g1 = f.store.owners.generationOf(`upload:${initial.uploadId}`)!;
    const collecting = cleanupUploadPart(f.store, initial.uploadId, part);
    let g2 = 0;
    const off = f.store.onSynced((g) => {
      if (g < g1 || g2) return;
      runMutation(f.store, (tx) => {
        putUploadInTx(tx, row);
        tx.changes.uploadChanged(initial.uploadId);
      });
      remove();
      g2 = f.store.owners.generationOf(`upload:${initial.uploadId}`)!;
    });
    await f.tick();
    await settleTick();
    off();
    expect(g2).toBeGreaterThan(g1);
    expect(existsSync(part)).toBe(true);
    await f.tick();
    expect(await collecting).toBe("removed");
    expect(existsSync(part)).toBe(false);
  });

  it("cancel keeps its receipt but cannot unlink its part before the cancellation barrier", async () => {
    const f = await fixture();
    const initial = await uploaded(f);
    const part = join(f.store.paths.uploads, `${initial.uploadId}.part`);
    const generation = f.store.owners.generationOf(`upload:${initial.uploadId}`)!;
    expect(f.resources.cancel(initial.uploadId).state).toBe("cancelled");
    expect(f.store.owners.generationOf(`upload:${initial.uploadId}`)).toBeGreaterThan(generation);
    expect(existsSync(part)).toBe(true);
    await f.tick();
    await f.resources.drainCleanup();
    expect(existsSync(part)).toBe(false);
    expect(f.resources.status(initial.uploadId).state).toBe("cancelled");
    const m = maintenance(f);
    expect((await m.sweepOrphans()).removedParts).toEqual([]);
  });

  it("keeps uploaded parts across restart, and a missing upload still stays owned by an obligation", async () => {
    const first = await fixture();
    const initial = await uploaded(first);
    await first.close();
    const second = await fixture(first.root);
    const m = maintenance(second);
    const result = await m.sweepOrphans();
    const part = join(second.store.paths.uploads, `${initial.uploadId}.part`);
    expect(result.keptParts).toEqual([part]);
    expect(existsSync(part)).toBe(true);
    runMutation(second.store, (tx) => {
      tx.prepare("DELETE FROM upload WHERE id=?").run(initial.uploadId);
      second.obligations.create("publish_blob", initial.uploadId, 0, {
        sha: "a".repeat(64),
        resource_id: "res-pending",
      });
      tx.changes.uploadChanged(initial.uploadId);
      tx.changes.blobChanged("a".repeat(64));
    });
    expect(await cleanupUploadPart(second.store, initial.uploadId, part)).toBe("owned");
    expect(existsSync(part)).toBe(true);
  });

  it("T-GC-2: worker lists released metadata, while a synchronous new publication keeps its file", async () => {
    const f = await fixture();
    const initial = await uploaded(f);
    const receipt = f.resources.finalize(initial.uploadId, undefined, "f");
    await f.tick();
    await f.resources.drainCleanup();
    // The release row is a retained receipt, not a byte owner. Leave its file as crash residue.
    runMutation(f.store, (tx) => {
      tx.prepare("UPDATE resource SET state='released',released_at=? WHERE id=?").run(
        f.store.now().toISOString(),
        receipt.resourceId,
      );
      tx.changes.blobChanged(receipt.sha256.slice(7));
    });
    const m = maintenance(f);
    const listed = await m.sweepCandidates();
    expect(listed.candidates).toContainEqual({
      kind: "blob",
      path: f.blobs.filePath(receipt.sha256.slice(7)),
      sha: receipt.sha256.slice(7),
    });
    const collecting = f.blobs.gc(receipt.sha256.slice(7));
    const b = f.resources.publishModel(Buffer.from("test"));
    await f.tick();
    await settleTick();
    await f.tick();
    expect(await collecting).toBe("owned");
    expect(f.resources.readModel(b).toString()).toBe("test");
    expect(() => f.resources.readModel(payloadRef(receipt))).toThrow(/no such resource/);
  });
});
