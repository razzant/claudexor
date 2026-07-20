import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { normalizeThroughExistingAncestor } from "@claudexor/core";
import type { AccountIdentity } from "@claudexor/schema";
import { claudexorOwnedRoot, ensureDir, userConfigDir, userHomeDir } from "@claudexor/util";

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

/**
 * DAEMON-SIDE, PURE, non-secret identity reader for a claude account (INV-067).
 *
 * Given a Claudexor-owned CLAUDE_CONFIG_DIR (a profile's isolation_locator or
 * the native `defaultNativeClaudeConfigDir`), read the account's OWN
 * `.claude.json` and project ONLY the allowlisted `{email, plan}` out of its
 * `oauthAccount`. Session tokens and every other oauthAccount field never leave
 * this function. Containment is enforced HERE: a config dir outside the
 * Claudexor-owned root (the ordinary vendor `~/.claude` above all) is refused
 * WITHOUT a read. Missing/malformed/undisclosed → `null`, never a throw.
 */
export function claudeAccountIdentity(
  configDir: string | null | undefined,
): AccountIdentity | null {
  if (!configDir || !configDir.trim() || !isWithinOwnedRoot(configDir)) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(resolve(configDir), ".claude.json"), "utf8")) as {
      oauthAccount?: unknown;
    };
    const account = parsed.oauthAccount;
    if (!account || typeof account !== "object") return null;
    const fields = account as Record<string, unknown>;
    const emailField = fields["emailAddress"];
    const email = typeof emailField === "string" && emailField.trim() ? emailField : undefined;
    const planField = fields["organizationType"];
    const plan = typeof planField === "string" && planField.trim() ? planField : undefined;
    if (email === undefined && plan === undefined) return null;
    return { ...(email !== undefined ? { email } : {}), ...(plan !== undefined ? { plan } : {}) };
  } catch {
    return null;
  }
}

/**
 * True when `dir` resolves inside the Claudexor-owned tree — the SAME
 * confinement the isolation-locator discipline uses, normalized through the
 * deepest existing ancestor so a symlinked root (/var → /private/var) matches.
 */
function isWithinOwnedRoot(dir: string): boolean {
  const owned = normalizeThroughExistingAncestor(claudexorOwnedRoot());
  const target = normalizeThroughExistingAncestor(dir);
  return target === owned || target.startsWith(owned + sep);
}
