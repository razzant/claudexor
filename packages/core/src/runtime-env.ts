import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

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
  const inherited = (source.PATH ?? "").split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  return [...preferred, ...inherited]
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}

export function harnessRuntimeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source, PATH: normalizedHarnessPath(source) };
}

/**
 * Resolve which binary a harness child will ACTUALLY execute, using the same
 * normalized PATH the spawn layer composes. Doctor discloses this path so a
 * stale pinned shim (e.g. `~/.claudexor/node/bin/codex` shadowing a newer
 * install) is visible instead of silently answering for the wrong version.
 * Returns null when the binary is not on the harness PATH.
 */
export function resolveHarnessBinary(bin: string, source: NodeJS.ProcessEnv = process.env): string | null {
  const names = binaryNameCandidates(bin, source);
  if (isAbsolute(bin)) {
    for (const name of names) if (isExecutableFile(name)) return name;
    return null;
  }
  for (const dir of normalizedHarnessPath(source).split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Name candidates in cmd.exe lookup order: on Windows a bare `codex` is
 * spawnable as `codex.exe`/`codex.cmd` via PATHEXT, so the resolver must try
 * those too or doctor reports null for a perfectly runnable CLI. Elsewhere the
 * name is used as-is.
 */
function binaryNameCandidates(bin: string, source: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [bin];
  const exts = (source.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = bin.toLowerCase();
  if (exts.some((e) => lower.endsWith(e.toLowerCase()))) return [bin];
  return [bin, ...exts.map((e) => bin + e)];
}

/** Spawn-faithful candidate test: a regular file the process may execute
 *  (a directory or chmod-x file on PATH must not be reported as the binary). */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
