import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { composeBaseEnv, pickAllowlistedEnv } from "@claudexor/core";
import type { HarnessProgram } from "@claudexor/schema";

export interface InstallerRuntimeOptions {
  home?: string;
  nodePath?: string;
  spawn?: typeof spawnSync;
  platform?: NodeJS.Platform;
  arch?: string;
  sourceEnv?: NodeJS.ProcessEnv;
}
export function installerRuntime(program: HarnessProgram, options: InstallerRuntimeOptions = {}) {
  const source = options.sourceEnv ?? process.env;
  const home = resolve(options.home ?? (source.HOME || source.USERPROFILE || homedir()));
  const platform = options.platform ?? process.platform;
  const runnerNodePath = resolve(options.nodePath ?? process.execPath);
  const resolutionSource: NodeJS.ProcessEnv = { ...source, HOME: home };
  const environment: NodeJS.ProcessEnv = {
    ...composeBaseEnv("clean", resolutionSource, runnerNodePath, platform),
    ...pickAllowlistedEnv(resolutionSource, program.installationEnv, platform),
    HOME: home,
    ...(platform === "win32" ? { USERPROFILE: home } : {}),
  };
  return {
    home,
    runnerNodePath,
    nodePath: runnerNodePath,
    platform,
    arch: options.arch ?? process.arch,
    sourceEnv: resolutionSource,
    environment,
    spawn: options.spawn ?? spawnSync,
  };
}
export type InstallerRuntime = ReturnType<typeof installerRuntime>;
