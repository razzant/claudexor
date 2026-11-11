import { parentPort, workerData } from "node:worker_threads";

const barrier = new Int32Array(workerData.barrier);
// The fixture waits for ready before submitting any job. This listener then
// runs before the production worker's listener and blocks only detail work.
parentPort.on("message", (message) => {
  if (message.type !== "run" || message.job.kind !== "detail") return;
  Atomics.store(barrier, 0, 1);
  parentPort.postMessage({ type: "test:detail-blocked" });
  while (Atomics.load(barrier, 1) === 0) Atomics.wait(barrier, 1, 0);
  Atomics.store(barrier, 0, 2);
});

await import("../../dist/bulk-worker.js");
parentPort.postMessage({ type: "test:ready" });
