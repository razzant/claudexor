import { lstatSync } from "node:fs";
import { join } from "node:path";

/** A run whose files retention reclaimed: its directory keeps only `tombstone.yaml`. */
export function runFilesExpired(runDir: string): boolean {
  try {
    lstatSync(join(runDir, "tombstone.yaml"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
