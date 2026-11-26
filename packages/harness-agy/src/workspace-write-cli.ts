import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import {
  abortSignalFromSpec,
  assertSameProgram,
  composeSpawnEnv,
  observeHarnessProgram,
  type ProgramObservation,
} from "@claudexor/core";
import { nowIso } from "@claudexor/util";
import { AGY_BIN } from "./profile.js";
import { AGY_PROGRAM, AGY_WINDOWS_CONSOLE } from "./program.js";
import { agyWorkspaceWriteCliFacts, type AgyWorkspaceWriteCli } from "./vendor-cli-version.js";

/** The CLI facts a workspace_write run decides on, and the observation they come from. */
export type AgyWorkspaceWriteProgram = {
  facts: AgyWorkspaceWriteCli;
  observation: ProgramObservation;
};

/** The core's one observation of the program this run launches, asked with the
 * run's own environment and directory exactly as the launch asks it, so the
 * launch reuses the answer while that program is unchanged. Its version
 * process starts under agy's console policy (program.ts), like the run. */
function observeLaunchProgram(
  spec: HarnessRunSpec,
  routeEnv: Record<string, string | null | undefined>,
): Promise<ProgramObservation> {
  return observeHarnessProgram(AGY_PROGRAM, routeEnv, AGY_BIN(), {
    environment: composeSpawnEnv(spec.env_inheritance, routeEnv),
    cwd: spec.cwd,
    windowsConsole: AGY_WINDOWS_CONSOLE,
  });
}

/**
 * The CLI facts of a workspace_write run (vendor-cli-version.ts), judged on
 * the version of the program this run launches. Only an abort while observing
 * ends the run here (`completed`, null); what the facts allow is decided when
 * the run's input is prepared (run-input.ts).
 */
export async function* observeAgyWorkspaceWriteCli(
  spec: HarnessRunSpec,
  routeEnv: Record<string, string | null | undefined>,
): AsyncGenerator<HarnessEvent, AgyWorkspaceWriteProgram | null> {
  const observation = await observeLaunchProgram(spec, routeEnv);
  if (abortSignalFromSpec(spec)?.aborted) {
    yield { type: "completed", session_id: spec.session_id, ts: nowIso(), aborted: true };
    return null;
  }
  return { facts: agyWorkspaceWriteCliFacts(observation.selection?.version ?? null), observation };
}

/**
 * Immediately before launch, the same observation again: the launch reuses
 * its answer, and the run starts only when that answer is the observation its
 * version-dependent decisions were made on (the core's `assertSameProgram`).
 * A program replaced or re-read with another version meanwhile is noticed by
 * the core's own file-identity and version memory, with no watcher of its own,
 * and refuses the run before anything is sent (false, after the error and
 * `completed`). A replacement after this check is the core's launch residual.
 */
export async function* confirmAgyWorkspaceWriteProgram(
  spec: HarnessRunSpec,
  routeEnv: Record<string, string | null | undefined>,
  decided: AgyWorkspaceWriteProgram,
): AsyncGenerator<HarnessEvent, boolean> {
  const launch = await observeLaunchProgram(spec, routeEnv);
  const event = { session_id: spec.session_id, ts: nowIso() };
  if (abortSignalFromSpec(spec)?.aborted) {
    yield { type: "completed", ...event, aborted: true };
    return false;
  }
  try {
    assertSameProgram(decided.observation, launch);
    return true;
  } catch {
    const now = launch.selection?.version ?? null;
    yield {
      type: "error",
      ...event,
      error: `agy changed after this run read its version (${decided.facts.installed ?? "unknown"}; now ${now ?? "unknown"}), so nothing was sent: the run's access decisions depend on that version; start it again`,
      payload: {
        code: "agy_workspace_write_program_changed",
        installed_version: decided.facts.installed,
        launch_version: now,
      },
    };
    yield { type: "completed", ...event };
    return false;
  }
}
