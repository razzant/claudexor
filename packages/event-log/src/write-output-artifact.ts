import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeText } from "@claudexor/util";

/** A failed write never publishes a partial projection. */
export function writeOutputArtifact(runDir: string, relative: string, text: string): string {
  const path = join(runDir, relative);
  const temporary = join(dirname(path), `.output-${randomUUID()}.tmp`);
  try {
    writeText(temporary, text);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return relative;
}
