/** Caller text of earlier continuations needs delivery proof, not merely a copied capsule. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readRunEvents } from "@claudexor/event-log";
import type { ContinuationSources } from "@claudexor/schema";
import {
  continuedTryStarted,
  readContinuationSources,
  runExecutionFacts,
} from "@claudexor/workspace";
import { readTextSafe } from "@claudexor/util";
import { steeringFromRunLog } from "./continuation-evidence-io.js";

export interface UncertainInput {
  text: string;
  runDir: string;
}

/** Reuse complete durable context; only missing text needs a new context file. */
export function completeInputPath(input: UncertainInput, currentRunDir: string): string {
  for (const runDir of [input.runDir, currentRunDir]) {
    const path = resolve(runDir, "context", "work-order.md");
    if (readTextSafe(path)?.includes(input.text)) return path;
  }
  const digest = createHash("sha256").update(input.text).digest("hex");
  const path = resolve(currentRunDir, "context", `uncertain-input-${digest}.md`);
  if (readTextSafe(path) !== input.text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.text);
  }
  return path;
}

/** Reference only: the notice tells the next process to reconcile, never replay blindly. */
export function unconfirmedContinuationInputs(sources: ContinuationSources): UncertainInput[] {
  const uncertain: UncertainInput[] = [];
  // A newer run of the chain whose process started was handed these inputs in its notice.
  let newerStarted = false;
  for (const [index, source] of sources.entries()) {
    const { events } = readRunEvents(join(source.runDir, "events.jsonl"));
    // Only a continued try (receipt joined to its own accepted start) was handed
    // the notice; a reviewer, repair or unplanned process proves nothing.
    const facts = runExecutionFacts(events);
    const startedHere = continuedTryStarted(facts);
    // A stopped run's admitted steering without delivery proof is newer than its caller text.
    // The live run's own steering is read per attempt by `uncertainInputFor`.
    if (!newerStarted && source.state !== "running") {
      uncertain.push(
        ...steeringFromRunLog(source.runDir)
          .filter((message) => message.delivery === "uncertain")
          .reverse()
          .map(({ text }) => ({ text, runDir: source.runDir })),
      );
    }
    newerStarted ||= startedHere;
    if (index === sources.length - 1 && readContinuationSources(source.runDir).length === 0)
      continue;
    const text = events.find((event) => event.type === "run.created")?.payload["prompt"];
    if (typeof text !== "string" || !text.trim()) continue;
    // Any continued first try (a fallback's included) that started proves delivery;
    // a mismatched handshake or a missing receipt leaves it unproved.
    const delivered = continuedTryStarted(facts, true);
    if (!delivered) uncertain.push({ text, runDir: source.runDir });
  }
  return uncertain;
}

/** What a first try that delivered nothing (it never started, or its handshake
 * named another session) leaves to reconcile: a successor's individual
 * undelivered callers newest first, this run's own correction included, else
 * the run's own work order. Further undelivered tries keep these references. */
export function undeliveredInputs(run: {
  runDir: string;
  runId: string;
  workOrder: string;
}): UncertainInput[] {
  const sources = readContinuationSources(run.runDir);
  return sources.length
    ? unconfirmedContinuationInputs([
        { runDir: run.runDir, runId: run.runId, state: "running" },
        ...sources,
      ])
    : [{ text: run.workOrder, runDir: run.runDir }];
}
