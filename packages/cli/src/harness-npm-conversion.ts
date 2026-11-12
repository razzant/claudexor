import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hideProgramPaths,
  programUpdateAvailable,
  managedNodeRoot,
  npmGlobalPackagesDir,
  resolveHarnessCommandOnPath,
  resolveSelectedProgram,
  verifyProgramSelection,
} from "@claudexor/core";
import type { HarnessProgram, SelectedHarnessProgram } from "@claudexor/schema";
import type { InstallerRuntime } from "./harness-install-runtime.js";

export interface ProductNpmCopy {
  packageRoot: string;
  launchers: string[];
  entrypoints: string[];
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
      if (!lstatSync(packageRoot).isDirectory()) continue;
      const realRoot = realpathSync(packageRoot);
      if (!inside(realpathSync(prefix), realRoot)) continue;
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
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
        return { packageRoot, launchers, entrypoints };
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
        `The replacement found first at ${selected.path} reports ${selected.version}; ${program.id} requires ${program.majorVersion}.x (#668). Nothing was removed.`,
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
        "Vendor installation did not produce a selected program with a version while the old npm launcher was masked; the old copy is unchanged",
      ),
      { code: "conversion_verification_failed" },
    );
  if (programUpdateAvailable(program.versionScheme, expected.version, previous.version) === "yes")
    throw Object.assign(
      new Error(
        `After the installer, ${expected.path} version ${expected.version} is found first and is older than the selected ${previous.version}; the installer's copy may be hidden behind it. Nothing was removed.`,
      ),
      { code: "conversion_older_program" },
    );
  const ordinary = observe();
  const matches = (value: SelectedHarnessProgram) =>
    value.path === expected.path &&
    value.realPath === expected.realPath &&
    value.version === expected.version;
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
  if (!current || JSON.stringify(current) !== JSON.stringify(copy))
    throw Object.assign(
      new Error("The old package/launcher relation changed during conversion; nothing was removed"),
      { code: "conversion_source_changed" },
    );
  // Leave the proven launchers in place while their package is hidden. Their
  // targets become unresolvable; one fixed package sibling is enough to recover.
  const launchers = copy.launchers.map((path) => ({ path, before: lstatSync(path) }));
  const unchanged = ({ path, before }: (typeof launchers)[number]) => {
    const after = lstatSync(path);
    return (
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeMs === after.mtimeMs &&
      before.size === after.size
    );
  };
  const hidden = hideProgramPaths([
    { path: copy.packageRoot, hidden: hiddenPackage(copy.packageRoot) },
  ]);
  let selection: SelectedHarnessProgram;
  try {
    selection = observe();
    if (!matches(selection)) throw new Error("Selection changed before conversion committed");
    if (!launchers.every(unchanged))
      throw new Error("An npm launcher changed before conversion committed");
  } catch (error) {
    try {
      hidden.restore();
    } catch (restoreError) {
      // Keep the commit-point failure. The package stays at its fixed hidden
      // sibling, which the next explicit maintenance restores or retires.
      const text = (value: unknown) => (value instanceof Error ? value.message : String(value));
      const code = (error as { code?: unknown } | null)?.code;
      throw Object.assign(
        new Error(
          `${text(error)}; the old npm package could not be restored (${text(restoreError)}) and remains hidden at ${hiddenPackage(copy.packageRoot)} until the next explicit maintenance recovers it`,
          { cause: error },
        ),
        typeof code === "string" ? { code } : {},
      );
    }
    throw error;
  }
  const retired = hidden.retire();
  limitations.push(...retired.limitations);
  const { removed } = retired;
  if (removed.length)
    for (const launcher of launchers) {
      try {
        if (!unchanged(launcher)) throw new Error("launcher changed");
        rmSync(launcher.path);
      } catch {
        limitations.push(`Retired npm package; launcher could not be removed at ${launcher.path}`);
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
