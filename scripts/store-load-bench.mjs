#!/usr/bin/env node
/**
 * Engine store load harness (SYNTHESIS_R5 §13.1), derived from the R5
 * checkpoint-ordering prototype but driving the BUILT store core: the request
 * thread commits a multi-table transaction (event under the fold verdict +
 * command upsert + idempotency row, every 20th commit with a 200 KiB body
 * through the blob writer) at RATE commits/s over 9 partitions, 10 SSE-shaped
 * readers poll every 250 ms, K external files per 200 ms go through the
 * O_DSYNC + rename path, `flushed()` is awaited every 500 ms, the real flusher
 * runs its 200 ms pass, and the maintenance worker runs one integrity_check.
 *
 * Measured separately: (i) main-thread block on COMMIT (the transaction call),
 * (ii) main-thread block on file writes, (iii) event-loop delay. Plus WAL max,
 * pass duration, the worker's real sync-call counters, flushed() latency,
 * busy waits, and load1 beside the numbers — this machine is never quiet.
 *
 *   node scripts/store-load-bench.mjs            # RATE=200 K=0 SECONDS=12
 *   RATE=50 K=10 node scripts/store-load-bench.mjs
 *   OUT=results.jsonl ...                        # append the JSON line
 *
 * Requires `pnpm build` (imports packages/daemon/dist). Data lives in a temp
 * directory and is deleted afterwards (KEEP=1 keeps it).
 */
import { mkdtempSync, rmSync, statSync, appendFileSync, existsSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dist = join(repoRoot, "packages", "daemon", "dist", "store");
if (!existsSync(join(dist, "store.js"))) {
  console.error("store-load-bench: run `pnpm build` first (packages/daemon/dist is missing)");
  process.exit(2);
}
const load = async (name) => import(pathToFileURL(join(dist, name)).href);
const { EngineStore } = await load("store.js");
const { BlobFiles } = await load("blob-files.js");
const { writeExternalFile } = await load("external-files.js");
const { createPartition } = await load("partitions.js");
const { appendEvent } = await load("retention.js");
const { readJournalEvents } = await load("cursors.js");
const { MaintenanceController } = await load("maintenance.js");

const RATE = Number(process.env.RATE ?? 200);
const K = Number(process.env.K ?? 0);
const SECONDS = Number(process.env.SECONDS ?? 12);
const KEEP = process.env.KEEP === "1";

const pct = (values, q) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const fmt = (values) =>
  values.length
    ? {
        n: values.length,
        p50: +pct(values, 0.5).toFixed(3),
        p99: +pct(values, 0.99).toFixed(3),
        max: +Math.max(...values).toFixed(3),
      }
    : null;
const load1 = () => +loadavg()[0].toFixed(2);

const root = mkdtempSync(join(tmpdir(), "cx-store-bench-"));
const daemonDir = join(root, "daemon");
const loadStart = load1();
const store = await EngineStore.open({
  daemonDir,
  workerEntry: join(dist, "flusher-worker.js"),
});
const blobs = new BlobFiles(store);
const maintenance = new MaintenanceController(store, {
  workerEntry: join(dist, "maintenance-worker.js"),
  processStartedAt: Date.now(),
});
const names = [...Array.from({ length: 8 }, (_, i) => `project:p${i}`), "global"];
const generations = store.transaction(() => names.map((name) => createPartition(store, name)));
const upsertCommand = store.prepare(
  `INSERT INTO command(id, pid, operation, state, run_id, thread_id, created_at, finished_at, summary, params_sha, kind)
   VALUES(?, ?, 'run.create', ?, ?, ?, ?, ?, ?, ?, 'product')
   ON CONFLICT(id) DO UPDATE SET state = excluded.state, finished_at = excluded.finished_at, summary = excluded.summary`,
);
const insertIdempotency = store.prepare(
  `INSERT OR IGNORE INTO idempotency(owner, pid, key_digest, operation, request_digest, target_id, created_at)
   VALUES('command', ?, ?, 'run.create', ?, ?, ?)`,
);
const summary = Buffer.alloc(400, 0x62);
const payload = { record: { id: "", state: "", createdAt: "" }, keyDigest: "", requestDigest: "" };
const bigBody = Buffer.alloc(200 * 1024, 0x63);
const smallFile = Buffer.alloc(2048, 0x64);
const fileDirs = [join(daemonDir, "runs", "a", "final"), join(daemonDir, "runs", "b", "final")];

// Facts from the worker: pass duration, barriers, dir syncs, WAL size.
const passes = [];
const barrierMs = [];
let walMax = 0;
store.onSynced((_g, report) => {
  passes.push(report.passMs);
  if (report.barrierMs !== null) barrierMs.push(report.barrierMs);
  if (report.walBytes) walMax = Math.max(walMax, report.walBytes);
});

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
const commits = [];
const stalls = [];
const fileWrites = [];
const bodyWrites = [];
const reads = [];
const flushes = [];
let tickerLate = 0;
let maxGap = 0;
let lastTick = performance.now();
const ticker = setInterval(() => {
  const now = performance.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > 10) tickerLate += 1;
  if (gap > maxGap) maxGap = gap;
}, 5);
const cursors = new Map(names.map((name) => [name, undefined]));
const readerNames = [...names, "global"]; // 10 readers
const sseTimer = setInterval(() => {
  const t0 = performance.now();
  for (const name of readerNames) {
    const events = readJournalEvents(store, name, cursors.get(name));
    if (events.length) cursors.set(name, events[events.length - 1].cursor);
  }
  reads.push(performance.now() - t0);
}, 250);
const walTimer = setInterval(() => {
  try {
    walMax = Math.max(walMax, statSync(store.paths.wal).size);
  } catch {
    /* no WAL yet */
  }
}, 1000);
const flushTimer = setInterval(() => {
  const t0 = performance.now();
  store.flushed().then(
    () => flushes.push(performance.now() - t0),
    () => {},
  );
}, 500);
let fileIndex = 0;
const fileTimer =
  K > 0
    ? setInterval(() => {
        const dir = fileDirs[fileIndex % 2];
        const t0 = performance.now();
        writeExternalFile(store, { dir, name: `f${fileIndex}.bin`, bytes: smallFile });
        fileWrites.push(performance.now() - t0);
        fileIndex += 1;
      }, 200 / K)
    : null;
let integrity = null;
const maintenanceTimer = setTimeout(
  () => {
    maintenance.integrityCheck().then(
      (report) => (integrity = { ok: report.ok, ms: +report.durationMs.toFixed(1) }),
      (error) => (integrity = { error: error.message }),
    );
  },
  (SECONDS * 1000) / 2,
);

const total = RATE * SECONDS;
const started = performance.now();
let i = 0;
await new Promise((resolve) => {
  const step = () => {
    const due = started + (i * 1000) / RATE;
    const now = performance.now();
    if (now < due) {
      setTimeout(step, Math.max(0, due - now));
      return;
    }
    while (i < total && performance.now() >= started + (i * 1000) / RATE) {
      const generation = generations[i % generations.length];
      const id = `cmd-${i}`;
      const ts = new Date().toISOString();
      const type = i % 3 === 0 ? "command.accepted" : "command.updated";
      const state = i % 3 === 2 ? "succeeded" : "running";
      payload.record.id = `cmd-${i - (i % 3)}`;
      payload.record.state = state;
      payload.record.createdAt = ts;
      payload.keyDigest = `k-${i}`;
      payload.requestDigest = `rd-${i}`;
      let body = null;
      if (i % 20 === 0) {
        // A distinct body per commit: the content-addressed writer skips an existing digest.
        bigBody.writeUInt32LE(i, 0);
        const b0 = performance.now();
        body = blobs.prepareBody(bigBody);
        bodyWrites.push(performance.now() - b0);
      }
      const t0 = performance.now();
      try {
        store.transaction(() => {
          appendEvent(store, generation.pid, { type, payload, time: ts });
          if (body) blobs.insertRow(body);
          upsertCommand.run(
            id,
            generation.pid,
            state,
            `run-${i}`,
            `thr-${i % 50}`,
            ts,
            state === "succeeded" ? ts : null,
            summary,
            body ? body.sha256 : `sha-${i}`,
          );
          if (i % 3 === 0) insertIdempotency.run(generation.pid, `kd-${i}`, `rd-${i}`, id, ts);
        });
      } catch (error) {
        console.error("transaction failed:", error.message);
      }
      const took = performance.now() - t0;
      commits.push(took);
      if (took > 5) stalls.push(+took.toFixed(1));
      i += 1;
    }
    if (i >= total) resolve();
    else setImmediate(step);
  };
  step();
});
const wall = performance.now() - started;
clearInterval(ticker);
clearInterval(sseTimer);
clearInterval(walTimer);
clearInterval(flushTimer);
if (fileTimer) clearInterval(fileTimer);
clearTimeout(maintenanceTimer);
eld.disable();
await store.flushed().catch(() => {});
await new Promise((r) => setTimeout(r, 300));
const facts = store.facts();
const result = {
  config:
    "A2 (main wal_autocheckpoint=4000 ff; worker PASSIVE ff + explicit WAL fsync; dir syncs per pass)",
  rate: RATE,
  K,
  seconds: SECONDS,
  achieved: +(total / (wall / 1000)).toFixed(1),
  load1: { start: loadStart, end: load1() },
  node: process.version,
  sqlite: process.versions.sqlite,
  i_commit: { ...fmt(commits), stallsOver5ms: stalls.length, stallList: stalls.slice(0, 10) },
  ii_fileWrite: fmt(fileWrites),
  ii_bodyWrite200KiB: fmt(bodyWrites),
  iii_eventLoop: {
    eldP99: +(eld.percentile(99) / 1e6).toFixed(2),
    eldMax: +(eld.max / 1e6).toFixed(2),
    tickerLate,
    maxGap: +maxGap.toFixed(1),
  },
  sseRead: fmt(reads),
  flushed: fmt(flushes),
  walMaxMB: +(walMax / 1048576).toFixed(2),
  flusher: {
    passes: fmt(passes),
    barrier: fmt(barrierMs),
    counters: facts.flusher.counters,
    lastCheckpoint: facts.flusher.last_pass?.checkpoint ?? null,
  },
  busy_waits: facts.busy_waits,
  integrity,
};
const line = JSON.stringify(result);
console.log(line);
if (process.env.OUT) appendFileSync(process.env.OUT, `${line}\n`);
await maintenance.stop();
await store.close();
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.error(`kept ${root}`);
