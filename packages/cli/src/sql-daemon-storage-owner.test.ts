import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineStore } from "@claudexor/daemon";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FlusherController } from "../../daemon/src/store/flusher.js";
import { SqlDaemonStorage } from "./sql-daemon-storage.js";

let root: string;
const owners: SqlDaemonStorage[] = [];
const acquired: Array<{
  store: EngineStore;
  connection: EngineStore["db"];
  flusher: FlusherController;
}> = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sql-storage-owner-")));
  const open = EngineStore.open;
  vi.spyOn(EngineStore, "open").mockImplementation(async (options) => {
    const store = await open(options);
    acquired.push({
      store,
      connection: store.db,
      flusher: store.flusherControl as FlusherController,
    });
    return store;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    for (const owner of owners.splice(0).reverse()) await owner.close();
  } finally {
    // A failing negative control must not leave its observed leaked worker alive.
    for (const { store } of acquired.splice(0)) if (!store.isClosed) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function owner() {
  const onOpen = vi.fn(),
    onCorrupt = vi.fn(),
    log = vi.fn(),
    advanceFloor = vi.fn();
  const storage = new SqlDaemonStorage({
    rootDir: root,
    graph: {
      purgeFiles: async () => [],
      maintenance: {
        workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/maintenance-worker.js"),
      },
    },
    onOpen,
    onCorrupt,
    log,
    advanceFloor,
    beforeClose: async () => {},
    flusherWorkerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  owners.push(storage);
  return { storage, onOpen, onCorrupt, log, advanceFloor };
}
function expectClosed(record: (typeof acquired)[number]) {
  expect(record.store.isClosed).toBe(true);
  expect(record.connection.isOpen).toBe(false);
  expect(record.flusher.facts().state).toBe("down");
}

it.each([
  [false, false],
  [true, false],
  [true, true],
])(
  "retains store ownership through upload graph construction (corrupt=%s, cleanupFails=%s)",
  async (corrupt, cleanupFails) => {
    const seed = owner();
    await seed.storage.open();
    const graph = seed.storage.graph();
    graph.resources.create(
      {
        purpose: "model",
        kind: "file",
        mime: "application/json",
        name: "fixture.json",
        sizeBytes: 1,
      },
      "upload",
    );
    const { rootpage } = graph.store
      .prepare("SELECT rootpage FROM sqlite_schema WHERE name='upload'")
      .get() as { rootpage: number };
    const { page_size } = graph.store.prepare("PRAGMA page_size").get() as { page_size: number };
    await graph.store.flushed();
    await seed.storage.close();
    expectClosed(acquired[0]!);
    if (corrupt) {
      const fd = openSync(join(root, "engine.sqlite"), "r+");
      try {
        writeSync(fd, Buffer.from([0xff]), 0, 1, (rootpage - 1) * page_size);
      } finally {
        closeSync(fd);
      }
    }
    const current = owner();
    if (cleanupFails)
      vi.spyOn(EngineStore.prototype, "close").mockRejectedValueOnce(
        new Error("native close failed"),
      );
    if (corrupt) {
      await expect(current.storage.open()).rejects.toMatchObject({
        code: "store_corrupt",
        status: 503,
      });
      expect(current.onOpen).not.toHaveBeenCalled();
      expect(current.onCorrupt).toHaveBeenCalledWith(
        expect.objectContaining({ code: "store_corrupt" }),
      );
      expect(() => current.storage.graph()).toThrow(
        expect.objectContaining({ code: "daemon_recovery_only" }),
      );
    } else {
      await current.storage.open();
      expect(current.storage.graph().store).toBe(acquired[1]!.store);
      expect(acquired[1]!.connection.isOpen).toBe(true);
      expect(acquired[1]!.flusher.facts().state).toBe("up");
    }
    expect(acquired).toHaveLength(2); // The failure happened after real acquisition.
    if (corrupt && !cleanupFails) expectClosed(acquired[1]!);
    if (cleanupFails) {
      expect(acquired[1]!.store.isClosed).toBe(false);
      expect(current.log).toHaveBeenCalledWith(expect.stringContaining("native close failed"));
    }
    await current.storage.close();
    expectClosed(acquired[1]!);
    expect(() => current.storage.graph()).toThrow();
  },
);

it("closes an already-built graph and its workers when onOpen fails", async () => {
  const f = owner();
  const primary = Object.assign(new Error("publication failed"), {
    code: "fixture_publication",
    status: 503,
  });
  let graph: ReturnType<SqlDaemonStorage["graph"]> | undefined;
  let pending: Promise<unknown> | undefined;
  let stop: ReturnType<typeof vi.spyOn> | undefined;
  f.onOpen.mockImplementation((value) => {
    graph = value;
    stop = vi.spyOn(value.maintenance, "stop");
    pending = value.maintenance.integrityCheck().catch((error: unknown) => error);
    throw primary;
  });
  await expect(f.storage.open()).rejects.toBe(primary);
  expect(stop).toHaveBeenCalledOnce();
  expect(await pending).toMatchObject({ code: "store_closed" });
  await expect(graph!.maintenance.integrityCheck()).rejects.toMatchObject({ code: "store_closed" });
  expectClosed(acquired[0]!);
  expect(() => f.storage.graph()).toThrow();
  expect(f.log).not.toHaveBeenCalled();
});

it("keeps the primary failure and retains the store when cleanup itself fails", async () => {
  const f = owner();
  const primary = Object.assign(new Error("publication failed"), {
    code: "fixture_publication",
    status: 503,
  });
  const cleanup = new Error("store close failed");
  f.onOpen.mockImplementation((graph) => {
    vi.spyOn(graph.store, "close").mockRejectedValueOnce(cleanup);
    throw primary;
  });
  await expect(f.storage.open()).rejects.toBe(primary);
  expect(acquired[0]!.store.isClosed).toBe(false);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("store close failed"));
  // Explicit owner cleanup can still reach the exact previously acquired store.
  await f.storage.close();
  expectClosed(acquired[0]!);
  expect(() => f.storage.graph()).toThrow();
});

it.each(["before_graph", "onOpen"])(
  "closes failed fresh creation at %s and resumes the accepted recovery",
  async (point) => {
    writeFileSync(join(root, "engine.sqlite"), "unreadable old database");
    const f = owner();
    await expect(f.storage.open()).rejects.toMatchObject({ code: "store_corrupt" });
    const primary = Object.assign(new Error("fresh publication failed"), {
      code: "fixture_publication",
      status: 503,
    });
    (point === "before_graph" ? f.advanceFloor : f.onOpen).mockImplementationOnce(() => {
      throw primary;
    });
    const request = {
      idempotencyKey: "repair",
      expectedFingerprint: f.storage.engineRecovery.inspect().fingerprint,
      confirmation: "quarantine_and_start_fresh" as const,
    };
    await expect(f.storage.engineRecovery.quarantineAndStartFresh(request)).rejects.toBe(primary);
    expect(acquired).toHaveLength(1);
    expectClosed(acquired[0]!);
    expect(() => f.storage.graph()).toThrow();
    const receipt = await f.storage.engineRecovery.quarantineAndStartFresh(request);
    expect(acquired).toHaveLength(2);
    expect(f.storage.graph().projects.global().epoch).toBe(receipt.newEpoch);
    expect(await f.storage.engineRecovery.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(acquired).toHaveLength(2);
    await f.storage.close();
    expectClosed(acquired[1]!);
  },
);
