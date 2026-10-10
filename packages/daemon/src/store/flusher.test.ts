import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ControlAccountResetResponse, ModelDispatch } from "@claudexor/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreFlushUnavailableError } from "./errors.js";
import type { FlusherPassReport } from "./flusher-protocol.js";
import { EngineStore } from "./store.js";

/** The store runs only where `node:sqlite` exists; elsewhere these cases are skipped, not failed. */
const sqliteAvailable = await import("node:sqlite").then(
  () => true,
  () => false,
);
const describeStore = sqliteAvailable ? describe : describe.skip;

/** The worker runs from the built package: Node loads it with its own loader. */
function builtWorkerEntry(name: string): string {
  const entry = resolve(import.meta.dirname, "../../dist/store", name);
  if (!existsSync(entry)) throw new Error(`built worker missing at ${entry}; run pnpm build first`);
  return entry;
}

let root: string;
const stores: EngineStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cx-flusher-"));
});
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  rmSync(root, { recursive: true, force: true });
});

async function openStore(hooks: {
  manualTick?: boolean;
  allowExit?: boolean;
}): Promise<EngineStore> {
  const store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: builtWorkerEntry("flusher-worker.js"),
    flusherHooks: hooks,
  });
  stores.push(store);
  return store;
}

function reports(store: EngineStore): FlusherPassReport[] {
  const seen: FlusherPassReport[] = [];
  store.onSynced((_g, report) => seen.push(report));
  return seen;
}

function commitRows(store: EngineStore, n: number): void {
  const insert = store.prepare(
    "INSERT INTO event(pid, seq, time, type, payload) VALUES(1, ?, 't', 'x', ?)",
  );
  store.transaction(() => {
    for (let i = 0; i < n; i += 1)
      insert.run(Date.now() * 1000 + i + Math.floor(Math.random() * 1e6), Buffer.alloc(3000, 1));
  });
}

/** One pass under manual ticking: tick, then await the synced report it produces. */
async function pass(store: EngineStore, seen: FlusherPassReport[]): Promise<FlusherPassReport> {
  const before = seen.length;
  store.flusherControl.tick();
  await new Promise<void>((resolve) => {
    const poll = () => (seen.length > before ? resolve() : setTimeout(poll, 5));
    poll();
  });
  return seen[seen.length - 1]!;
}

function materialize(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${name}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_DSYNC, 0o600);
  try {
    writeSync(fd, Buffer.from("payload"));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, name));
}

describeStore("flusher protocol", () => {
  it("T-BAR-1: the barrier follows data_version, never the checkpoint result", async () => {
    const store = await openStore({ manualTick: true });
    const seen = reports(store);
    // A fresh worker life proves one barrier even before any commit.
    const first = await pass(store, seen);
    expect(first.barrier).toBe(true);
    // commit → the MAIN connection checkpoints the whole WAL → idle.
    commitRows(store, 20);
    const mainCheckpoint = store.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      busy: number;
      log: number;
      checkpointed: number;
    };
    expect(mainCheckpoint.checkpointed).toBe(mainCheckpoint.log);
    expect(mainCheckpoint.log).toBeGreaterThan(0);
    // The worker's PASSIVE finds nothing to backfill, yet exactly one explicit
    // WAL F_FULLFSYNC runs because something was committed since its last barrier.
    const second = await pass(store, seen);
    expect(second.dirty).toBe(true);
    expect(second.barrier).toBe(true);
    expect(second.counters.barriers).toBe(first.counters.barriers + 1);
    // `checkpointed` is the CUMULATIVE nBackfill (Fable F1): the worker's
    // PASSIVE found no new frame and backfilled nothing, so a barrier derived
    // from checkpoint progress would have skipped the sync here.
    expect(second.checkpoint).toEqual({
      busy: 0,
      log: mainCheckpoint.log,
      checkpointed: mainCheckpoint.checkpointed,
    });
    // Idle pass: nothing committed → no sync call at all.
    const third = await pass(store, seen);
    expect(third.dirty).toBe(false);
    expect(third.barrier).toBe(false);
    expect(third.counters.barriers).toBe(second.counters.barriers);
    // Commit again → one more barrier.
    commitRows(store, 1);
    const fourth = await pass(store, seen);
    expect(fourth.barrier).toBe(true);
    expect(fourth.counters.barriers).toBe(second.counters.barriers + 1);
  });

  it("T-BAR-2: synced(g_target) covers only generations received before the pass started", async () => {
    const store = await openStore({ manualTick: true });
    const seen = reports(store);
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    materialize(dirA, "one");
    materialize(dirB, "two");
    const g1 = store.registerExternal(dirA);
    let p2Settled = false;
    const p2 = store.flushed().then(() => {
      p2Settled = true;
    });
    store.flusherControl.tick();
    // Posted after the tick, before the worker could run it: FIFO keeps them
    // out of this pass even though they are "already sent".
    const g3 = store.registerExternal(dirB);
    let p4Settled = false;
    const p4 = store.flushed().then(() => {
      p4Settled = true;
    });
    await p2;
    expect(p2Settled).toBe(true);
    expect(p4Settled).toBe(false);
    const report = seen[seen.length - 1]!;
    expect(report.g).toBe(g1 + 1);
    expect(report.dirsSynced).toEqual([dirA]);
    expect(store.facts().flusher.pending_registrations).toBe(1);
    expect(store.facts().flusher.acknowledged_generation).toBe(g1 + 1);
    const next = await pass(store, seen);
    await p4;
    expect(p4Settled).toBe(true);
    expect(next.g).toBe(g3 + 1);
    expect(next.dirsSynced).toEqual([dirB]);
    expect(store.facts().flusher.pending_registrations).toBe(0);
  });

  it("T-BAR-3: a registered directory is fsynced once per pass by the covering pass", async () => {
    const store = await openStore({ manualTick: true });
    const seen = reports(store);
    const dir = join(root, "final");
    materialize(dir, "run_facts.yaml");
    materialize(dir, "telemetry.yaml");
    store.registerExternal(dir);
    store.registerExternal(dir);
    const flushed = store.flushed();
    const report = await pass(store, seen);
    await flushed;
    expect(report.dirsSynced).toEqual([dir]);
    expect(report.counters.dirSyncs).toBe(1);
    const idle = await pass(store, seen);
    expect(idle.dirsSynced).toEqual([]);
    expect(idle.counters.dirSyncs).toBe(1);
  });

  it("T-BAR-4: a dead worker rejects older waiters typed, restarts dirty, and replays registrations", async () => {
    const store = await openStore({ allowExit: true, manualTick: true });
    const seen = reports(store);
    const dir = join(root, "replayed");
    materialize(dir, "blob");
    const gReg = store.registerExternal(dir);
    const waiter = store.flushed();
    store.flusherControl.requestExit(3);
    // Committed BEFORE the new worker exists, with a pinned reader so no new
    // backfill can happen: the restarted worker's first pass must still prove
    // an explicit barrier (R5_AMENDMENTS A5 — a new life starts dirty).
    commitRows(store, 5);
    const { DatabaseSync } = await import("node:sqlite");
    const pinned = new DatabaseSync(store.paths.database, { readOnly: true });
    pinned.exec("BEGIN");
    pinned.prepare("SELECT count(*) FROM event").get();
    try {
      const failure = await waiter.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StoreFlushUnavailableError);
      expect(failure).toMatchObject({
        code: "store_flush_unavailable",
        status: 503,
        retryable: true,
        generation: gReg + 1,
      });
      await new Promise<void>((resolve) => {
        const poll = () => (store.facts().flusher.state === "up" ? resolve() : setTimeout(poll, 5));
        poll();
      });
      const facts = store.facts().flusher;
      expect(facts.counters.deaths).toBe(1);
      expect(facts.counters.restarts).toBe(1);
      expect(facts.pending_registrations).toBe(1);
      const later = store.flushed();
      const report = await pass(store, seen);
      await later;
      expect(report.dirty).toBe(true);
      expect(report.barrier).toBe(true);
      expect(report.counters.barriers).toBe(1);
      expect(report.dirsSynced).toEqual([dir]);
      expect(report.g).toBeGreaterThan(gReg + 1);
      expect(store.facts().flusher.pending_registrations).toBe(0);
    } finally {
      pinned.exec("COMMIT");
      pinned.close();
    }
  });

  it("T-BAR-5: the typed refusal maps onto existing DTO values without new enum members", async () => {
    const store = await openStore({ allowExit: true, manualTick: true });
    const waiter = store.flushed();
    store.flusherControl.requestExit(1);
    const failure = (await waiter.catch((error: unknown) => error)) as StoreFlushUnavailableError;
    expect(failure.code).toBe("store_flush_unavailable");
    // Dispatch site: the record stays `not_started` with its attempt stamp and the typed problem.
    const dispatch = ModelDispatch.parse({
      state: "not_started",
      startedAt: new Date().toISOString(),
      route: null,
    });
    expect(dispatch.state).toBe("not_started");
    const problem = { code: failure.code, status: failure.status, retryable: failure.retryable };
    expect(problem).toEqual({ code: "store_flush_unavailable", status: 503, retryable: true });
    // Account-reset site: `completed/unavailable` with the code as detail.
    const receipt = ControlAccountResetResponse.parse({
      id: "account-reset-1",
      request: { target: { harness: "codex", profile_id: "p" }, offer_id: "offer" },
      state: "completed",
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      outcome: "unavailable",
      detail: failure.code,
      readback: { state: "failed", attempted_at: null, detail: failure.code },
      resources: null,
    });
    expect(receipt.outcome).toBe("unavailable");
    expect(receipt.detail).toBe("store_flush_unavailable");
  });
});
