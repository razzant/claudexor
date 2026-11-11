import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { readTextSafe, readFileUtf8BoundedSync } from "@claudexor/util";

export interface RunTombstone {
  run_id: string;
  deleted_at: string;
  reason: string;
}

/** The honest post-GC projection: why this run's artifacts are gone. */
export function readRunTombstone(runDir: string, maxBytes?: number): RunTombstone | null {
  let text: string | null;
  const path = join(runDir, "tombstone.yaml");
  try {
    text = maxBytes === undefined ? readTextSafe(path) : readFileUtf8BoundedSync(path, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (text === null) return null;
  try {
    const value = yamlParse(text) as Partial<RunTombstone> | null;
    return value && typeof value.run_id === "string" && typeof value.deleted_at === "string"
      ? { run_id: value.run_id, deleted_at: value.deleted_at, reason: String(value.reason ?? "") }
      : null;
  } catch {
    return null;
  }
}
