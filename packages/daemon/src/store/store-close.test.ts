import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlusherController } from "./flusher.js";
import { EngineStore } from "./store.js";

const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;
let root: string;
let store: EngineStore | undefined;
let connection: DatabaseSync | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-store-close-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    if (store) await store.close();
  } finally {
    if (connection?.isOpen) connection.close();
    connection = undefined;
    store = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});
async function open() {
  store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../dist/store/flusher-worker.js"),
    flusherHooks: { manualTick: true },
  });
  connection = store.db;
  return store;
}

describeStore("EngineStore physical close", () => {
  it("closes the native connection even if flusher stop rejects, preserving that error", async () => {
    const store = await open();
    const db = store.db;
    const stopFailure = new Error("stop failed after worker exit");
    const nativeStop = FlusherController.prototype.stop;
    vi.spyOn(FlusherController.prototype, "stop").mockImplementationOnce(async function (
      this: FlusherController,
    ) {
      await nativeStop.call(this);
      throw stopFailure;
    });
    try {
      await expect(store.close()).rejects.toBe(stopFailure);
      expect(db.isOpen).toBe(false);
      expect(store.isClosed).toBe(true);
      expect(() => db.prepare("SELECT 1")).toThrow();
      await expect(store.close()).resolves.toBeUndefined();
    } finally {
      // The negative control leaves the old adapter falsely closed; clean its
      // actual native connection without relying on that flag.
      if (db.isOpen) db.close();
    }
  });

  it("shares completion while closing and reports closed only after the native close", async () => {
    const store = await open();
    const db = store.db;
    const nativeStop = FlusherController.prototype.stop;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(FlusherController.prototype, "stop").mockImplementationOnce(async function (
      this: FlusherController,
    ) {
      await gate;
      await nativeStop.call(this);
    });
    const first = store.close();
    const second = store.close();
    try {
      expect(second).toBe(first);
      expect(db.isOpen).toBe(true);
      expect(store.isClosed).toBe(false);
      expect(() => store.prepare("SELECT 1")).toThrow(
        expect.objectContaining({ code: "store_closed" }),
      );
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(db.isOpen).toBe(false);
    expect(store.isClosed).toBe(true);
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("retains the first failure and permits another close if the native connection stayed open", async () => {
    const store = await open();
    const db = store.db;
    const stopFailure = new Error("stop failed after worker exit");
    const nativeStop = FlusherController.prototype.stop;
    vi.spyOn(FlusherController.prototype, "stop").mockImplementationOnce(async function (
      this: FlusherController,
    ) {
      await nativeStop.call(this);
      throw stopFailure;
    });
    vi.spyOn(db, "close").mockImplementationOnce(() => {
      throw new Error("native close failed");
    });
    await expect(store.close()).rejects.toBe(stopFailure);
    expect(db.isOpen).toBe(true);
    expect(store.isClosed).toBe(false);
    await expect(store.close()).resolves.toBeUndefined();
    expect(db.isOpen).toBe(false);
    expect(store.isClosed).toBe(true);
  });
});
