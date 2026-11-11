import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort } from "node:worker_threads";

// Observe the actual worker owner, before any projector binds its fs imports.
// Port ordering delivers these receipts before the corresponding job result.
const read = fs.readFileSync;
fs.readFileSync = (...args) => {
  parentPort.postMessage({ type: "test:artifact-read", path: String(args[0]) });
  return read(...args);
};
syncBuiltinESMExports();
await import("../../dist/bulk-worker.js");
