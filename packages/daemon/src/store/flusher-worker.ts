import { closeSync, fstatSync, fsyncSync, openSync, statSync } from "node:fs";
import { isMainThread, parentPort, workerData, type MessagePort } from "node:worker_threads";
import { fsyncDirectory } from "@claudexor/util";
import { applyPragmas, FLUSHER_CONNECTION_PRAGMAS } from "./pragmas.js";
import { loadEngineRuntime } from "./runtime.js";
import {
  FLUSH_INTERVAL_MS,
  STORE_WORKER_DATA_KEY,
  periodicDelayAfterWake,
  type FlusherCommand,
  type FlusherCounters,
  type FlusherEvent,
  type FlusherWorkerData,
} from "./flusher-protocol.js";

/**
 * The flusher pass (SYNTHESIS_R5 §4.2), every 200 ms, or at once when a waiting
 * `flushed()` wakes the worker (that pass replaces the scheduled one):
 *   1. g_target := the highest generation received so far (FIFO: every
 *      registration or flush request handled before this tick is covered);
 *   2. one F_FULLFSYNC per directory touched by a covered registration;
 *   3. `PRAGMA data_version` → dirty := anything committed since the last
 *      PROVEN barrier (the first pass of a worker life is always dirty);
 *   4. `PRAGMA wal_checkpoint(PASSIVE)` — space reclamation only; its result
 *      is reported as a fact and NEVER decides whether to sync. A woken pass
 *      leaves it to the periodic passes unless none ran it for two intervals,
 *      so a waiter usually waits for its barrier alone while the WAL is still
 *      reclaimed at least that often, whatever the wake rate;
 *   5. if dirty: the explicit `fsyncSync(walFd)` — the barrier: it fixes the
 *      WAL frames and, as a device-wide barrier on macOS, the O_DSYNC file
 *      data already handed to the drive. Database pages become durable
 *      through the ff-checkpoint (`checkpoint_fullfsync=1` on every
 *      checkpointing connection) before the WAL is reused, not through this
 *      fsync (R5_AMENDMENTS B5);
 *   6. `synced(g_target)` with the pass facts.
 * The worker never writes a row and never waits for a lock. `node:sqlite` is
 * imported lazily so the daemon package loads on a Node without it and the
 * typed `engine_runtime_unsupported` stays reachable.
 */
export async function runFlusherWorker(port: MessagePort, data: FlusherWorkerData): Promise<void> {
  const hooks = data.hooks ?? {};
  const interval = hooks.intervalMs ?? FLUSH_INTERVAL_MS;
  const walPath = `${data.dbPath}-wal`;
  const { sqlite } = await loadEngineRuntime();
  const db = new sqlite.DatabaseSync(data.dbPath, { timeout: 0 });
  applyPragmas(db, FLUSHER_CONNECTION_PRAGMAS);
  const dataVersion = db.prepare("PRAGMA data_version");
  const passive = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  const counters: FlusherCounters = {
    passes: 0,
    barriers: 0,
    dirSyncs: 0,
    busyPassive: 0,
    walReopens: 0,
  };
  const pendingDirs = new Set<string>();
  let gMax = 0;
  let lastProvenDataVersion: number | null = null;
  let walFd: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let due = 0;
  let reclaimedAt = Number.NEGATIVE_INFINITY;
  let woken: NodeJS.Immediate | null = null;
  let stopped = false;

  const post = (event: FlusherEvent): void => port.postMessage(event);

  const closeWal = (): void => {
    if (walFd === null) return;
    closeSync(walFd);
    walFd = null;
  };

  /** `r+` on the WAL file, never written through; reopened when the inode moved. */
  const ensureWalFd = (): number => {
    const onDisk = statSync(walPath, { throwIfNoEntry: false });
    if (walFd !== null) {
      if (onDisk && fstatSync(walFd).ino === onDisk.ino) return walFd;
      closeWal();
      counters.walReopens += 1;
    }
    walFd = openSync(walPath, "r+");
    return walFd;
  };

  const pass = (reclaim = true): void => {
    if (stopped) return;
    const started = performance.now();
    const gTarget = gMax;
    const dirsSynced: string[] = [];
    const dirsMissing: string[] = [];
    for (const dir of pendingDirs) {
      // A directory removed since its registration has no entries left to
      // make durable; whoever removed it registered the parent. Any other
      // failure is fatal to this worker life (fail loud, restart).
      try {
        fsyncDirectory(dir);
        dirsSynced.push(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
        dirsMissing.push(dir);
      }
    }
    pendingDirs.clear();
    counters.dirSyncs += dirsSynced.length;
    const observed = Number((dataVersion.get() as { data_version: number | bigint }).data_version);
    const dirty = lastProvenDataVersion === null || observed !== lastProvenDataVersion;
    if (reclaim) reclaimedAt = started;
    const checkpointRow = (reclaim ? passive.get() : undefined) as
      { busy: number | bigint; log: number | bigint; checkpointed: number | bigint } | undefined;
    const checkpoint = checkpointRow
      ? {
          busy: Number(checkpointRow.busy),
          log: Number(checkpointRow.log),
          checkpointed: Number(checkpointRow.checkpointed),
        }
      : null;
    if (checkpoint?.busy) counters.busyPassive += 1;
    if (hooks.passDelayMs) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hooks.passDelayMs);
    }
    let barrier = false;
    let barrierMs: number | null = null;
    if (dirty) {
      const fd = ensureWalFd();
      const t0 = performance.now();
      fsyncSync(fd);
      barrierMs = performance.now() - t0;
      barrier = true;
      counters.barriers += 1;
      lastProvenDataVersion = observed;
    }
    counters.passes += 1;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    post({
      type: "synced",
      report: {
        g: gTarget,
        dirty,
        barrier,
        dirsSynced,
        dirsMissing,
        checkpoint,
        walBytes: wal ? wal.size : null,
        passMs: performance.now() - started,
        barrierMs,
        counters: { ...counters },
        at: Date.now(),
      },
    });
  };

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (woken) clearImmediate(woken);
    timer = null;
    closeWal();
    db.close();
    post({ type: "stopped" });
    port.close();
  };

  const schedule = (delay = interval): void => {
    if (stopped || hooks.manualTick) return;
    due = performance.now() + delay;
    timer = setTimeout(() => {
      pass();
      schedule();
    }, delay);
  };

  // A waiter runs the scheduled pass now. Every command already received is
  // covered by it, so concurrent waiters share one pass and one barrier.
  const wake = (): void => {
    if (woken || stopped || hooks.manualTick) return;
    woken = setImmediate(() => {
      woken = null;
      if (timer) clearTimeout(timer);
      const replaced = due;
      const started = performance.now();
      pass(started - reclaimedAt >= 2 * interval);
      schedule(periodicDelayAfterWake(replaced, started, interval));
    });
  };

  port.on("message", (command: FlusherCommand) => {
    switch (command.type) {
      case "register":
        pendingDirs.add(command.dir);
        gMax = Math.max(gMax, command.g);
        return;
      case "flush":
        gMax = Math.max(gMax, command.g);
        if (command.wake) wake();
        return;
      case "tick":
        if (hooks.manualTick) pass();
        return;
      case "exit":
        if (hooks.allowExit) process.exit(command.code);
        return;
      case "stop":
        stop();
        return;
    }
  });
  post({ type: "ready", at: Date.now() });
  schedule();
}

const spawnData = workerData as Partial<FlusherWorkerData> | null | undefined;
if (!isMainThread && parentPort && spawnData?.[STORE_WORKER_DATA_KEY] === "flusher") {
  void runFlusherWorker(parentPort, spawnData as FlusherWorkerData).catch((error: unknown) => {
    throw error;
  });
}
