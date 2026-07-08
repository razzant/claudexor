import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Single producer for the PATH every local harness discovery/run surface should
 * use. Surfaces may still inherit other env vars, but binary resolution must not
 * depend on whether the daemon was launched from a GUI app, login shell, or CLI.
 */
export function normalizedHarnessPath(source: NodeJS.ProcessEnv = process.env): string {
  const home = source.HOME || homedir();
  const preferred = [
    join(home, ".claudexor", "node", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const inherited = (source.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set<string>();
  return [...preferred, ...inherited]
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(":");
}

export function harnessRuntimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source, PATH: normalizedHarnessPath(source) };
}

/**
 * Advisory when the Node binary running Claudexor is one macOS's code-signing
 * monitor is known to SIGKILL (Homebrew's adhoc-signed node). The daemon spawns
 * its harness children with this same execPath, so a GUI/launchd-launched daemon
 * on at-risk node can die mid-run. Returns null when not applicable. Diagnostic
 * only (doctor surfaces it); never gates a run.
 */
export function atRiskNodeAdvisory(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") return null;
  const atRisk = execPath.includes("/Cellar/node") || execPath.startsWith("/opt/homebrew/") || execPath.startsWith("/usr/local/Cellar/");
  if (!atRisk) return null;
  return `node at ${execPath} is Homebrew-signed and may be SIGKILLed by macOS; install a notarized Node (e.g. under ~/.claudexor/node/bin) and put it first on PATH`;
}
