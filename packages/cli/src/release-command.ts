import type { ParsedArgs } from "./args.js";
import { print, printJson, printUsageError } from "./cli-io.js";
import { checkName, checkRuntimeUpdate, releaseStats } from "./release.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { handshakeControlApi } from "./live.js";

/**
 * The AUTHORITATIVE running-engine version for `release check` (QA-033a): the
 * live daemon handshake identity. A read-only check must NEVER boot a daemon,
 * so a stopped daemon returns null (engine unknown) rather than being silently
 * replaced by the CLI package version.
 */
async function resolveRunningEngineVersion(): Promise<string | null> {
  try {
    const conn = await connectDaemonIfRunning();
    if (!conn) return null;
    const { engineVersion } = await handshakeControlApi(conn.addr);
    return engineVersion;
  } catch {
    return null;
  }
}

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
    const runningEngineVersion = await resolveRunningEngineVersion();
    const check = await checkRuntimeUpdate({ runningEngineVersion });
    if (json) {
      printJson(check);
    } else if (check.source === "unavailable") {
      print(`engine runtime update check unavailable: ${check.detail}`);
    } else if (check.updateAvailable) {
      print(`engine runtime ${check.latestVersion} available. ${check.detail}.`);
      if (check.notes) print(`  notes: ${check.notes}`);
      // QA-033c: honest to what 3.1.0 ships. The macOS app offers an in-app
      // update flow; npm users update the CLI package themselves. No copy
      // claims a silent auto-install the running engine cannot perform.
      print("  The macOS app offers an engine update flow (Settings → check for updates).");
      print("  npm users update the CLI with `npm install -g claudexor@latest`.");
    } else {
      print(`${check.detail}.`);
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
        const tag = asset.appInstaller ? "install" : "tooling";
        print(`    ${asset.downloads}\t${asset.name}\t(${tag})`);
      }
      print(`  npm: ${stats.npm.detail}`);
    }
    return 0;
  }

  return printUsageError(json, "usage: claudexor release check-name <name> | check | stats");
}
