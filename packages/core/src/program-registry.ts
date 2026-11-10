import { HarnessProgram } from "@claudexor/schema";
import { homedir } from "node:os";
import { join } from "node:path";

const programs = new Map<string, HarnessProgram>();

/** Called by each adapter's declaration, never by a second vendor table. */
export function defineHarnessProgram(value: HarnessProgram): HarnessProgram {
  const program = HarnessProgram.parse(value);
  programs.set(program.id, program);
  return program;
}

export function registeredHarnessPrograms(): HarnessProgram[] {
  return [...programs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function programPlatform(program: HarnessProgram, platform: NodeJS.Platform) {
  return program.platforms[platform as keyof HarnessProgram["platforms"]];
}

export function programPath(template: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return template
    .replaceAll("{home}", home)
    .replaceAll("{localAppData}", env.LOCALAPPDATA || join(home, "AppData", "Local"));
}

export function programLauncherDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return registeredHarnessPrograms().flatMap((program) =>
    (programPlatform(program, platform)?.launcherDirs ?? []).map((path) => programPath(path, env)),
  );
}
