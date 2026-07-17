import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Shared locator discipline (release wave round-11): absolute, canonicalized
 * through the DEEPEST EXISTING ancestor (a nonexistent leaf under a symlinked
 * parent cannot alias a forbidden store), and CONFINED to the Claudexor-owned
 * home tree — a locator inside a repository or an arbitrary user dir would
 * put credential state where git or other tools can capture it.
 */
export function canonicalIsolationLocator(locator: string, label: string): string {
  if (!isAbsolute(locator)) throw new Error(`${label} must be absolute: ${locator}`);
  let dir = resolve(locator);
  // realpath the deepest existing ancestor, then re-append the remainder.
  let existing = dir;
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
  dir = tail.length > 0 ? join(existing, ...tail) : existing;
  let owned = join(homedir(), ".claudexor");
  try {
    owned = realpathSync(owned);
  } catch {
    /* first run: the un-resolved path is still the confinement root */
  }
  if (dir !== owned && !dir.startsWith(owned + sep)) {
    throw new Error(`${label} must live under ${owned} (got ${dir})`);
  }
  return dir;
}
