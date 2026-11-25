import type { HarnessEvent, HarnessRunSpec } from "@claudexor/schema";
import { abortSignalFromSpec, composeSpawnEnv, observeHarnessProgram } from "@claudexor/core";
import { nowIso } from "@claudexor/util";
import { AGY_BIN } from "./profile.js";
import { AGY_PROGRAM } from "./program.js";
import { AGY_WORKSPACE_WRITE_MIN_CLI_VERSION, isAgyVersionAtLeast } from "./vendor-cli-version.js";

/**
 * Whether this run gets the session shell grant (session-policy.ts): true only
 * for a workspace_write run whose CLI is known to be new enough. A known older
 * CLI refuses the run (typed error, `completed`, null); an undetermined version
 * runs as before the grant, without it, and says so. The version is that of the
 * program this run launches: the core's one observation for the run's own
 * environment and directory, which the launch reuses.
 */
export async function* agyWorkspaceWriteShellGrant(
  spec: HarnessRunSpec,
  routeEnv: Record<string, string | null | undefined>,
): AsyncGenerator<HarnessEvent, boolean | null> {
  if (spec.access !== "workspace_write") return false;
  const abortSignal = abortSignalFromSpec(spec);
  const installed =
    (
      await observeHarnessProgram(AGY_PROGRAM, routeEnv, AGY_BIN(), {
        environment: composeSpawnEnv(spec.env_inheritance, routeEnv),
        cwd: spec.cwd,
      })
    ).selection?.version ?? null;
  const event = { session_id: spec.session_id, ts: nowIso() };
  if (abortSignal?.aborted) {
    yield { type: "completed", ...event, aborted: true };
    return null;
  }
  const meets = isAgyVersionAtLeast(installed, AGY_WORKSPACE_WRITE_MIN_CLI_VERSION);
  if (meets === false) {
    yield {
      type: "error",
      ...event,
      error: `agy workspace_write requires agy ${AGY_WORKSPACE_WRITE_MIN_CLI_VERSION} or newer for its session shell grant (installed agy is ${installed}); update agy`,
      payload: {
        code: "agy_workspace_write_version_unsupported",
        installed_version: installed,
        min_version: AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
      },
    };
    yield { type: "completed", ...event };
    return null;
  }
  if (meets === null)
    yield {
      type: "status",
      ...event,
      text: `agy workspace_write runs without the session shell grant, so headless shell commands may be refused without asking: the installed agy version could not be determined (the grant needs ${AGY_WORKSPACE_WRITE_MIN_CLI_VERSION} or newer)`,
      payload: {
        code: "agy_workspace_write_version_unknown",
        min_version: AGY_WORKSPACE_WRITE_MIN_CLI_VERSION,
      },
    };
  return meets === true;
}
