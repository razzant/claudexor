import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { checkName, checkRuntimeUpdate, releaseStats } from "./release.js";

/**
 * `claudexor release <sub>` dispatch, kept out of cli.ts so the top-level
 * switch stays thin (complexity ratchet). Three read-only subcommands:
 *   check-name <name>  naming gate across public registries
 *   check              engine-runtime update check (M7 D22 — same manifest the
 *                      macOS app auto-updater reads; npm users update via npm)
 *   stats              owner-facing install counter (M7 D23 — GitHub asset
 *                      download counts + the npm downloads API; no telemetry)
 */
export async function releaseCommand(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args._[1];

  if (sub === "check-name") {
    const name = args._[2] ?? "claudexor";
    const checks = await checkName(name);
    if (json) {
      printJson({ name, checks });
    } else {
      print(`naming gate for "${name}":`);
      for (const c of checks) {
        const tag =
          c.availability === "free"
            ? "[free]   "
            : c.availability === "taken"
              ? "[taken]  "
              : "[unknown]";
        print(`  ${tag} ${c.registry}: ${c.detail}`);
      }
    }
    return 0;
  }

  if (sub === "check") {
    const check = await checkRuntimeUpdate();
    if (json) {
      printJson(check);
    } else if (check.source === "unavailable") {
      print(`engine runtime update check unavailable: ${check.detail}`);
    } else if (check.updateAvailable) {
      print(`engine runtime ${check.latestVersion} available (running ${check.currentVersion}).`);
      if (check.notes) print(`  notes: ${check.notes}`);
      print("  The macOS app auto-updates its engine in place.");
      print("  npm installs update via `npm install -g claudexor@latest`.");
    } else {
      print(`engine runtime ${check.currentVersion} is current.`);
    }
    return 0;
  }

  if (sub === "stats") {
    const stats = await releaseStats();
    if (json) {
      printJson(stats);
    } else {
      print("install counter (owner-facing; no telemetry):");
      print(`  GitHub: ${stats.github.detail}`);
      for (const asset of stats.github.perAsset) {
        print(`    ${asset.downloads}\t${asset.name}`);
      }
      print(`  npm: ${stats.npm.detail}`);
    }
    return 0;
  }

  return printUsageError(json, "usage: claudexor release check-name <name> | check | stats");
}
