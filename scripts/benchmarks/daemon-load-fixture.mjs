/** Isolated daemon composition for daemon-load-bench.mjs; never a managed daemon. */
import { isMainThread } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHistogram } from "node:perf_hooks";
import { z } from "zod/v3";
import { DaemonStoreFacts, runtimeConcurrencyCaps } from "@claudexor/schema";
import { EngineStore } from "@fixture/store";
import { BlobFiles } from "@fixture/blobs";
import { createPartition } from "@fixture/partitions";
import { appendEvent } from "@fixture/events";
import { DaemonControlApiServer } from "@fixture/http";
import { daemonHealth } from "@fixture/health";
import { LoopFactsWindow, startLoopFacts } from "@fixture/loop";
import { measureSyncSection, syncWindows } from "../lib/daemon-load-observer.mjs";

// Worker modules embedded by the store self-start in this same bundle.
if (isMainThread) await main();

async function main() {
  const { root, token, seconds, rate } = JSON.parse(process.argv[2]);
  const store = await EngineStore.open({ daemonDir: join(root, "daemon") });
  // The base predates p99. Apply IDENTICAL observation-only instrumentation to
  // both builds, after the native COMMIT clock has stopped. No SQL/pragmas change.
  const histogram = createHistogram({ figures: 2 });
  const nativeRecord = store.recordCommit.bind(store);
  store.recordCommit = (duration, failed) => {
    syncWindows.record("store.commit", duration);
    histogram.record(Math.max(1, Math.round(duration * 1_000)));
    nativeRecord(duration, failed);
  };
  const nativeFacts = store.facts.bind(store);
  store.facts = () => {
    const facts = nativeFacts();
    for (const percentile of [50, 99]) {
      facts.commit[`p${percentile}_ms`] = histogram.count
        ? Math.min(facts.commit.max_ms, histogram.percentile(percentile) / 1_000)
        : null;
    }
    return facts;
  };
  const nativeExec = store.exec.bind(store);
  store.exec = (sql) =>
    sql === "BEGIN IMMEDIATE"
      ? measureSyncSection("store.begin_immediate", () => nativeExec(sql))
      : nativeExec(sql);
  const nativeRoll = LoopFactsWindow.prototype.roll;
  LoopFactsWindow.prototype.roll = function () {
    const window = nativeRoll.call(this);
    // Roll at the SAME boundary as the status facts, not the polling boundary.
    process.send?.({ loopWindow: syncWindows.roll(window) });
    return window;
  };
  // Only the benchmark's base status contract needs the additive percentile keys.
  DaemonStoreFacts.shape.commit = DaemonStoreFacts.shape.commit
    .unwrap()
    .unwrap()
    .extend({
      p50_ms: z.number().nullable().optional(),
      p99_ms: z.number().nullable().optional(),
    })
    .nullable()
    .optional();

  const blobs = new BlobFiles(store);
  const partitions = store.transaction(() =>
    Array.from({ length: 9 }, (_, i) => createPartition(store, i ? `project:p${i}` : "global")),
  );
  const upsert =
    store.prepare(`INSERT INTO command(id,pid,operation,state,run_id,created_at,summary,params_sha,kind)
    VALUES(?,?,'model.operation','running',?,?,?,?,'product')
    ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,params_sha=excluded.params_sha`);
  const idempotency =
    store.prepare(`INSERT OR IGNORE INTO idempotency(owner,pid,key_digest,operation,request_digest,target_id,created_at)
    VALUES('command',?,?,'model.operation',?,?,?)`);
  const records = Array.from({ length: 9 }, (_, i) => {
    const runDir = join(root, `run-${i}`);
    mkdirSync(join(runDir, "final"), { recursive: true });
    const lines = Array.from({ length: 100 }, (_, seq) =>
      JSON.stringify({
        seq: seq + 1,
        type: "model.delta",
        time: "2026-10-20T00:00:00.000Z",
        payload: { text: "synthetic output ".repeat(16) },
      }),
    );
    writeFileSync(join(runDir, "events.jsonl"), lines.join("\n") + "\n");
    return {
      id: `job-${i}`,
      runId: `run-${i}`,
      runDir,
      state: "running",
      params: { mode: "agent", prompt: "synthetic workload" },
      createdAt: "2026-10-20T00:00:00.000Z",
    };
  });
  const startedAt = Date.now();
  const caps = runtimeConcurrencyCaps({ runtime: {} });
  const activity = { active: { model: 9, non_model: 0 }, queued: { model: 0, non_model: 0 } };
  const api = new DaemonControlApiServer({
    token,
    daemon: {
      health: async () => ({
        ...daemonHealth(startedAt, 0, 9, records.length, false, "normal", caps, activity, true),
        store: store.facts(),
      }),
      list: async (query) =>
        query.id
          ? records.filter((r) => r.id === query.id || r.runId === query.id)
          : query.delegatedFromRunId
            ? []
            : records,
      status: async (id) => records.find((r) => r.id === id),
      enqueue: async () => {
        throw new Error("benchmark does not admit provider work");
      },
      cancel: async () => {
        throw new Error("benchmark does not admit provider work");
      },
    },
  });
  const address = await api.start();
  let stopLoop = () => {};
  let stopping = false;
  let timer;
  let writes = 0;
  let writeFailure = null;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    stopLoop();
    await api.stop();
    await store.close();
    process.disconnect?.();
  };
  process.on(
    "SIGTERM",
    () =>
      void shutdown().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      }),
  );
  process.on("disconnect", () => void shutdown());
  process.on("message", (message) => {
    if (message !== "start") return;
    syncWindows.reset();
    stopLoop = startLoopFacts();
    const began = performance.now();
    const body = Buffer.alloc(200 * 1024, 0x62);
    const step = () => {
      if (stopping) return;
      try {
        // Fixed work and offered rate, with bounded catch-up per event-loop turn.
        for (
          let batch = 0;
          writes < rate * seconds &&
          batch < 20 &&
          performance.now() >= began + (writes * 1_000) / rate;
          batch++
        ) {
          const i = writes++;
          const pid = partitions[i % partitions.length].pid;
          const id = `model-${Math.floor(i / 3)}`;
          const time = new Date().toISOString();
          const state = ["accepted", "running", "succeeded"][i % 3];
          body.writeUInt32LE(i, 0);
          const ref = blobs.prepareBody(
            i % 20 === 0
              ? body
              : Buffer.from(JSON.stringify({ prompt: `operation ${i}`, padding: "x".repeat(512) })),
          );
          store.transaction(() => {
            blobs.insertRow(ref);
            appendEvent(store, pid, {
              type: "command.updated",
              time,
              payload: { record: { id, state, createdAt: time } },
            });
            upsert.run(
              id,
              pid,
              `run-${i % 9}`,
              time,
              Buffer.from(JSON.stringify({ state, padding: "s".repeat(400) })),
              ref.sha256,
            );
            if (i % 3 === 0) idempotency.run(pid, `key-${i}`, `digest-${i}`, id, time);
          });
        }
        if (writes < rate * seconds) {
          timer = setTimeout(
            step,
            Math.max(0, began + (writes * 1_000) / rate - performance.now()),
          );
        } else {
          void store
            .flushed()
            .then(
              () => process.send?.({ done: true, writes, elapsedMs: performance.now() - began }),
              fail,
            );
        }
      } catch (error) {
        fail(error);
      }
    };
    const fail = (error) => {
      writeFailure = String(error);
      process.send?.({ done: true, writes, writeFailure });
    };
    step();
  });
  process.send?.({
    ready: true,
    pid: process.pid,
    ...address,
    pragmas: Object.fromEntries(
      ["wal_autocheckpoint", "checkpoint_fullfsync", "fullfsync"].map((name) => [
        name,
        store.db.prepare(`PRAGMA ${name}`).get()[name],
      ]),
    ),
  });
}
