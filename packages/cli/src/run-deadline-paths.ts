import { join } from "node:path";
import { RUN_SCOPE_INDEX_FILE } from "./run-scope-index.js";

/** run-deadline/1 state files in the daemon directory, and the run-scope index their wardens read. */
export function runDeadlineOptions(daemonDir: string): { dir: string; runScopesPath: string } {
  return {
    dir: join(daemonDir, "run-deadlines"),
    runScopesPath: join(daemonDir, RUN_SCOPE_INDEX_FILE),
  };
}
