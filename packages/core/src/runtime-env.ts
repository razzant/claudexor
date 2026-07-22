import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { isLaunchableExecutable } from "./executable-inspection.js";

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
export function resolveHarnessBinary(
  bin: string,
  source: NodeJS.ProcessEnv = process.env,
): string | null {
  const names = binaryNameCandidates(bin, source);
  if (isAbsolute(bin)) {
    for (const name of names) if (isLaunchableExecutable(name)) return name;
    return null;
  }
  for (const dir of normalizedHarnessPath(source).split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isLaunchableExecutable(candidate)) return candidate;
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

const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"];

/**
 * Advisory explaining WHY a harness binary failed to resolve when the
 * filesystem still holds evidence of an install. The live incident this
 * guards: Homebrew's codex cask stayed registered (Caskroom dir present,
 * version pinned) while its payload and bin link had vanished, so every
 * surface dead-ended at "not found on PATH"/ENOENT with no path to repair.
 * Two evidence classes, checked in order:
 *
 *  1. an entry named like the binary exists on the harness PATH (or at the
 *     configured absolute override) but is not spawnable — dangling symlink,
 *     exec bit stripped, or a directory shadowing the name;
 *  2. nothing is on PATH at all, but a Homebrew Caskroom/Cellar dir still
 *     lists the binary as installed.
 *
 * Diagnostic only (doctor/discover append it); never gates a run and never
 * executes a package manager. Returns null when the binary resolves or when
 * there is nothing better to say than "not installed".
 */
export function brokenInstallAdvisory(
  bin: string,
  source: NodeJS.ProcessEnv = process.env,
  brewPrefixes: readonly string[] = HOMEBREW_PREFIXES,
): string | null {
  if (resolveHarnessBinary(bin, source) !== null) return null;
  const name = basename(bin);
  const names = binaryNameCandidates(bin, source);
  const candidates = isAbsolute(bin)
    ? names
    : normalizedHarnessPath(source)
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => names.map((n) => join(dir, n)));
  for (const candidate of candidates) {
    const kind = lstatKind(candidate);
    if (kind === null) continue;
    const target = kind === "symlink" ? readlinkOrNull(candidate) : null;
    const where = target === null ? candidate : `${candidate} (symlink to ${target})`;
    const how =
      kind === "symlink" && !existsSync(candidate)
        ? "its target is missing"
        : kind === "dir"
          ? "it is a directory, not a binary"
          : "it is not executable";
    const fix =
      brewRemediation(target ?? candidate, name) ??
      `reinstall ${name} or point the binary override at a working install`;
    return `${where} exists but ${how} — ${fix}`;
  }
  if (!SAFE_BREW_NAME.test(name)) return null;
  for (const prefix of brewPrefixes) {
    for (const [room, flag] of [
      ["Caskroom", " --cask"],
      ["Cellar", ""],
    ] as const) {
      const dir = join(prefix, room, name);
      if (lstatKind(dir) === "dir") {
        // An absolute override never scanned PATH, so say what was actually
        // checked instead of claiming a PATH sweep that did not happen.
        const evidence = isAbsolute(bin)
          ? `the configured override ${bin} does not exist`
          : `no runnable binary is on the harness PATH`;
        return `Homebrew still lists ${name} as installed (${dir}) but ${evidence} — broken install; run \`brew reinstall${flag} ${name}\`${isAbsolute(bin) ? " or fix the binary override" : ""}`;
      }
    }
  }
  return null;
}

function lstatKind(path: string): "symlink" | "dir" | "file" | null {
  try {
    const s = lstatSync(path);
    return s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** A copyable `brew` command is emitted only for names shaped like real
 *  Homebrew tokens: a configured override whose basename carries whitespace,
 *  quotes, or shell metacharacters must never become a pasteable command. */
const SAFE_BREW_NAME = /^[A-Za-z0-9][A-Za-z0-9@+._-]*$/;

/** Attribute a broken entry to Homebrew via its canonical payload dirs. */
function brewRemediation(pathish: string, name: string): string | null {
  if (!SAFE_BREW_NAME.test(name)) return null;
  if (pathish.includes("/Caskroom/")) return `run \`brew reinstall --cask ${name}\``;
  if (pathish.includes("/Cellar/")) return `run \`brew reinstall ${name}\``;
  return null;
}

/**
 * Advisory when the Node binary running Claudexor is one macOS's code-signing
 * monitor is known to SIGKILL (Homebrew's adhoc-signed node). The daemon spawns
 * its harness children with this same execPath, so a GUI/launchd-launched daemon
 * on at-risk node can die mid-run. Returns null when not applicable. Diagnostic
 * only (doctor surfaces it); never gates a run.
 */
export function atRiskNodeAdvisory(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  const atRisk =
    execPath.includes("/Cellar/node") ||
    execPath.startsWith("/opt/homebrew/") ||
    execPath.startsWith("/usr/local/Cellar/");
  if (!atRisk) return null;
  return `node at ${execPath} is Homebrew-signed and may be SIGKILLed by macOS; install a notarized Node (e.g. under ~/.claudexor/node/bin) and put it first on PATH`;
}
