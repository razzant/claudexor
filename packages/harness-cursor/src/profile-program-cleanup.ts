import { lstatSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { hideProgramPaths, type HarnessAdapter } from "@claudexor/core";
import { canonicalCursorProfileHome } from "./profile.js";

const within = (path: string | null, root: string) =>
  path !== null && (path === root || path.startsWith(root + sep));
const stat = (path: string) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const same = (a: ReturnType<typeof stat>, b: ReturnType<typeof stat>) =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
const hiddenCopy = (root: string) => join(dirname(root), ".cursor-agent.claudexor-hidden");

/** Explicit maintenance only: hide one enumerated copy, observe through the
 * resolver, restore dependencies or retire unused bytes. No launcher classifier. */
export const planCursorProfileProgramCleanup: NonNullable<
  HarnessAdapter["planProfileProgramCleanup"]
> = (profiles, selected, options = {}) => {
  const limitations: string[] = [];
  const plans: Array<{
    root: string;
    hidden: string;
    recovered: boolean;
    directory: NonNullable<ReturnType<typeof stat>>;
    links: Array<{ path: string; before: NonNullable<ReturnType<typeof stat>> }>;
  }> = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (profile.harness_id !== "cursor" || !profile.isolation_locator) continue;
    try {
      const home = canonicalCursorProfileHome(profile.isolation_locator);
      if (seen.has(home)) continue;
      seen.add(home);
      const root = join(home, ".local/share/cursor-agent"),
        hidden = hiddenCopy(root);
      const recovered = stat(hidden) !== null;
      if (options.recoverOnly && !recovered) continue;
      const directory = stat(recovered ? hidden : root);
      if (!directory) continue;
      if (recovered && stat(root))
        throw new Error(`Both ${root} and its hidden copy exist; preserved both.`);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        realpathSync(dirname(root)) !== dirname(root)
      )
        throw new Error(`Preserved ${root}: the profile program directory is redirected.`);
      if (!recovered && (within(selected.path, root) || within(selected.realPath, root))) {
        limitations.push(`Preserved ${root}: the profile copy is in use by the selected program.`);
        continue;
      }
      const links: (typeof plans)[number]["links"] = [];
      const bin = join(home, ".local/bin");
      if (stat(bin) && realpathSync(bin) === bin)
        for (const name of ["agent", "cursor-agent", "cursor"]) {
          const path = join(bin, name),
            before = stat(path);
          if (before?.isSymbolicLink() && within(resolve(bin, readlinkSync(path)), root))
            links.push({ path, before });
        }
      plans.push({ root, hidden, recovered, directory, links });
    } catch (error) {
      limitations.push(
        `Cursor profile program cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    paths: plans.flatMap((p) => [...p.links.map((t) => t.path), p.recovered ? p.hidden : p.root]),
    limitations,
    execute(observe) {
      const removed: string[] = [],
        limitations: string[] = [];
      for (const plan of plans) {
        let hidden: ReturnType<typeof hideProgramPaths> | undefined;
        try {
          const current = observe();
          if (
            !plan.recovered &&
            (within(current.path, plan.root) || within(current.realPath, plan.root))
          )
            throw new Error("the profile copy is in use by the selected program");
          const unchanged = (path: string, before: NonNullable<ReturnType<typeof stat>>) => {
            if (realpathSync(dirname(path)) !== dirname(path) || !same(stat(path), before))
              throw new Error(`path changed after inspection: ${path}`);
          };
          unchanged(plan.recovered ? plan.hidden : plan.root, plan.directory);
          for (const link of plan.links) unchanged(link.path, link.before);
          hidden = hideProgramPaths([{ path: plan.root, hidden: plan.hidden }]);
          const without = observe();
          if (
            !without.path ||
            !without.version ||
            (!plan.recovered &&
              (without.path !== current.path || without.realPath !== current.realPath))
          )
            throw new Error(
              "the profile copy is in use: the selected program does not answer without it",
            );
          unchanged(plan.hidden, plan.directory);
          for (const link of plan.links) unchanged(link.path, link.before);
          const retired = hidden.retire();
          hidden = undefined;
          limitations.push(...retired.limitations);
          if (retired.removed.length) {
            for (const link of plan.links) {
              rmSync(link.path);
              removed.push(link.path);
            }
            removed.push(plan.recovered ? plan.hidden : plan.root);
          }
        } catch (error) {
          try {
            hidden?.restore();
          } catch (restoreError) {
            limitations.push(String(restoreError));
          }
          limitations.push(
            `Preserved remaining files under ${plan.root}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { removed, limitations };
    },
  };
};
