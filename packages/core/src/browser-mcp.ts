import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserToolSpec } from "@claudexor/schema";
import { PROVIDER_SECRET_ENV } from "./env-scope.js";

export interface BrowserMcpCommand {
  command: string;
  args: string[];
}

/** Browser is a separate egress process and must not inherit model-provider
 * credentials from the daemon. Mutate only the child environment handed in. */
export function scrubBrowserEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of PROVIDER_SECRET_ENV) delete env[name];
}

function launcherPath(): string {
  const adjacent = process.argv[1]
    ? join(dirname(process.argv[1]), "browser-mcp-runtime", "dist", "browser-mcp-launcher.js")
    : "";
  if (adjacent && existsSync(adjacent)) return adjacent;
  return join(dirname(fileURLToPath(import.meta.url)), "browser-mcp-launcher.js");
}

/** Exact local command for the pinned Browser MCP. No npx, package download,
 * version alias, or user override participates at runtime. */
export function browserMcpCommand(browser: BrowserToolSpec): BrowserMcpCommand {
  const args = [launcherPath(), "--isolated", "--caps=core,pdf"];
  if (browser.headless) args.push("--headless");
  if (browser.output_dir) args.push(`--output-dir=${browser.output_dir}`);
  return { command: process.execPath, args };
}
