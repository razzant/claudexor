import { existsSync, lstatSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ensureDir, userConfigDir, userHomeDir } from "@claudexor/util";

export const CLAUDE_KEYCHAIN_BRIDGE_ENV = "CLAUDEXOR_CLAUDE_KEYCHAIN_BRIDGE";
export const CLAUDE_NATIVE_DIR_ENV = "CLAUDEXOR_CLAUDE_NATIVE_DIR";

export interface ClaudeNativeHomeOptions {
  platform?: NodeJS.Platform;
  userHome?: string;
}

/**
 * Claudexor-owned default store; ordinary ~/.claude is never used.
 *
 * The `CLAUDEXOR_CLAUDE_NATIVE_DIR` override is read from the AUTHORITATIVE run
 * env first (the exact env the claude child spawns under, threaded through
 * `claudeNativeEnv`/`probeAuthStatus`), falling back to `process.env` — reading
 * only `process.env` made the doctor/run auth probe ignore an override carried
 * in the run env and silently probe the default store (symmetry with codex's
 * defaultNativeCodexHome). The config-root containment guard still applies.
 */
export function defaultNativeClaudeConfigDir(
  env?: Record<string, string | null | undefined>,
): string {
  const override = env?.[CLAUDE_NATIVE_DIR_ENV] ?? process.env.CLAUDEXOR_CLAUDE_NATIVE_DIR;
  if (!override?.trim()) return join(userConfigDir(), "native", "claude", "default");
  const ownedRoot = resolve(userConfigDir());
  const target = resolve(override.trim());
  if (target !== ownedRoot && !target.startsWith(ownedRoot + sep)) {
    throw new Error(
      `CLAUDEXOR_CLAUDE_NATIVE_DIR must stay inside the Claudexor config root ${ownedRoot}`,
    );
  }
  return target;
}

/**
 * Give ONLY the Claude child a disposable HOME that can discover the user's
 * macOS login Keychain. The generic envelope HOME remains unbridged.
 *
 * Claude Code keys its own credential item by the exact CLAUDE_CONFIG_DIR,
 * but locates the login Keychain via HOME/Library/Keychains. A scoped HOME
 * therefore makes a valid native login look logged-out. This narrow symlink
 * bridge exposes the same OS-keychain context a normal native Claude process
 * receives without copying/exporting credentials or exposing the rest of the
 * user's HOME. The child HOME remains under the envelope and is disposed with
 * it.
 */
export function claudeNativeHomeEnv(
  base: Record<string, string | null | undefined>,
  options: ClaudeNativeHomeOptions = {},
): Record<string, string | null | undefined> {
  if (base[CLAUDE_KEYCHAIN_BRIDGE_ENV] === "ready") return base;

  const platform = options.platform ?? process.platform;
  const realHome = options.userHome ?? userHomeDir();
  const scopedHome = base.HOME?.trim();
  if (platform !== "darwin" || !scopedHome || scopedHome === realHome || !existsSync(scopedHome)) {
    return base;
  }

  const source = join(realHome, "Library", "Keychains");
  if (!existsSync(source)) {
    return { ...base, [CLAUDE_KEYCHAIN_BRIDGE_ENV]: "unavailable" };
  }

  const claudeHome = join(scopedHome, ".claudexor-claude-native");
  const library = join(claudeHome, "Library");
  const target = join(library, "Keychains");
  ensureDir(library);

  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink() || realpathSync(target) !== realpathSync(source)) {
      throw new Error(`refusing unexpected Claude Keychain bridge target: ${target}`);
    }
  } else {
    symlinkSync(source, target, "dir");
  }

  return {
    ...base,
    HOME: claudeHome,
    [CLAUDE_KEYCHAIN_BRIDGE_ENV]: "ready",
  };
}
