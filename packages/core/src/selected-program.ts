import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { HarnessProgram, SelectedHarnessProgram } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { interpretedCommand } from "./npm-launch.js";
import {
  normalizedHarnessPath,
  resolveHarnessCommandOnPath,
  type WindowsConsolePolicy,
} from "./runtime-env.js";
import { runCapture } from "./proc.js";

/** One launch-name/override/alias choice for runs and every program probe. */
export function selectProgramLauncher(
  program: HarnessProgram,
  env: NodeJS.ProcessEnv = process.env,
  resolve: (name: string) => string | null = (name) =>
    resolveHarnessCommandOnPath(name, normalizedHarnessPath(env), process.platform, env).command
      ?.entrypoint ?? null,
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

// Installers can update the registry PATH after this process started. Read only
// the two PATH values, only after ordinary discovery fails; never refresh the
// process environment or override an explicit binary selection.
function installedWindowsPath(env: NodeJS.ProcessEnv, spawn = spawnSync): string {
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
  const reg = join(values.get("SYSTEMROOT") ?? "C:\\Windows", "System32", "reg.exe");
  return [
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "HKCU\\Environment",
  ]
    .flatMap((key) => {
      try {
        const out = spawn(reg, ["query", key, "/v", "Path"], {
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 64 * 1024,
        });
        if (out.status !== 0) return [];
        const path = String(out.stdout).match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1];
        return path
          ? [
              path
                .replace(
                  /%([^%]+)%/g,
                  (token, name: string) => values.get(name.toUpperCase()) ?? token,
                )
                .trim()
                .split(";")
                .join(delimiter),
            ]
          : [];
      } catch {
        return [];
      }
    })
    .join(delimiter);
}

function selection(program: HarnessProgram, options: ProgramResolutionOptions) {
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
  let command = resolve(bin);
  if (!command && platform === "win32" && !source[program.overrideEnv]) {
    const added = installedWindowsPath(env, options.spawn);
    if (added) {
      env.PATH = [env.PATH, added].filter(Boolean).join(delimiter);
      command = resolve(
        selectProgramLauncher(program, source, (name) => resolve(name)?.entrypoint ?? null),
      );
    }
  }
  const path = command?.entrypoint ?? null;
  let realPath: string | null = null;
  try {
    if (path) realPath = realpathSync(path);
  } catch {
    /* raced away */
  }
  const overrideValue = source[program.overrideEnv] || null;
  const observed: SelectedHarnessProgram = {
    path,
    realPath,
    version: null,
    versionOutput: null,
    overrideEnv: overrideValue ? program.overrideEnv : null,
    overrideValue,
  };
  return { command, env, observed };
}

function withVersion(observed: SelectedHarnessProgram, output: string): SelectedHarnessProgram {
  const versionOutput = redactSecrets(output.trim()).split(/\r?\n/)[0]?.slice(0, 256) || null;
  const version =
    versionOutput?.match(
      /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$|[.,;:!?)](?![0-9A-Za-z]))/,
    )?.[1] ?? versionOutput;
  return { ...observed, versionOutput, version };
}

/** Synchronous CLI child variant. No memo: an unchanged wrapper can change its target. */
export function resolveSelectedProgram(
  program: HarnessProgram,
  options: ProgramResolutionOptions = {},
): SelectedHarnessProgram {
  const { command, env, observed } = selection(program, options);
  if (command) {
    try {
      const invocation = interpretedCommand(
        command.entrypoint,
        ["--version"],
        env,
        command.interpreter,
      );
      const result = (options.spawn ?? spawnSync)(invocation.binary, invocation.args, {
        env: invocation.env,
        cwd: options.cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.status === 0 && !result.error)
        return withVersion(observed, String(result.stdout ?? ""));
    } catch {
      /* A selected but unreadable version stays unknown. */
    }
  }
  return observed;
}

/** The same observation in daemon/adapter code without blocking its event loop. */
export async function resolveSelectedProgramAsync(
  program: HarnessProgram,
  options: Omit<ProgramResolutionOptions, "spawn"> & {
    abortSignal?: AbortSignal;
    windowsConsole?: WindowsConsolePolicy;
  } = {},
): Promise<SelectedHarnessProgram> {
  const { command, env, observed } = selection(program, options);
  if (command) {
    try {
      const result = await runCapture(command.entrypoint, ["--version"], {
        inheritEnv: "clean",
        env,
        cwd: options.cwd,
        timeoutMs: 10_000,
        abortSignal: options.abortSignal,
        windowsConsole: options.windowsConsole,
        cancelSignal: "SIGTERM",
        cancelKillDelayMs: 0,
      });
      if (result.code === 0) return withVersion(observed, result.stdout);
    } catch {
      /* Missing or failed version does not invent a version. */
    }
  }
  return observed;
}
