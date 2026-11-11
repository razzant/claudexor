import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort } from "node:worker_threads";

// Counts bytes the detail job reads from events.jsonl through node:fs, so the
// same assertion runs against any reader implementation (no product API).
const reads = { bytes: 0, opens: 0 };
const files = new Set();
const { openSync, readSync, closeSync } = fs;
fs.openSync = function (path, ...rest) {
  const fd = openSync.call(this, path, ...rest);
  if (String(path).endsWith("events.jsonl")) {
    files.add(fd);
    reads.opens++;
  }
  return fd;
};
fs.readSync = function (fd, ...rest) {
  const read = readSync.call(this, fd, ...rest);
  if (files.has(fd)) reads.bytes += read;
  return read;
};
fs.closeSync = function (fd) {
  files.delete(fd);
  return closeSync.call(this, fd);
};
syncBuiltinESMExports();

let active;
// Registered before the real worker's listener, as in timeline-work-counter.mjs.
parentPort.on("message", (message) => {
  if (message.type === "run" && message.job.kind === "detail")
    active = { id: message.id, bytes: reads.bytes, opens: reads.opens };
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer) => {
  if (active?.id === message.id && ["result", "failed"].includes(message.type)) {
    // No `id`: the executor ignores it; it precedes the receipt on the same port.
    post({
      type: "test:event-reads",
      reads: { bytes: reads.bytes - active.bytes, opens: reads.opens - active.opens },
    });
    active = undefined;
  }
  post(message, transfer);
};
await import("../../dist/bulk-worker.js");
