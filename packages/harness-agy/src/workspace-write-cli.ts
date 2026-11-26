import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { abortSignalFromSpec, composeSpawnEnv, observeHarnessProgram } from "@claudexor/core";
import { nowIso } from "@claudexor/util";
import { AGY_BIN } from "./profile.js";
import { AGY_PROGRAM } from "./program.js";
import { agyWorkspaceWriteCliFacts, type AgyWorkspaceWriteCli } from "./vendor-cli-version.js";

/**
 * The CLI facts of a workspace_write run (vendor-cli-version.ts), judged on
 * the version of the program this run launches: the core's one observation
 * for the run's own environment and directory, which the launch reuses. Only
 * an abort while observing ends the run here (`completed`, null); what the
 * facts allow is decided when the run's input is prepared (run-input.ts).
 */
export async function* observeAgyWorkspaceWriteCli(
  spec: HarnessRunSpec,
  routeEnv: Record<string, string | null | undefined>,
): AsyncGenerator<HarnessEvent, AgyWorkspaceWriteCli | null> {
  const abortSignal = abortSignalFromSpec(spec);
  const installed =
    (
      await observeHarnessProgram(AGY_PROGRAM, routeEnv, AGY_BIN(), {
        environment: composeSpawnEnv(spec.env_inheritance, routeEnv),
        cwd: spec.cwd,
      })
    ).selection?.version ?? null;
  if (abortSignal?.aborted) {
    yield { type: "completed", session_id: spec.session_id, ts: nowIso(), aborted: true };
    return null;
  }
  return agyWorkspaceWriteCliFacts(installed);
}
