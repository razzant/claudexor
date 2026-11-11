import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  hideProgramPaths,
  programUpdateAvailable,
  managedNodeRoot,
  npmGlobalPackagesDir,
  resolveHarnessCommandOnPath,
  resolveSelectedProgram,
} from "@claudexor/core";
import type { HarnessProgram, SelectedHarnessProgram } from "@claudexor/schema";
import type { InstallerRuntime } from "./harness-install-runtime.js";

export interface ProductNpmCopy {
  packageRoot: string;
  launchers: string[];
  entrypoints: string[];
}
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
  for (const prefix of [
    managedNodeRoot(runtime.home),
    join(runtime.home, ".claudexor/remote/vendor"),
  ]) {
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
): SelectedHarnessProgram {
  const selected = resolveSelectedProgram(program, {
    ...runtime,
    maskedPaths: [...copy.launchers, ...copy.entrypoints],
  });
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
): { selection: SelectedHarnessProgram; limitations: string[] } {
  const expected = replacementProgram(program, copy, runtime);
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
  const ordinary = resolveSelectedProgram(program, runtime);
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
    return { selection: ordinary, limitations: [] };
  const current = productNpmCopy(program, ordinary, runtime);
  if (!current || JSON.stringify(current) !== JSON.stringify(copy))
    throw Object.assign(
      new Error("The old package/launcher relation changed during conversion; nothing was removed"),
      { code: "conversion_source_changed" },
    );
  const hidden = hideProgramPaths(
    [...copy.launchers, copy.packageRoot].map((path) => ({
      path,
      hidden: join(dirname(path), `.claudexor-converted-${randomUUID()}`),
    })),
  );
  let selection: SelectedHarnessProgram;
  try {
    selection = resolveSelectedProgram(program, runtime);
    if (!matches(selection)) throw new Error("Selection changed before conversion committed");
  } catch (error) {
    hidden.restore();
    throw error;
  }
  const { limitations } = hidden.retire();
  return { selection, limitations };
}
