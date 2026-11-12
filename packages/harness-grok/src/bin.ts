import { GROK_PROGRAM } from "./program.js";
import {
  composeBaseEnv,
  resolveHarnessBinary,
  resolveSelectedProgramAsync,
  selectProgramLauncher,
} from "@claudexor/core";

export function resolveGrokBin(
  env: NodeJS.ProcessEnv = process.env,
  resolve: (bin: string) => string | null = (bin) => resolveHarnessBinary(bin, env),
): string {
  return selectProgramLauncher(GROK_PROGRAM, env, resolve);
}
export async function detectGrokVersion(): Promise<string | null> {
  return (
    await resolveSelectedProgramAsync(GROK_PROGRAM, {
      environment: { ...composeBaseEnv("mirror_native"), ...GROK_PROGRAM.childUpdateEnv },
    })
  ).version;
}
