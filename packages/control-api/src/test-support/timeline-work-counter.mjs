import { parentPort } from "node:worker_threads";
import { ControlTimelineEvent } from "@claudexor/schema";
import { eventsParseCountForTests } from "../../dist/run-timeline.js";

const parse = ControlTimelineEvent.parse;
let validations = 0;
let active;
ControlTimelineEvent.parse = (...args) => {
  validations++;
  return parse(...args);
};

// Registered before the real worker's listener, with no extra product API.
parentPort.on("message", (message) => {
  if (message.type === "run" && message.job.kind === "detail") {
    active = { id: message.id, parsesBefore: eventsParseCountForTests() };
    validations = 0;
  }
});
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message, transfer) => {
  if (active?.id === message.id && ["result", "failed"].includes(message.type)) {
    // No `id`: the executor ignores test instrumentation messages. Counts
    // precede the actual receipt, preserving deterministic HTTP assertions.
    post({
      type: "test:detail-work",
      work: { validations, fileParses: eventsParseCountForTests() - active.parsesBefore },
    });
    active = undefined;
  }
  post(message, transfer);
};
await import("../../dist/bulk-worker.js");
