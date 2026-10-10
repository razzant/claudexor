/** Durable predecessor addresses; custody remains authoritative in each envelope. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ContinuationSources } from "../schema/index.js";
import { retainedEnvelopeOfRun } from "./retained-envelopes.js";

const SOURCES_FILE = "context/continuation.json";

export function writeContinuationSources(runDir: string, sources: ContinuationSources): void {
  const path = join(runDir, SOURCES_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ContinuationSources.parse(sources)) + "\n");
}

export function readContinuationSources(runDir: string): ContinuationSources {
  try {
    return ContinuationSources.parse(JSON.parse(readFileSync(join(runDir, SOURCES_FILE), "utf8")));
  } catch {
    return [];
  }
}

export function retainedEnvelopeInChain(sources: ContinuationSources) {
  for (const source of sources) {
    const kept = retainedEnvelopeOfRun(source.runDir, source.runId);
    if (kept) return kept;
  }
  return null;
}
