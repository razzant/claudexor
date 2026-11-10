import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { HarnessProgram, SelectedHarnessProgram } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { interpretedCommand } from "./npm-launch.js";
import { normalizedHarnessPath, resolveHarnessCommandOnPath } from "./runtime-env.js";

/** Cursor's generic `agent` alias, for example, requires the adapter's own
 * real-path evidence. An explicit override remains the caller's exact choice. */
export function selectProgramLauncher(
  program: HarnessProgram,
  env: NodeJS.ProcessEnv,
  resolve: (name: string) => string | null,
): string {
  const override = env[program.overrideEnv];
  if (override) return override;
  for (const launcher of program.launchers) {
    const path = resolve(launcher.name);
    if (!path) continue;
    if (!launcher.realPathPattern) return launcher.name;
    try {
      if (new RegExp(launcher.realPathPattern).test(realpathSync(path))) return path;
    } catch {
      /* Missing alias target is not a selection. */
    }
  }
  return program.launchers[0]!.name;
}

export interface ProgramResolutionOptions {
  sourceEnv?: NodeJS.ProcessEnv;
  /** Exact final child environment. Its PATH, including an explicit patch, wins. */
  environment?: NodeJS.ProcessEnv;
  nodePath?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
  maskedPaths?: readonly string[];
  spawn?: typeof spawnSync;
}

/** No memo: even an unchanged wrapper can invoke a newly updated program. */
export function resolveSelectedProgram(
  program: HarnessProgram,
  options: ProgramResolutionOptions = {},
): SelectedHarnessProgram {
  const source = options.sourceEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  const env = options.environment ?? {
    ...source,
    PATH: normalizedHarnessPath(source, options.nodePath, platform),
  };
  const resolve = (name: string) =>
    resolveHarnessCommandOnPath(
      name,
      env.PATH ?? "",
      platform,
      env,
      options.cwd,
      options.maskedPaths,
    ).command;
  const bin = selectProgramLauncher(program, source, (name) => resolve(name)?.entrypoint ?? null);
  const command = resolve(bin);
  const path = command?.entrypoint ?? null;
  let realPath: string | null = null;
  let versionOutput: string | null = null;
  if (command && path) {
    try {
      realPath = realpathSync(path);
      const invocation = interpretedCommand(path, ["--version"], env, command.interpreter);
      const result = (options.spawn ?? spawnSync)(invocation.binary, invocation.args, {
        env: invocation.env,
        cwd: options.cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0 && !result.error) {
        versionOutput =
          redactSecrets(String(result.stdout ?? "").trim())
            .split(/\r?\n/)[0]
            ?.slice(0, 256) || null;
      }
    } catch {
      /* A selected but unreadable version stays unknown. */
    }
  }
  const version =
    versionOutput?.match(
      /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/,
    )?.[1] ?? versionOutput;
  const overrideValue = source[program.overrideEnv] || null;
  return {
    path,
    realPath,
    version,
    versionOutput,
    overrideEnv: overrideValue ? program.overrideEnv : null,
    overrideValue,
  };
}
