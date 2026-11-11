import type {
  HarnessProgram,
  HarnessProgramIdentity,
  SelectedHarnessProgram,
} from "@claudexor/schema";
import { composeSpawnEnv } from "./env-scope.js";
import { harnessBinaryIdentityOnPath } from "./runtime-env.js";
import { resolveSelectedProgramAsync } from "./selected-program.js";

export interface ProgramObservation {
  selection: SelectedHarnessProgram | null;
  program: HarnessProgramIdentity | null;
  key: string;
}

/** One read, never memoized: unchanged wrappers can dispatch a different build. */
export async function observeHarnessProgram(
  program: HarnessProgram | undefined,
  patch?: Record<string, string | null | undefined>,
  bin?: string,
): Promise<ProgramObservation> {
  if (!program) return { selection: null, program: null, key: "no-program" };
  const environment = composeSpawnEnv("mirror_native", patch);
  const sourceEnv = {
    ...process.env,
    ...environment,
    ...(bin ? { [program.overrideEnv]: bin } : {}),
  };
  const selection = await resolveSelectedProgramAsync(program, { sourceEnv, environment });
  return {
    selection,
    program: selection.path ? { path: selection.path, version: selection.version } : null,
    key: JSON.stringify([
      selection,
      selection.path ? harnessBinaryIdentityOnPath(selection.path, environment.PATH ?? "") : null,
    ]),
  };
}

export function assertSameProgram(before: ProgramObservation, after: ProgramObservation): void {
  if (before.key !== after.key)
    throw Object.assign(
      new Error("The selected program changed during this observation; read it again."),
      { code: "program_changed_during_observation" },
    );
}
