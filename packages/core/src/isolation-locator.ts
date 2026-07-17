import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { userConfigDir } from "@claudexor/util";

/**
 * Shared locator discipline (release wave round-11): absolute, canonicalized
 * through the DEEPEST EXISTING ancestor (a nonexistent leaf under a symlinked
 * parent cannot alias a forbidden store), and CONFINED to the Claudexor-owned
 * tree — a locator inside a repository or an arbitrary user dir would put
 * credential state where git or other tools can capture it.
 *
 * The confinement root FOLLOWS the v2 root (release wave round-18 #4): under
 * an explicit CLAUDEXOR_CONFIG_DIR override that override IS the complete
 * relocatable root — a hermetic/disposable run must accept profiles inside
 * it and reject the host's real ~/.claudexor (host credential state must not
 * leak into an isolated environment). Without the override, the owned tree
 * is ~/.claudexor as before.
 */
/** Canonicalize a path through its DEEPEST EXISTING ancestor (symlinks
 * resolved), re-appending the not-yet-existing remainder — so two spellings
 * of one location (e.g. /var vs /private/var on macOS) always compare equal
 * even before the leaf exists. */
export function normalizeThroughExistingAncestor(path: string): string {
  let existing = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      tail.unshift(basename(existing));
      existing = parent;
    }
  }
  return tail.length > 0 ? join(existing, ...tail) : existing;
}

export function canonicalIsolationLocator(locator: string, label: string): string {
  if (!isAbsolute(locator)) throw new Error(`${label} must be absolute: ${locator}`);
  const dir = normalizeThroughExistingAncestor(locator);
  // Normalize the confinement root the SAME way as the locator (round-19,
  // fable checkpoint): a not-yet-created CLAUDEXOR_CONFIG_DIR under a
  // symlinked parent (/var → /private/var on macOS) would otherwise compare
  // unequal to a locator that was resolved through that symlink, and
  // false-reject a valid in-root profile.
  const owned = normalizeThroughExistingAncestor(
    process.env.CLAUDEXOR_CONFIG_DIR?.trim() ? userConfigDir() : join(homedir(), ".claudexor"),
  );
  if (dir !== owned && !dir.startsWith(owned + sep)) {
    throw new Error(`${label} must live under ${owned} (got ${dir})`);
  }
  return dir;
}
