import { lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
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
  return resolveSelectedProgram(program, {
    ...runtime,
    maskedPaths: [...copy.launchers, ...copy.entrypoints],
  });
}

/** The vendor copy must already answer. Promotion is reversible until normal
 * resolution proves it. Old bytes are pruned only after that commit point. */
export function retireProductNpmCopy(
  program: HarnessProgram,
  copy: ProductNpmCopy,
  runtime: InstallerRuntime,
): { selection: SelectedHarnessProgram; limitations: string[] } {
  const expected = replacementProgram(program, copy, runtime);
  if (!expected.path || !expected.version)
    throw Object.assign(
      new Error(
        "Vendor installation did not produce a selected program with a version while the old npm launcher was masked; the old copy is unchanged",
      ),
      { code: "conversion_verification_failed" },
    );
  const current = productNpmCopy(program, resolveSelectedProgram(program, runtime), runtime);
  if (!current || JSON.stringify(current) !== JSON.stringify(copy))
    throw Object.assign(
      new Error("The old package/launcher relation changed during conversion; nothing was removed"),
      { code: "conversion_source_changed" },
    );
  const moved: Array<[string, string]> = [];
  let selection: SelectedHarnessProgram;
  try {
    for (const path of [...copy.launchers, copy.packageRoot]) {
      const backup = join(dirname(path), `.claudexor-converted-${randomUUID()}`);
      renameSync(path, backup);
      moved.push([path, backup]);
    }
    selection = resolveSelectedProgram(program, runtime);
    if (selection.path !== expected.path || selection.version !== expected.version)
      throw new Error("Selection changed before conversion committed");
  } catch (error) {
    for (const [path, backup] of moved.reverse()) renameSync(backup, path);
    throw error;
  }
  const limitations: string[] = [];
  for (const [, backup] of moved) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {
      limitations.push(`Converted successfully; old bytes could not be pruned at ${backup}`);
    }
  }
  return { selection, limitations };
}
