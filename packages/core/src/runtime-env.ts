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
    join(home, ".claudex", "node", "bin"),
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
