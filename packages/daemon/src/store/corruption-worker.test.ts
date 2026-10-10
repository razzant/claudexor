import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreCorruptError, StoreFlushUnavailableError } from "./errors.js";
import { MaintenanceController } from "./maintenance.js";
import { EngineStore, type EngineStoreOptions } from "./store.js";

const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;
let root: string;
const stores: EngineStore[] = [];
const maintenance: MaintenanceController[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-corruption-worker-"));
});
afterEach(async () => {
  for (const controller of maintenance.splice(0)) await controller.stop();
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});
async function open(onCorrupt: NonNullable<EngineStoreOptions["onCorrupt"]>, workerEntry?: string) {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: workerEntry ?? resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
    onCorrupt,
  });
  stores.push(store);
  return store;
}
function controller(store: EngineStore, workerEntry?: string) {
  const value = new MaintenanceController(store, {
    workerEntry:
      workerEntry ?? resolve(import.meta.dirname, "../../dist/store/maintenance-worker.js"),
  });
  maintenance.push(value);
  return value;
}
function damageDataPage(store: EngineStore) {
  store.transaction(() =>
    store.exec("CREATE TABLE damaged(v); INSERT INTO damaged VALUES('bytes')"),
  );
  const page = Number(
    (
      store.prepare("SELECT rootpage FROM sqlite_schema WHERE name='damaged'").get() as {
        rootpage: number;
      }
    ).rootpage,
  );
  store.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.exec("PRAGMA shrink_memory");
  const fd = openSync(store.paths.database, "r+");
  try {
    writeSync(fd, Buffer.from([0xff]), 0, 1, (page - 1) * 4096);
  } finally {
    closeSync(fd);
  }
}

describeStore("physical corruption across existing worker channels", () => {
  it("a cold integrity check reports failed through the same observer, while healthy stays ok", async () => {
    const onCorrupt = vi.fn();
    const store = await open(onCorrupt);
    const healthy = controller(store);
    expect((await healthy.integrityCheck()).ok).toBe(true);
    expect(store.facts().integrity).toBe("ok");
    expect(onCorrupt).not.toHaveBeenCalled();
    await healthy.stop();
    damageDataPage(store);
    const cold = controller(store);
    const report = await cold.integrityCheck();
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(onCorrupt.mock.calls[0]?.[0]).toBeInstanceOf(StoreCorruptError);
    expect(store.facts()).toMatchObject({ integrity: "failed", obligations_open: null });
    store.recordIntegrity("ok");
    expect(store.facts().integrity).toBe("failed");
  });

  it("preserves typed physical corruption from a maintenance export failure", async () => {
    const order: string[] = [];
    let observed: StoreCorruptError | undefined;
    const store = await open((error) => {
      observed = error;
      order.push("observer");
    });
    damageDataPage(store);
    let failure: unknown;
    try {
      await controller(store).exportTo(join(root, "export.sqlite"));
    } catch (error) {
      failure = error;
      order.push("catch");
    }
    expect(failure).toBeInstanceOf(StoreCorruptError);
    expect(failure).toBe(observed);
    expect(order).toEqual(["observer", "catch"]);
    expect(store.facts().integrity).toBe("failed");
  });

  it("ordinary export failure neither invents corruption nor changes its error contract", async () => {
    const onCorrupt = vi.fn();
    const store = await open(onCorrupt);
    await expect(
      controller(store).exportTo(join(root, "missing", "export.sqlite")),
    ).rejects.toMatchObject({ code: "store_maintenance_failed", retryable: true });
    expect(onCorrupt).not.toHaveBeenCalled();
    expect(store.facts().integrity).toBe("pending");
  });

  it("observes native maintenance startup corruption before its worker can send a response", async () => {
    const entry = join(root, "maintenance-error.mjs");
    writeFileSync(
      entry,
      `
import { workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
db.prepare('SELECT v FROM damaged').get();
`,
    );
    const observed = vi.fn();
    const store = await open(observed);
    damageDataPage(store);
    await expect(controller(store, entry).integrityCheck()).rejects.toMatchObject({
      code: "store_corrupt",
      cause: { code: "ERR_SQLITE_ERROR", errcode: 11 },
    });
    expect(observed).toHaveBeenCalledOnce();
    expect(store.facts().integrity).toBe("failed");
  });

  it("a native SQLite flusher error reports corruption before rejecting its barrier as unavailable", async () => {
    // A worker exercising the existing flusher error/exit transport, with a
    // real SQLite step failure rather than a hand-written corruption message.
    const entry = join(root, "flusher-error.mjs");
    writeFileSync(
      entry,
      `
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(workerData.dbPath);
parentPort.on('message', message => {
  if (message.type === 'tick') db.prepare('SELECT v FROM damaged').get();
  if (message.type === 'stop') { db.close(); parentPort.close(); }
});
parentPort.postMessage({ type: 'ready', at: Date.now() });
`,
    );
    const observed = vi.fn();
    const store = await open(observed, entry);
    damageDataPage(store);
    const barrier = store.flushed();
    const settled = barrier.catch((error: unknown) => {
      expect(observed).toHaveBeenCalledOnce();
      return error;
    });
    store.flusherControl.tick();
    expect(await settled).toBeInstanceOf(StoreFlushUnavailableError);
    expect(observed.mock.calls[0]?.[0]).toMatchObject({
      code: "store_corrupt",
      cause: { code: "ERR_SQLITE_ERROR", errcode: 11 },
    });
    expect(store.facts()).toMatchObject({ integrity: "failed", obligations_open: null });
  });
});
