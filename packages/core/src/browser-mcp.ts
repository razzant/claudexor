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

/**
 * The ONE worktree-relative directory (F4) where Claudexor collects
 * media/artifacts a harness produces FOR THE USER (browser-MCP screenshots,
 * declared media). It is claudexor-OWNED: excluded from the candidate diff so a
 * screenshot-only run reads as `noChanges` (never review-blocked) and collected
 * into the run's Evidence gallery. Conservative by construction — only this
 * exact dir is excluded, never a file-type guess, so a real code change can
 * never be silently dropped from review.
 */
export const CLAUDEXOR_ARTIFACT_DIR = ".claudexor-artifacts";

/** The browser-MCP screenshot output subdir under the owned artifact dir. */
export const CLAUDEXOR_BROWSER_ARTIFACT_SUBDIR = "browser";

/** Exact local command for the pinned Browser MCP. No npx, package download,
 * version alias, or user override participates at runtime. */
export function browserMcpCommand(browser: BrowserToolSpec): BrowserMcpCommand {
  const args = [launcherPath(), "--isolated", "--caps=core,pdf"];
  if (browser.headless) args.push("--headless");
  if (browser.output_dir) args.push(`--output-dir=${browser.output_dir}`);
  return { command: process.execPath, args };
}
