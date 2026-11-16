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

/** A null version alone cannot distinguish a missing CLI from an unanswered or
 * refused probe. Discovery and doctor must preserve that uncertainty. */
export const CURSOR_VERSION_UNAVAILABLE =
  "Cursor CLI is missing or did not answer the version probe with automatic updates disabled (`--disable-auto-update --version`). Check the selected Cursor CLI or set CLAUDEXOR_CURSOR_BIN.";

/** The resolved Cursor CLI's protected `--version` line; null also covers a
 * failed, timed-out or empty answer, not only an absent executable. */
export async function detectCursorVersion(abortSignal?: AbortSignal): Promise<string | null> {
  return (await resolveSelectedProgramAsync(CURSOR_PROGRAM, { abortSignal })).versionOutput;
}
