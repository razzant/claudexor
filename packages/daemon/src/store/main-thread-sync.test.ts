import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/**
 * The request thread calls no Node storage-sync primitive (SYNTHESIS_R5 §2,
 * INV-143). The mock replaces the sync entry points of `node:fs` for every
 * module loaded on THIS thread; the flusher worker has its own module graph
 * and keeps the real functions, so its barrier still happens and is counted.
 */
const syncSpies = vi.hoisted(() => ({
  fsyncSync: vi.fn(),
  fdatasyncSync: vi.fn(),
  fsync: vi.fn(),
  fdatasync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrap = <K extends keyof typeof syncSpies>(name: K) => {
    const original = actual[name] as (...args: unknown[]) => unknown;
    return (...args: unknown[]) => {
      syncSpies[name](...args);
      return original(...args);
    };
  };
  const patched = {
    fsyncSync: wrap("fsyncSync"),
    fdatasyncSync: wrap("fdatasyncSync"),
    fsync: wrap("fsync"),
    fdatasync: wrap("fdatasync"),
  };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});

function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-store-nosync-"));
  for (const spy of Object.values(syncSpies)) spy.mockClear();
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});

describeStore("zero Node storage-sync calls on the request thread", () => {
  it("commits, registers and awaits flushed() without fsyncSync/fdatasyncSync on main", async () => {
    const store = await EngineStore.open({
      daemonDir: join(root, "daemon"),
      workerEntry: builtWorkerEntry("flusher-worker.js"),
    });
    stores.push(store);
    const insert = store.prepare(
      "INSERT INTO partition(name, epoch, status, next_seq, created_at) VALUES(?, 'e', 'ready', 1, 't')",
    );
    for (let i = 0; i < 25; i += 1) store.transaction(() => void insert.run(`p${i}`));
    store.registerExternal(root);
    await store.flushed();
    await store.flushed();
    const facts = store.facts();
    // Direction 1: the worker proved barriers and synced the directory.
    expect(facts.flusher.counters.barriers).toBeGreaterThanOrEqual(1);
    expect(facts.flusher.counters.dirSyncs).toBe(1);
    // Direction 2: not one storage-sync primitive ran on this thread.
    expect(syncSpies.fsyncSync).not.toHaveBeenCalled();
    expect(syncSpies.fdatasyncSync).not.toHaveBeenCalled();
    expect(syncSpies.fsync).not.toHaveBeenCalled();
    expect(syncSpies.fdatasync).not.toHaveBeenCalled();
  });

  it("the spy itself observes a main-thread fsyncSync (negative control)", async () => {
    const fs = await import("node:fs");
    const fd = fs.openSync(join(root, "probe"), "w");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    expect(syncSpies.fsyncSync).toHaveBeenCalledTimes(1);
  });
});
