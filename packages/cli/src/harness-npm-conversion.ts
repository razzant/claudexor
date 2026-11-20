import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hideProgramPaths,
  programUpdateAvailable,
  managedNodeRoot,
  npmGlobalPackagesDir,
  resolveHarnessCommandOnPath,
  resolveSelectedProgram,
  selectProgramEntry,
  verifyProgramSelection,
} from "@claudexor/core";
import type { HarnessProgram, SelectedHarnessProgram } from "@claudexor/schema";
import type { InstallerRuntime } from "./harness-install-runtime.js";

interface PackageSource {
  directory: string | null;
  manifest: Buffer;
  entries: Array<{ path: string; identity: string }>;
}

export interface ProductNpmCopy {
  packageRoot: string;
  launchers: string[];
  entrypoints: string[];
  source: PackageSource;
}
const prefixes = (runtime: InstallerRuntime) => [
  managedNodeRoot(runtime.home),
  join(runtime.home, ".claudexor/remote/vendor"),
];
const hiddenPackage = (path: string) => `${path}.claudexor-converted`;
function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/** Windows can refuse to rename a folder while a file inside it is open. */
const WINDOWS_HIDE_REFUSALS = new Set(["EPERM", "EACCES", "EBUSY"]);
const WINDOWS_HIDE_WAIT_MS = 2_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const refusedRenameCode = (error: unknown) => {
  const { syscall, code } = (error ?? {}) as NodeJS.ErrnoException;
  return syscall === "rename" && code && WINDOWS_HIDE_REFUSALS.has(code) ? code : null;
};
const directoryIdentity = (path: string) => {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() ? `dev ${stat.dev} ino ${stat.ino}` : null;
  } catch {
    return null;
  }
};

// Track only proven, package-relative targets: the parent can move even
// though an absolute symlink launcher no longer resolves after the hide.
function packageEntries(root: string, paths: string[]): PackageSource["entries"] {
  return paths.map((path) => {
    const stat = lstatSync(join(root, path), { bigint: true });
    if (!stat.isFile()) throw new Error(`The npm entry ${path} is not a regular file`);
    return {
      path,
      identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
    };
  });
}

const shownCopy = ({ packageRoot, launchers, entrypoints }: ProductNpmCopy) =>
  JSON.stringify({ packageRoot, launchers, entrypoints });

function packageChange(before: PackageSource, after: PackageSource): string | null {
  if (!before.directory || before.directory !== after.directory)
    return `the npm package directory could not be reverified (before ${before.directory}, now ${after.directory ?? "unknown"})`;
  if (!before.manifest.equals(after.manifest)) return "the npm package manifest changed";
  for (const [i, entry] of before.entries.entries()) {
    const current = after.entries[i];
    if (current?.path !== entry.path || current.identity !== entry.identity)
      return `the npm entry ${entry.path} changed`;
  }
  return null;
}

const sourceChanged = (message: string, cause?: unknown) =>
  Object.assign(new Error(message, { cause }), { code: "conversion_source_changed" });

/** Retry only the Windows forward rename. The deadline admits new attempts;
 * it does not bound an in-progress filesystem call or wake-up latency. */
function hidePackage(
  packageRoot: string,
  platform: NodeJS.Platform,
  limitations: string[],
  changed: () => string | null,
): ReturnType<typeof hideProgramPaths> {
  const sibling = hiddenPackage(packageRoot);
  const paths = [{ path: packageRoot, hidden: sibling }];
  let attempts = 0;
  const countRename = () => {
    attempts++;
  };
  // The shared helper also resumes a hide that already sits at the sibling, as
  // explicit recovery needs. On any platform conversion keeps a handle only for
  // a rename it made; otherwise those bytes are not its to restore or prune.
  const ownHide = (hidden: ReturnType<typeof hideProgramPaths>) => {
    if (!attempts)
      throw sourceChanged(
        `The npm package path ${packageRoot} is absent and ${sibling} already exists, but this conversion did not hide it; that sibling is left untouched and conversion removed nothing`,
      );
    return hidden;
  };
  if (platform !== "win32") return ownHide(hideProgramPaths(paths, countRename));
  try {
    return ownHide(hideProgramPaths(paths, countRename));
  } catch (error) {
    const code = attempts ? refusedRenameCode(error) : null;
    if (!code) throw error;
    const started = performance.now();
    const deadline = started + WINDOWS_HIDE_WAIT_MS;
    const checkDeadline = () => {
      if (performance.now() >= deadline) throw error;
    };
    const beginRetry = () => {
      checkDeadline();
      countRename();
    };
    const changedWhileWaiting = (detail: string) =>
      sourceChanged(
        `While waiting to retry the refused hide (${code}), ${detail}; conversion removed nothing`,
        error,
      );
    try {
      for (let pause = 50; ; pause = Math.min(pause * 2, 400)) {
        const left = deadline - performance.now();
        if (left <= 0) throw error;
        Atomics.wait(sleepCell, 0, 0, Math.min(pause, left));
        checkDeadline();
        const difference = changed();
        if (difference) throw changedWhileWaiting(difference);
        checkDeadline();
        const previousAttempts = attempts;
        try {
          // Enforce the deadline again after the source proof and sibling check.
          const hidden = hideProgramPaths(paths, beginRetry);
          if (attempts === previousAttempts)
            throw changedWhileWaiting(`${packageRoot} disappeared and ${sibling} is occupied`);
          return hidden;
        } catch (again) {
          if (attempts === previousAttempts || !refusedRenameCode(again)) throw again;
        }
      }
    } finally {
      limitations.push(
        `Windows npm conversion: first rename error ${code}; ${attempts} attempts; elapsed ${Math.round(performance.now() - started)} ms.`,
      );
    }
  }
}

/** A package and its bin relation prove conversion, never folder containment
 * alone. A hand-placed wrapper beside stale package metadata is not ours. */
export function productNpmCopy(
  program: HarnessProgram,
  selected: SelectedHarnessProgram,
  runtime: InstallerRuntime,
): ProductNpmCopy | null {
  if (!program.legacyNpmPackage || !selected.realPath) return null;
  for (const prefix of prefixes(runtime)) {
    const packageRoot = join(
      npmGlobalPackagesDir(prefix, runtime.platform),
      program.legacyNpmPackage,
    );
    try {
      const directory = directoryIdentity(packageRoot);
      if (!directory) continue;
      const realRoot = realpathSync(packageRoot);
      if (!inside(realpathSync(prefix), realRoot)) continue;
      const manifest = readFileSync(join(packageRoot, "package.json"));
      const pkg = JSON.parse(manifest.toString("utf8")) as {
        name?: string;
        bin?: string | Record<string, unknown>;
      };
      if (pkg.name !== program.legacyNpmPackage) continue;
      const bins =
        typeof pkg.bin === "string" ? { [pkg.name.split("/").at(-1)!]: pkg.bin } : pkg.bin;
      if (!bins || typeof bins !== "object") continue;
      const launchers: string[] = [];
      const entrypoints: string[] = [];
      for (const [name, value] of Object.entries(bins)) {
        if (typeof value !== "string" || name.includes("/") || name.includes("\\")) continue;
        const entry = realpathSync(resolve(packageRoot, value));
        if (!inside(realRoot, entry)) continue;
        const launcher =
          runtime.platform === "win32" ? join(prefix, `${name}.cmd`) : join(prefix, "bin", name);
        const command = resolveHarnessCommandOnPath(
          launcher,
          runtime.environment.PATH ?? "",
          runtime.platform,
          runtime.environment,
        ).command;
        if (!command || realpathSync(command.entrypoint) !== entry) continue;
        launchers.push(launcher);
        entrypoints.push(entry);
      }
      if (entrypoints.includes(selected.realPath) && launchers.length)
        return {
          packageRoot,
          launchers,
          entrypoints,
          source: {
            directory,
            manifest,
            entries: packageEntries(
              realRoot,
              entrypoints.map((entry) => relative(realRoot, entry)),
            ),
          },
        };
    } catch {
      /* Missing, escaping or unrelated metadata proves no ownership. */
    }
  }
  return null;
}

/** Hide only proven old launchers; no process-wide PATH edit or on-disk change. */
export function replacementProgram(
  program: HarnessProgram,
  copy: ProductNpmCopy,
  runtime: InstallerRuntime,
  limitations: string[] = [],
): SelectedHarnessProgram {
  const selected = verifyProgramSelection(
    () =>
      resolveSelectedProgram(program, {
        ...runtime,
        maskedPaths: [...copy.launchers, ...copy.entrypoints],
      }),
    limitations,
  );
  if (
    program.majorVersion &&
    selected.version &&
    Number(selected.version.split(".")[0]) !== program.majorVersion
  )
    throw Object.assign(
      new Error(
        `The replacement found first at ${selected.path} reports ${selected.version}; ${program.id} requires ${program.majorVersion}.x (#668). Conversion removed nothing.`,
      ),
      { code: "conversion_unsupported_major" },
    );
  return selected;
}

/** The vendor copy must already answer. Promotion is reversible until normal
 * resolution proves it. Old bytes are pruned only after that commit point. */
export function retireProductNpmCopy(
  program: HarnessProgram,
  copy: ProductNpmCopy,
  runtime: InstallerRuntime,
  previous: SelectedHarnessProgram,
  limitations: string[] = [],
): { selection: SelectedHarnessProgram; limitations: string[] } {
  const observe = () =>
    verifyProgramSelection(() => resolveSelectedProgram(program, runtime), limitations);
  const expected = replacementProgram(program, copy, runtime, limitations);
  if (!expected.path || !expected.version)
    throw Object.assign(
      new Error(
        "Vendor installation did not produce a selected program with a version while the old npm launcher was masked; conversion removed nothing",
      ),
      { code: "conversion_verification_failed" },
    );
  const refuseOlder = (selected: SelectedHarnessProgram, context: string) => {
    if (programUpdateAvailable(program.versionScheme, expected.version, selected.version) === "yes")
      throw Object.assign(
        new Error(
          `${context}, ${expected.path} version ${expected.version} is found first and is older than the selected ${selected.version}; the installer's copy may be hidden behind it. Conversion removed nothing.`,
        ),
        { code: "conversion_older_program" },
      );
  };
  refuseOlder(previous, "After the installer");
  const ordinary = observe();
  const matches = (value: SelectedHarnessProgram) =>
    value.path === expected.path &&
    value.realPath === expected.realPath &&
    value.version === expected.version;
  // A boundary failure names exactly the values it compared.
  const shown = ({ path, realPath, version }: SelectedHarnessProgram) =>
    JSON.stringify({ path, realPath, version });
  const absent = (path: string) => {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  };
  // Some vendor installers remove the npm package themselves. Do not accuse
  // them of changing the source when ordinary resolution already proves health.
  if (matches(ordinary) && [copy.packageRoot, ...copy.launchers].some(absent))
    return { selection: ordinary, limitations };
  const current = productNpmCopy(program, ordinary, runtime);
  if (!current || shownCopy(current) !== shownCopy(copy))
    throw sourceChanged(
      `The old package/launcher relation changed during conversion: before ${shownCopy(copy)}, now ${current ? shownCopy(current) : "no proven relation"} for the ordinary selection ${shown(ordinary)}; conversion removed nothing`,
    );
  const beforeHide = packageChange(copy.source, current.source);
  if (beforeHide)
    throw sourceChanged(`At ${copy.packageRoot}, ${beforeHide}; conversion removed nothing`);
  // The npm entry can report a newer version than it did before the installer.
  refuseOlder(ordinary, "With the old npm launcher masked");
  // Leave the proven launchers in place while their package is hidden. Their
  // targets become unresolvable; one fixed package sibling is enough to recover.
  const launchers = copy.launchers.map((path) => ({ path, before: lstatSync(path) }));
  const changes = ({ path, before }: (typeof launchers)[number]) => {
    const after = lstatSync(path);
    return (["dev", "ino", "mtimeMs", "size"] as const)
      .filter((field) => before[field] !== after[field])
      .map((field) => `${field} ${before[field]} → ${after[field]}`);
  };
  const unchanged = (launcher: (typeof launchers)[number]) => changes(launcher).length === 0;
  // A refused Windows hide re-reads these facts without asking any version.
  const located = ({ path, realPath }: Pick<SelectedHarnessProgram, "path" | "realPath">) =>
    JSON.stringify({ path, realPath });
  const hidden = hidePackage(copy.packageRoot, runtime.platform, limitations, () => {
    for (const launcher of launchers) {
      const fields = changes(launcher);
      if (fields.length) return `the npm launcher ${launcher.path} changed (${fields.join(", ")})`;
    }
    const now = selectProgramEntry(program, runtime).observed;
    if (located(now) !== located(ordinary))
      return `the ordinary selection moved from ${located(ordinary)} to ${located(now)}`;
    const relation = productNpmCopy(program, now, runtime);
    if (!relation || shownCopy(relation) !== shownCopy(copy))
      return `the package/launcher relation is now ${relation ? shownCopy(relation) : "no proven relation"}`;
    const difference = packageChange(copy.source, relation.source);
    if (difference) return `at ${copy.packageRoot}, ${difference}`;
    const masked = [...copy.launchers, ...copy.entrypoints];
    const replacement = selectProgramEntry(program, { ...runtime, maskedPaths: masked }).observed;
    if (located(replacement) !== located(expected))
      return `the masked selection moved from ${located(expected)} to ${located(replacement)}`;
    return null;
  });
  let selection: SelectedHarnessProgram;
  try {
    selection = observe();
    if (!matches(selection))
      throw new Error(
        `Selection changed before conversion committed: expected ${shown(expected)}, observed ${shown(selection)}`,
      );
    for (const launcher of launchers) {
      const fields = changes(launcher);
      if (fields.length)
        throw new Error(
          `An npm launcher changed before conversion committed: ${launcher.path} (${fields.join(", ")})`,
        );
    }
    const root = hiddenPackage(copy.packageRoot);
    let difference: string | null;
    try {
      difference = packageChange(copy.source, {
        directory: directoryIdentity(root),
        manifest: readFileSync(join(root, "package.json")),
        entries: packageEntries(
          root,
          copy.source.entries.map(({ path }) => path),
        ),
      });
    } catch (error) {
      throw sourceChanged(`The hidden npm package at ${root} could not be reverified`, error);
    }
    if (difference) throw sourceChanged(`Before conversion committed at ${root}, ${difference}`);
    if (!absent(copy.packageRoot))
      throw sourceChanged(`The npm package path ${copy.packageRoot} was reoccupied before pruning`);
  } catch (error) {
    try {
      hidden.restore();
    } catch (restoreError) {
      // Keep the commit-point failure. The package stays at its fixed hidden
      // sibling. The next explicit maintenance tries to restore or retire it,
      // and restoring never overwrites a path that something occupies again.
      const text = (value: unknown) => (value instanceof Error ? value.message : String(value));
      const code = (error as { code?: unknown } | null)?.code;
      throw Object.assign(
        new Error(
          `${text(error)}; the old npm package could not be restored (${text(restoreError)}) and remains hidden at ${hiddenPackage(copy.packageRoot)}; the next explicit maintenance attempts to recover it without overwriting anything at ${copy.packageRoot}`,
          { cause: error },
        ),
        typeof code === "string" ? { code } : {},
      );
    }
    throw error;
  }
  const retired = hidden.retire();
  limitations.push(...retired.limitations);
  for (const launcher of retired.removed.length ? launchers : []) {
    try {
      if (!unchanged(launcher)) throw new Error("launcher changed");
      // Pruning may take time, and npm can reuse an unchanged launcher.
      if (!absent(copy.packageRoot))
        throw new Error(`the npm package path is occupied at ${copy.packageRoot}`);
      rmSync(launcher.path);
    } catch (error) {
      limitations.push(
        `Retired old npm package; launcher could not be removed at ${launcher.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { selection, limitations };
}

/** Resume a killed conversion on explicit maintenance only. Restore the fixed
 * package sibling, then use the same own-version/line/ordering proof to retire
 * it, or leave the restored copy intact. No journal or startup sweep. */
export async function recoverProductNpmCopies(
  program: HarnessProgram,
  runtime: InstallerRuntime,
  acknowledge: (path: string) => Promise<void>,
): Promise<{ changed: boolean; limitations: string[] }> {
  let changed = false;
  const limitations: string[] = [];
  if (!program.legacyNpmPackage) return { changed, limitations };
  for (const prefix of prefixes(runtime)) {
    const root = join(npmGlobalPackagesDir(prefix, runtime.platform), program.legacyNpmPackage);
    const hidden = hiddenPackage(root);
    try {
      let stat;
      try {
        stat = lstatSync(hidden);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        !stat.isDirectory() ||
        !inside(realpathSync(prefix), realpathSync(dirname(root))) ||
        !inside(realpathSync(prefix), realpathSync(hidden)) ||
        JSON.parse(readFileSync(join(hidden, "package.json"), "utf8")).name !==
          program.legacyNpmPackage
      )
        throw new Error("hidden package identity is not proven");
      await acknowledge(hidden);
      hideProgramPaths([{ path: root, hidden }]).restore();
      changed = true;
      const previous = verifyProgramSelection(
        () => resolveSelectedProgram(program, runtime),
        limitations,
      );
      const copy = productNpmCopy(program, previous, runtime);
      if (!copy || copy.packageRoot !== root)
        throw new Error("restored package/launcher relation is not selected");
      retireProductNpmCopy(program, copy, runtime, previous, limitations);
      limitations.push(`Retired interrupted npm conversion at ${root}.`);
    } catch (error) {
      limitations.push(
        `Npm conversion recovery at ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { changed, limitations };
}
