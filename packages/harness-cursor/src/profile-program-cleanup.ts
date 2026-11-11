import { lstatSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { HarnessAdapter } from "@claudexor/core";
import { canonicalCursorProfileHome } from "./profile.js";

const within = (path: string | null, root: string) =>
  path !== null && (path === root || path.startsWith(root + sep));
const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
};
const same = (a: ReturnType<typeof stat>, b: ReturnType<typeof stat>) =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

/** Idempotent repair of the measured HOME-relative updater fault, only on an explicit Update.
 * No glob over profiles, no startup sweep, no credential/config files, no launcher guesses. */
export const planCursorProfileProgramCleanup: NonNullable<
  HarnessAdapter["planProfileProgramCleanup"]
> = (profiles, selected) => {
  const limitations: string[] = [];
  const plans: Array<{
    root: string;
    home: string;
    targets: Array<{ path: string; before: NonNullable<ReturnType<typeof stat>> }>;
  }> = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (profile.harness_id !== "cursor" || !profile.isolation_locator) continue;
    try {
      const home = canonicalCursorProfileHome(profile.isolation_locator);
      if (seen.has(home)) continue;
      seen.add(home);
      const root = join(home, ".local/share/cursor-agent");
      const directory = stat(root);
      if (!directory) continue;
      if (
        !selected.path ||
        !selected.version ||
        within(selected.path, root) ||
        within(selected.realPath, root)
      ) {
        limitations.push(
          `Preserved ${root}: it is selected or the selected program is unverified.`,
        );
        continue;
      }
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(dirname(root)) !== dirname(root)
      ) {
        limitations.push(`Preserved ${root}: the profile program directory is redirected.`);
        continue;
      }
      const targets: Array<{ path: string; before: typeof directory }> = [];
      const bin = join(home, ".local/bin");
      // Each launcher must itself be a link into this exact obsolete tree.
      if (stat(bin) && realpathSync(bin) === bin)
        for (const name of ["agent", "cursor-agent", "cursor"]) {
          const path = join(bin, name),
            before = stat(path);
          if (before?.isSymbolicLink() && within(resolve(bin, readlinkSync(path)), root))
            targets.push({ path, before });
        }
      targets.push({ path: root, before: directory });
      plans.push({ root, home, targets });
    } catch (error) {
      limitations.push(
        `Cursor profile program cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    paths: plans.flatMap((p) => p.targets.map((t) => t.path)),
    limitations,
    execute(current) {
      const removed: string[] = [],
        limitations: string[] = [];
      for (const plan of plans) {
        try {
          if (
            !current.path ||
            !current.version ||
            within(current.path, plan.root) ||
            within(current.realPath, plan.root)
          )
            throw new Error("the profile copy is selected or selection is unverified");
          if (realpathSync(dirname(plan.root)) !== dirname(plan.root))
            throw new Error("the profile program directory was redirected");
          for (const target of plan.targets) {
            if (
              realpathSync(dirname(target.path)) !== dirname(target.path) ||
              !same(stat(target.path), target.before)
            )
              throw new Error(`path changed after inspection: ${target.path}`);
          }
          for (const target of plan.targets) {
            rmSync(target.path, { recursive: target.path === plan.root });
            removed.push(target.path);
          }
        } catch (error) {
          limitations.push(
            `Preserved remaining files under ${plan.root}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { removed, limitations };
    },
  };
};
