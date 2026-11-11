/** Durable predecessor addresses; custody remains authoritative in each envelope. */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fsyncDirectory } from "@claudexor/util";
import { dirname, join } from "node:path";
import { ContinuationSources } from "@claudexor/schema";
import { retainedEnvelopeOfRun } from "./retained-envelopes.js";

const SOURCES_FILE = "context/continuation.json";

export function writeContinuationSources(runDir: string, sources: ContinuationSources): void {
  const path = join(runDir, SOURCES_FILE);
  const text = JSON.stringify(ContinuationSources.parse(sources)) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readContinuationSources(
  runDir: string,
  options: { strict?: boolean } = {},
): ContinuationSources {
  try {
    return ContinuationSources.parse(JSON.parse(readFileSync(join(runDir, SOURCES_FILE), "utf8")));
  } catch (error) {
    // Absence is normal for a non-continuation. Retirement must distinguish
    // that from unreadable evidence instead of proving false non-ownership.
    if (options.strict && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`continuation references ${join(runDir, SOURCES_FILE)}: ${String(error)}`, {
        cause: error,
      });
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
