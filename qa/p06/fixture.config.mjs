// Copied to the run root in the guest, next to its unmodified src/ checkout.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Closed labels for the last checkpoint reached, not assertion outcomes.
// The runner may display only members of this vocabulary from the scratch files.
export const CHECKPOINTS = {
  307: ["scripted-run", "operations", "legacy-detail", "served-detail", "event-journal", "primary-artifact", "baseline-artifact", "enriched-artifact", "artifact-gap", "teardown"],
  697: ["setup", "operation-admission", "operation-detail", "operations", "result-receipt", "result-shape", "retryability", "detail-privacy", "failure-evidence", "idempotent-replay", "native-request", "teardown"],
};

export function fixtureCheckpoint(issue, scenario, checkpoint) {
  const dir = process.env.P06_CHECKPOINT_DIR;
  if (dir) writeFileSync(join(dir, `${issue}-${scenario}.check`), checkpoint);
}

export default {
  root: import.meta.dirname,
  test: {
    include: ["emit*.test.mjs"],
    setupFiles: ["./src/vitest.setup.ts"],
    maxWorkers: 1,
    passWithNoTests: false,
  },
};
