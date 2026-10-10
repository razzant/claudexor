import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlDaemonStorage } from "./sql-daemon-storage.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "sql-storage-owner-")));
  cleanups.push(() => rmSync(rootDir, { recursive: true, force: true }));
  const beforeClose = vi.fn(async () => {}),
    onOpen = vi.fn(),
    onCorrupt = vi.fn(),
    advanceFloor = vi.fn();
  const storage = new SqlDaemonStorage({
    rootDir,
    graph: {
      purgeFiles: async () => [rootDir],
      maintenance: {
        workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/maintenance-worker.js"),
      },
    },
    beforeClose,
    onOpen,
    onCorrupt,
    advanceFloor,
    log: () => {},
    importWorkerEntry: resolve(
      import.meta.dirname,
      "../../daemon/dist/store/maintenance-worker.js",
    ),
    flusherWorkerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  cleanups.push(() => storage.close());
  return { rootDir, storage, beforeClose, onOpen, onCorrupt, advanceFloor };
}
describe("one SQL storage owner", () => {
  it("keeps physical recovery usable when SQLite cannot open, and replays the original receipt", async () => {
    const f = fixture();
    const damaged = Buffer.from("not a sqlite database, retained as forensic evidence");
    writeFileSync(join(f.rootDir, "engine.sqlite"), damaged);
    await expect(f.storage.open()).rejects.toMatchObject({ code: "store_corrupt" });
    expect(f.onCorrupt).toHaveBeenCalledOnce();
    expect(f.advanceFloor).not.toHaveBeenCalled();
    expect(f.storage.facts()).toMatchObject({ integrity: "failed", flusher: null });
    const inspection = f.storage.engineRecovery.inspect();
    expect(inspection.status).toBe("recovery_required");
    const request = {
      idempotencyKey: "repair",
      confirmation: "quarantine_and_start_fresh" as const,
      expectedFingerprint: inspection.fingerprint,
    };
    const receipt = await f.storage.engineRecovery.quarantineAndStartFresh(request);
    expect(readFileSync(join(receipt.quarantinePath, "engine.sqlite"))).toEqual(damaged);
    expect(f.beforeClose).toHaveBeenCalledOnce();
    expect(f.onOpen).toHaveBeenCalledOnce();
    expect(f.advanceFloor).toHaveBeenCalledOnce();
    const graph = f.storage.graph();
    expect(graph.projects.global().epoch).toBe(receipt.newEpoch);
    expect(f.storage.blockedPartitions()).toEqual([]);
    graph.commands
      .current()
      .accept({
        id: "kept-after-repair",
        params: { prompt: "keep" },
        clientId: "test",
        idempotencyKey: "keep",
      });
    expect(await f.storage.engineRecovery.quarantineAndStartFresh(request)).toEqual(receipt);
    expect(graph.commands.current().get("kept-after-repair")).toBeDefined();
    expect(f.onOpen).toHaveBeenCalledOnce();
    expect(existsSync(join(f.rootDir, "engine.sqlite"))).toBe(true);
  });
  it("retains the graph and logical recovery while the global generation is blocked", async () => {
    const f = fixture();
    await f.storage.open();
    const graph = f.storage.graph();
    graph.store.transaction(() =>
      graph.store
        .prepare("UPDATE partition SET status='recovery_required' WHERE name='global'")
        .run(),
    );
    expect(f.storage.blockedPartitions()).toEqual(["global"]);
    const target = f.storage.partition("global");
    const inspection = target.inspect();
    expect(inspection.status).toBe("recovery_required");
    target.quarantineAndStartFresh({
      idempotencyKey: "global",
      confirmation: "quarantine_and_start_fresh" as const,
      expectedFingerprint: inspection.fingerprint,
    });
    expect(f.storage.blockedPartitions()).toEqual([]);
    expect(f.storage.graph()).toBe(graph);
    expect(graph.quota.read()).toBeDefined();
  });
});
