import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { commandForFile, interpretedCommand, type HarnessCommand } from "./npm-launch.js";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isLaunchableExecutable } from "./executable-inspection.js";

/**
 * The directory of the Node binary Claudexor ITSELF is running on, when that
 * binary is safe to expose to a harness's inner login shell. In production this
 * is the notarized app-bundled runtime
 * (`.../Claudexor.app/Contents/Resources`); a CLI/dev daemon runs on the
 * managed `~/.claudexor/node/bin/node`. Putting this dir FIRST on the harness
 * PATH is the QA-022 fix: a vendor tool's inner `/bin/bash -lc` grandchild
 * re-sources login profiles (`path_helper`, `brew shellenv`) and would
 * otherwise resolve an ad-hoc Homebrew Node that macOS's code-signing monitor
 * SIGKILLs (`Killed: 9`). Anchoring the SAME Node the daemon already proved
 * runnable — by executing on it — lets the grandchild resolve a working Node
 * even after the login shell reshuffles PATH.
 *
 * Guarded so the prepend can never make things worse:
 *  - the path must be absolute and a spawnable regular file (the running
 *    process is itself proof the bytes launch — "self-contained/valid");
 *  - it must NOT itself be an at-risk Homebrew Node — prepending a killable
 *    Node's dir would poison the very shell we are trying to protect;
 *  - the REAL binary's dir (symlinks followed) is what we anchor — a symlinked
 *    launcher must not put the WRONG dir first on the harness PATH;
 *  - that dir must NOT be group/world-writable — prepending a dir any non-owner
 *    can write to lets a local attacker drop a malicious `node`/`bash` that then
 *    SHADOWS the system tools for every harness child.
 * Returns null when any guard fails; the guessed `preferred` entries still apply.
 */
export function managedRunnerNodeDir(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!execPath || !isAbsolute(execPath)) return null;
  if (atRiskNodeAdvisory(execPath, platform) !== null) return null;
  // realpath + regular-file + executable facts (identity-stable, bounded).
  if (!isLaunchableExecutable(execPath, platform)) return null;
  // Anchor the REAL binary's dir (follow symlinks) rather than the launcher's.
  let runnerDir: string;
  try {
    runnerDir = dirname(realpathSync(execPath));
  } catch {
    return null;
  }
  // A group/world-writable runner dir is an injection surface — skip the prepend.
  if (platform !== "win32" && dirIsGroupOrWorldWritable(runnerDir)) return null;
  return runnerDir;
}

/** True when `dir` is writable by group or other (POSIX mode & 0o022), or cannot
 *  be stat'd (an undeterminable dir is not provably safe — treat as unsafe). */
function dirIsGroupOrWorldWritable(dir: string): boolean {
  try {
    return (statSync(dir).mode & 0o022) !== 0;
  } catch {
    return true;
  }
}

/**
 * The managed toolchain root under `home`: the notarized Node distribution
 * Claudexor installs plus the pinned vendor CLI shims (`<home>/.claudexor/node`
 * — `bin/codex`, `bin/claude`, the `node` that runs them, and their
 * `lib/node_modules` payloads). ONE spelling shared by every harness PATH
 * producer.
 * Deliberately HOME-anchored, not config-dir-anchored — a
 * `CLAUDEXOR_CONFIG_DIR` override relocates the runtime root, never the
 * installed toolchain.
 */
export function managedNodeRoot(home: string): string {
  return join(home, ".claudexor", "node");
}

/**
 * Where an npm GLOBAL prefix keeps its packages — npm's own rule, spelled
 * once: `<prefix>/lib/node_modules` on POSIX, `<prefix>/node_modules` on
 * Windows (where the launcher shims land in the prefix root itself).
 */
export function npmGlobalPackagesDir(prefix: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
}

/**
 * The npm entrypoint bundled INSIDE a Node distribution, next to the runtime
 * that will execute it: `<root>/lib/node_modules/npm/bin/npm-cli.js` beside
 * `<root>/bin/node` on POSIX, `<dir>/node_modules/npm/bin/npm-cli.js` beside
 * `<dir>/node.exe` on Windows (the official zip layout). The local installer
 * runs exactly this file on exactly that Node and never an ambient PATH npm.
 */
export function embeddedNpmCli(execPath: string, platform: NodeJS.Platform): string {
  const runtimeDir = dirname(resolve(execPath));
  return platform === "win32"
    ? join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(runtimeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

/** Compatibility PATH entries for previously installed managed Codex images.
 * Standard npm installs now resolve their own declared bin through npm-launch;
 * keep this existing image location as a fallback for earlier managed installs. */
const WINDOWS_TARGET_TRIPLES = {
  x64: "x86_64-pc-windows-msvc",
  arm64: "aarch64-pc-windows-msvc",
} as const;
export type WindowsNativeArch = keyof typeof WINDOWS_TARGET_TRIPLES;

const WINDOWS_NATIVE_IMAGE_PACKAGES: Readonly<
  Record<string, (arch: WindowsNativeArch) => readonly string[]>
> = {
  // @openai/codex 0.156.1: npm's global install nests the optional platform
  // dependency under the main package's node_modules (observed on the pinned
  // macOS global install). `bin/codex.js` resolves it from that package and
  // executes `vendor/<triple>/bin/codex.exe`; Windows CI proves the real layout.
  "@openai/codex": (arch) => [
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    `codex-win32-${arch}`,
    "vendor",
    WINDOWS_TARGET_TRIPLES[arch],
    "bin",
  ],
};

export function isWindowsNativeArch(arch: string): arch is WindowsNativeArch {
  return Object.hasOwn(WINDOWS_TARGET_TRIPLES, arch);
}

/** Segments from an npm global packages dir to the package-native image dir,
 * or null when no verified Windows image layout exists for that pin/arch. */
export function windowsNativeImageSegments(
  npmPackage: string,
  arch: string,
): readonly string[] | null {
  if (!isWindowsNativeArch(arch)) return null;
  const layout = Object.hasOwn(WINDOWS_NATIVE_IMAGE_PACKAGES, npmPackage)
    ? WINDOWS_NATIVE_IMAGE_PACKAGES[npmPackage]
    : undefined;
  return layout ? layout(arch) : null;
}

/** The absolute package-native image dir inside an npm prefix on Windows. */
export function windowsNativeImageDir(
  prefix: string,
  npmPackage: string,
  arch: string,
): string | null {
  const segments = windowsNativeImageSegments(npmPackage, arch);
  return segments ? join(npmGlobalPackagesDir(prefix, "win32"), ...segments) : null;
}

/** Every verified package-native image dir under the managed toolchain root —
 * the win32 entries the harness PATH carries so a bare `codex` resolves to the
 * vendor's `codex.exe` on every local surface (doctor, login, run, quota). */
export function managedWindowsNativeImageDirs(home: string, arch: string): string[] {
  const root = managedNodeRoot(home);
  return Object.keys(WINDOWS_NATIVE_IMAGE_PACKAGES)
    .map((npmPackage) => windowsNativeImageDir(root, npmPackage, arch))
    .filter((dir): dir is string => dir !== null);
}

/**
 * Single producer for the PATH every local harness discovery/run surface should
 * use. Surfaces may still inherit other env vars, but binary resolution must not
 * depend on whether the daemon was launched from a GUI app, login shell, or CLI.
 * Existing inherited entries are never dropped (only de-duplicated); the only
 * additions are the trusted `preferred` prefixes.
 */
export function normalizedHarnessPath(
  source: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const home = source.HOME || homedir();
  const runnerDir = managedRunnerNodeDir(execPath, platform);
  const preferred = [
    ...(runnerDir ? [runnerDir] : []),
    // The disclosed SSH harness installer (`claudexor harness install`,
    // exact pinned versions) deliberately writes here. Keep this app-owned
    // prefix ahead of legacy ~/.local or managed-node shims so a successful
    // remote install cannot remain shadowed by an older vendor CLI. The remote
    // wrapper sets the marker; local runtimes never probe this remote-only path.
    ...(source.CLAUDEXOR_REMOTE_RUNTIME === "1"
      ? [join(home, ".claudexor", "remote", "vendor", "bin")]
      : []),
    join(managedNodeRoot(home), "bin"),
    ...(platform === "win32" ? [managedNodeRoot(home)] : []),
    // Windows: the managed prefix holds no image in any bin dir, only the
    // vendor's own image inside its platform package (see
    // WINDOWS_NATIVE_IMAGE_PACKAGES); that dir is the local install's launcher.
    ...(platform === "win32" ? managedWindowsNativeImageDirs(home, arch) : []),
    join(home, ".local", "bin"),
    // Cursor's vendor installer may choose this legacy vendor-owned prefix
    // instead of ~/.local/bin; discovery and execution must resolve either.
    join(home, ".cursor", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const inheritedPath =
    source.PATH ??
    (platform === "win32"
      ? Object.entries(source).find(([key]) => key.toUpperCase() === "PATH")?.[1]
      : undefined) ??
    "";
  const inherited = inheritedPath.split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  return [...preferred, ...inherited]
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(delimiter);
}

export function harnessRuntimeEnv(
  source: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    PATH: normalizedHarnessPath(source, execPath, platform),
  };
  if (!env.USER?.trim() || !env.LOGNAME?.trim()) {
    try {
      const username = userInfo().username;
      if (!env.USER?.trim()) env.USER = username;
      if (!env.LOGNAME?.trim()) env.LOGNAME = username;
    } catch {
      /* Missing OS identity is not an authentication verdict. */
    }
  }
  return env;
}

/**
 * Resolve which binary a harness child will ACTUALLY execute, using the same
 * normalized PATH the spawn layer composes. Doctor discloses this path so a
 * stale pinned shim (e.g. `~/.claudexor/node/bin/codex` shadowing a newer
 * install) is visible instead of silently answering for the wrong version.
 * Returns null when the binary is not on the harness PATH.
 *
 * `execPath`/`platform` are forwarded to `normalizedHarnessPath` (same defaults,
 * so production behavior is unchanged). Forwarding them is what lets a test
 * fully control the resolution PATH: without it the resolver always anchors the
 * REAL `process.execPath` dir (e.g. `~/.claudexor/node/bin`) first, and any
 * `claude`/`codex` living beside the running Node shadows an injected fixture —
 * the machine-specific parity failure this seam closes.
 */
export function resolveHarnessBinary(
  bin: string,
  source: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return (
    resolveHarnessCommandOnPath(bin, normalizedHarnessPath(source, execPath, platform), platform)
      .command?.entrypoint ?? null
  );
}

export interface HarnessCommandResolution {
  command: HarnessCommand | null;
  skipped: Array<{ path: string; reason: string }>;
  advisory: string | null;
}

/** Exact final PATH; never normalize a scoped HOME or replace a caller's patch. */
export function resolveHarnessCommandOnPath(
  bin: string,
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): HarnessCommandResolution {
  const names = binaryNameCandidates(bin, platform);
  // Absolute and explicitly relative paths are exact choices, not PATH searches.
  const explicit = isAbsolute(bin) || /[\\/]/.test(bin);
  const candidates = explicit
    ? [...new Set([bin, ...names])]
    : pathValue
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => names.map((name) => join(dir, name)));
  const skipped: HarnessCommandResolution["skipped"] = [];
  let command: HarnessCommand | null = null;
  for (const candidate of candidates) {
    command = commandForFile(candidate, pathValue, platform, delimiter, source);
    if (command) break;
    const kind = lstatKind(candidate);
    if (!kind) continue;
    skipped.push({
      path: candidate,
      reason:
        kind === "symlink" && !existsSync(candidate)
          ? "symlink target is missing"
          : kind === "dir"
            ? "is a directory"
            : platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)
              ? "is not a supported standard npm launcher"
              : "is not launchable",
    });
  }
  const advisory = skipped.length
    ? `${command ? `Using ${command.entrypoint}; skipped` : "Cannot launch"} ${skipped.map((item) => `${item.path} (${item.reason})`).join("; ")}`
    : null;
  return { command, skipped, advisory };
}

/** Prepare the actual OS invocation without changing the environment's authority. */
export function prepareHarnessCommand(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ReturnType<typeof interpretedCommand> & { resolution: HarnessCommandResolution } {
  const pathValue =
    env.PATH ??
    (platform === "win32"
      ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1]
      : undefined) ??
    "";
  const resolution = resolveHarnessCommandOnPath(bin, pathValue, platform, env);
  const command = resolution.command;
  if (!command && platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(bin)) {
    throw Object.assign(new Error(resolution.advisory ?? `Unsupported Windows launcher: ${bin}`), {
      code: "ENOEXEC",
    });
  }
  return {
    ...interpretedCommand(command?.entrypoint ?? bin, args, env, command?.interpreter),
    resolution,
  };
}

/**
 * Which exact bytes a harness child will execute, as a stat-only identity:
 * the realpath of the entrypoint `resolveHarnessBinary` picks, plus its inode,
 * size and mtime. Npm resolution also reads its shim and bounded script header.
 *
 * Every probe memo keyed by this identity re-reads the binary the moment it
 * changes on disk WITHOUT a daemon restart, which is what the release-free
 * model/effort discovery needs: the native installer re-points a `versions/`
 * symlink (realpath changes), an npm reinstall rewrites the file in place
 * (size/mtime change), a Homebrew upgrade moves to a new cellar dir. `ino` is
 * 0 on some Windows volumes and stays in the key only as a tie-breaker; the
 * memos' own TTLs bound what a shim layout can hide from a stat.
 *
 * Null when the binary does not resolve (nothing to spawn) or cannot be
 * stat'd (raced away between resolve and stat).
 */
export interface HarnessBinaryIdentity {
  path: string;
  ino: number;
  size: number;
  mtimeMs: number;
  launcher?: string;
  interpreter?: { path: string; ino: number; size: number; mtimeMs: number };
}

export function harnessBinaryIdentity(
  bin: string,
  source: NodeJS.ProcessEnv = process.env,
): HarnessBinaryIdentity | null {
  return identityOfCommand(resolveHarnessCommandOnPath(bin, normalizedHarnessPath(source)).command);
}

/**
 * The same identity for a child whose env patch REPLACED the PATH: the spawn
 * layer composes the normalized host PATH and then applies the caller's patch
 * verbatim, so such a child resolves the binary on the patch value alone. A
 * probe that keys its memo by identity must resolve exactly that way, or it
 * describes a different binary than the run executes.
 */
export function harnessBinaryIdentityOnPath(
  bin: string,
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): HarnessBinaryIdentity | null {
  return identityOfCommand(resolveHarnessCommandOnPath(bin, pathValue, platform).command);
}

function identityOfCommand(command: HarnessCommand | null): HarnessBinaryIdentity | null {
  if (!command) return null;
  const identity = identityOfResolved(command.entrypoint);
  if (!identity) return null;
  const interpreter = command.interpreter && identityOfResolved(command.interpreter.binary);
  return {
    ...identity,
    ...(command.launcher ? { launcher: command.launcher } : {}),
    ...(interpreter ? { interpreter } : {}),
  };
}

function identityOfResolved(resolved: string | null): HarnessBinaryIdentity | null {
  if (resolved === null) return null;
  try {
    const path = realpathSync(resolved);
    const stat = statSync(path);
    return { path, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Native images first, then a fully recognized npm shim. Script spellings are
 * resolved to their declared entrypoint and interpreter, never passed to CMD. */
const WINDOWS_IMAGE_EXTENSIONS = [".exe", ".com", ".cmd"] as const;

function binaryNameCandidates(bin: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [bin];
  if (extname(bin) !== "") return [bin];
  return WINDOWS_IMAGE_EXTENSIONS.map((ext) => bin + ext);
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
  const resolution = resolveHarnessCommandOnPath(bin, normalizedHarnessPath(source));
  if (resolution.command) return resolution.advisory;
  const name = basename(bin);
  const names = binaryNameCandidates(bin, process.platform);
  // A Windows npm install ships shims (`codex`, `codex.cmd`) and no image, so
  // the resolver correctly finds nothing; say that instead of "not installed".
  const shimNames =
    process.platform === "win32" && extname(bin) === "" ? [bin, `${bin}.cmd`, `${bin}.bat`] : [];
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
      brewRemediation(target ?? candidate) ??
      `reinstall ${name} or point the binary override at a working install`;
    return `${where} exists but ${how} — ${fix}`;
  }
  for (const dir of normalizedHarnessPath(source).split(delimiter)) {
    if (!dir) continue;
    for (const shim of shimNames) {
      if (lstatKind(join(dir, shim)) === null) continue;
      return `${join(dir, shim)} exists but is a launcher script, not a Windows executable — install the native ${name}.exe or point the binary override at one`;
    }
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

/** The brew package token is the path segment AFTER Caskroom/Cellar — a
 *  binary's name can differ from the package that ships it, and the
 *  remediation must name the package. */
function brewToken(pathish: string, room: "Caskroom" | "Cellar"): string | null {
  const marker = `/${room}/`;
  const idx = pathish.indexOf(marker);
  if (idx === -1) return null;
  const token = pathish.slice(idx + marker.length).split("/")[0] ?? "";
  return SAFE_BREW_NAME.test(token) ? token : null;
}

/** Attribute a broken entry to Homebrew via its canonical payload dirs. */
function brewRemediation(pathish: string): string | null {
  const cask = brewToken(pathish, "Caskroom");
  if (cask) return `run \`brew reinstall --cask ${cask}\``;
  const formula = brewToken(pathish, "Cellar");
  if (formula) return `run \`brew reinstall ${formula}\``;
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
