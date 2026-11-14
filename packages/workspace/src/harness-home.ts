import { join } from "node:path";
import { ensureDir, ensureDirAsync } from "@claudexor/util";

/** Shared lane/envelope layout; vendor state remains inside the scoped HOME. */
function harnessHomeDirs(home: string): Record<string, string> {
  return {
    codex_home: join(home, ".codex"),
    claude_config: join(home, ".claude"),
    cursor_config: join(home, ".cursor"),
    opencode_config: join(home, ".config", "opencode"),
    copilot_home: join(home, ".copilot"),
  };
}

export function ensureHarnessHome(home: string): Record<string, string> {
  const dirs = harnessHomeDirs(home);
  for (const dir of Object.values(dirs)) ensureDir(dir);
  return dirs;
}

/** The same layout for an envelope's lane start, created one directory at a time
 * without waiting on the main thread. */
export async function ensureHarnessHomeAsync(home: string): Promise<Record<string, string>> {
  const dirs = harnessHomeDirs(home);
  for (const dir of Object.values(dirs)) await ensureDirAsync(dir);
  return dirs;
}

export function harnessHomeEnv(
  home: string,
  dirs: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: home,
    CODEX_HOME: dirs["codex_home"] ?? join(home, ".codex"),
    CLAUDE_CONFIG_DIR: dirs["claude_config"] ?? join(home, ".claude"),
    COPILOT_HOME: dirs["copilot_home"] ?? join(home, ".copilot"),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
}
