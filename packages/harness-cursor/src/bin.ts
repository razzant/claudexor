import { CURSOR_PROGRAM } from "./program.js";
import {
  resolveHarnessBinary,
  resolveSelectedProgramAsync,
  selectProgramLauncher,
} from "@claudexor/core";

/** Keep the vendor-specific alias rule in the program declaration. */
export function resolveCursorBin(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (bin: string) => string | null = (bin) => resolveHarnessBinary(bin, env),
): string {
  return selectProgramLauncher(CURSOR_PROGRAM, env, resolve);
}

/** The resolved Cursor CLI's `--version` line, or null when it cannot spawn. */
export async function detectCursorVersion(abortSignal?: AbortSignal): Promise<string | null> {
  return (await resolveSelectedProgramAsync(CURSOR_PROGRAM, { abortSignal })).versionOutput;
}
