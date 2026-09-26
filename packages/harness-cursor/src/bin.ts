import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Which command runs the Cursor CLI.
 *
 * Cursor ships its CLI as `agent`, keeping `cursor-agent` as a second name on
 * installs that have it. `CLAUDEXOR_CURSOR_BIN` still wins, then
 * `cursor-agent` (the historical name, so existing setups resolve exactly as
 * before), then `agent`. `agent` is a generic command name that other tools
 * also install, so it is accepted only when it resolves into a Cursor install
 * (the installer links it to `…/cursor-agent/versions/<v>/cursor-agent`).
 * When nothing matches, the historical name is returned so the existing
 * "not found" diagnostics stay as they are.
 */
export function resolveCursorBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLAUDEXOR_CURSOR_BIN"];
  if (override) return override;
  if (findOnPath("cursor-agent", env["PATH"])) return "cursor-agent";
  const agent = findOnPath("agent", env["PATH"]);
  // a command name, like the other harnesses: callers resolve it on PATH
  if (agent && isCursorInstall(agent)) return "agent";
  return "cursor-agent";
}

/** First executable file named `name` on `path`, or null. */
export function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // missing, dangling, or not executable: keep looking
    }
  }
  return null;
}

/** True when `file` resolves to the binary inside a Cursor CLI install. */
export function isCursorInstall(file: string): boolean {
  try {
    const real = realpathSync(file).replaceAll("\\", "/");
    return /\/cursor-agent\/versions\/[^/]+\/cursor-agent(?:\.exe)?$/.test(real);
  } catch {
    return false;
  }
}
