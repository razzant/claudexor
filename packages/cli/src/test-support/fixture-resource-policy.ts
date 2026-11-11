import { join, relative, sep } from "node:path";
import type { SensitiveResourcePolicy } from "@claudexor/util";

/** Test storage can itself be under .claude or another protected ancestor.
 * Mount only owned canonical roots at a neutral prefix; the real policy still
 * classifies every inner component and canonical target. Unowned paths keep
 * their complete meaning. No production import uses this fixture. */
export function fixtureResourcePolicy(
  Policy: typeof SensitiveResourcePolicy,
  roots: readonly string[],
) {
  return new (class extends Policy {
    override classifyPath(path: string) {
      const root = roots.find((root) => path === root || path.startsWith(root + sep));
      return super.classifyPath(root ? join("fixture", relative(root, path)) : path);
    }
  })();
}
