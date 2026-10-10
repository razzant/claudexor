import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalHostBinding, HOST_BINDING_VERSION } from "@claudexor/schema";
import {
  CLAUDEXOR_VERSION,
  defaultUserConfigDir,
  userConfigDir,
  userHomeDir,
} from "@claudexor/util";
import { CliError } from "./cli-error.js";

export const HOST_PLUGIN_MARKER = "claudexor:managed host-plugin-lifecycle";

export interface PluginLaunchRuntime {
  configDir: string;
  nodePath: string;
  cliPath: string;
  binding?: ExternalHostBinding;
  /** Prior ledger location during an explicit host binding relocation. */
  previousConfigDir?: string;
}

export interface RuntimePaths extends PluginLaunchRuntime {
  home: string;
  backupStamp: string;
  warnings: string[];
}

export function parseHostBinding(value: unknown): ExternalHostBinding {
  const parsed = ExternalHostBinding.safeParse(value);
  if (!parsed.success || !isAbsolute(parsed.data.command[0]) || !isAbsolute(parsed.data.configDir))
    throw new CliError(
      "usage",
      "invalid external host binding: use the supported format with an absolute command and config root",
      {
        code: "host_binding_invalid",
      },
    );
  return parsed.data;
}

export function runtimePaths(binding?: ExternalHostBinding): RuntimePaths {
  const home = userHomeDir();
  const configDir = binding?.configDir ?? userConfigDir();
  const warnings: string[] = [];
  const distCli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const common = {
    home,
    configDir,
    binding,
    warnings,
    backupStamp: new Date().toISOString().replaceAll(/[:.]/g, "-"),
  };
  // A host locator owns runtime selection; never replace it with the invoking CLI.
  if (binding) return { ...common, nodePath: process.execPath, cliPath: distCli };
  const allowTestOverrides = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  const envNode = allowTestOverrides ? process.env.CLAUDEXOR_NODE_PATH?.trim() : undefined;
  const bundledNode = join(home, ".claudexor", "node", "bin", "node");
  const nodePath = envNode || (existsSync(bundledNode) ? bundledNode : process.execPath);
  if (!isAbsolute(nodePath) || !existsSync(nodePath) || !statSync(nodePath).isFile())
    throw new Error(`unable to resolve a safe Node executable for plugin MCP config: ${nodePath}`);
  if (!envNode && nodePath !== bundledNode)
    warnings.push(`using current node instead of ${bundledNode}`);
  if (!allowTestOverrides && process.env.CLAUDEXOR_NODE_PATH?.trim())
    warnings.push("ignored CLAUDEXOR_NODE_PATH outside tests");
  const envCli = allowTestOverrides ? process.env.CLAUDEXOR_CLI_PATH?.trim() : undefined;
  const argvCli =
    process.argv[1] && existsSync(resolve(process.argv[1])) ? resolve(process.argv[1]) : "";
  const cliPath = envCli || (existsSync(distCli) ? distCli : argvCli);
  if (!cliPath || !isAbsolute(cliPath) || !existsSync(cliPath) || !statSync(cliPath).isFile())
    throw new Error("unable to resolve a safe absolute claudexor CLI entrypoint");
  if (!allowTestOverrides && process.env.CLAUDEXOR_CLI_PATH?.trim())
    warnings.push("ignored CLAUDEXOR_CLI_PATH outside tests");
  return { ...common, nodePath, cliPath };
}

export function launchCommand(runtime: PluginLaunchRuntime): [string, ...string[]] {
  return runtime.binding?.command ?? [runtime.nodePath, runtime.cliPath];
}

export function generatedMcpEnv(runtime: PluginLaunchRuntime): Record<string, string> {
  const env: Record<string, string> = { CLAUDEXOR_MANAGED: HOST_PLUGIN_MARKER };
  if (runtime.binding) {
    return {
      ...env,
      CLAUDEXOR_HOST_BINDING_VERSION: String(HOST_BINDING_VERSION),
      CLAUDEXOR_DAEMON_OWNER: "external",
      CLAUDEXOR_CONFIG_DIR: runtime.binding.configDir,
      CLAUDEXOR_ROOT_MODE: "explicit",
      CLAUDEXOR_DAEMON_SOCK: "",
      CLAUDEXOR_DAEMON_ENTRY: "",
    };
  }
  env.CLAUDEXOR_PLUGIN_VERSION = CLAUDEXOR_VERSION;
  env.CLAUDEXOR_HOST_BINDING_VERSION = "";
  env.CLAUDEXOR_DAEMON_OWNER = "standalone";
  // Default roots follow the runtime; explicit standalone roots stay explicit.
  if (resolve(runtime.configDir) !== resolve(defaultUserConfigDir())) {
    env.CLAUDEXOR_CONFIG_DIR = runtime.configDir;
    env.CLAUDEXOR_ROOT_MODE = "explicit";
  }
  return env;
}

/** Read only a complete owned MCP launch, never a host's derived plugin cache. */
export function bindingFromMcpEntry(value: unknown): ExternalHostBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const env = (entry.env ?? entry.environment) as Record<string, unknown> | undefined;
  if (!env || (env.CLAUDEXOR_DAEMON_OWNER !== "external" && !env.CLAUDEXOR_HOST_BINDING_VERSION))
    return undefined;
  const command = Array.isArray(entry.command)
    ? entry.command
    : [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  if (
    env.CLAUDEXOR_MANAGED !== HOST_PLUGIN_MARKER ||
    env.CLAUDEXOR_ROOT_MODE !== "explicit" ||
    command.at(-2) !== "mcp" ||
    command.at(-1) !== "serve"
  )
    throw new CliError(
      "usage",
      "external host binding is incomplete; register it with --host-binding-json",
      { code: "host_binding_invalid" },
    );
  return parseHostBinding({
    schemaVersion: Number(env.CLAUDEXOR_HOST_BINDING_VERSION),
    command: command.slice(0, -2),
    configDir: env.CLAUDEXOR_CONFIG_DIR,
    daemonOwner: env.CLAUDEXOR_DAEMON_OWNER,
  });
}

/** Shell examples explicitly name PowerShell on Windows; statusLine wraps that script. */
export function launchShellCommand(
  runtime: PluginLaunchRuntime,
  suffix: string,
  platform: NodeJS.Platform = process.platform,
  wrap = false,
): string {
  const quote = (value: string): string =>
    platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const env = Object.entries(generatedMcpEnv(runtime));
  const argv = launchCommand(runtime).map(quote).join(" ");
  const command =
    platform === "win32"
      ? `${env.map(([key, value]) => `$env:${key}=${quote(value)};`).join(" ")} & ${argv} ${suffix}`
      : `env ${env.map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${argv} ${suffix}`;
  return platform === "win32" && wrap
    ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`
    : command;
}
