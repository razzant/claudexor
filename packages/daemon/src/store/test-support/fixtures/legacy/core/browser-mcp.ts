import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserToolSpec } from "../schema/index.js";
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
 * Shared project-level container for run-owned media children. The root itself
 * is NOT Claudexor-owned: only a marker-bound `<envelope-id>` child may be
 * excluded, collected, or cleaned, so pre-existing sibling files remain
 * ordinary candidate/user state.
 */
export const CLAUDEXOR_ARTIFACT_DIR = ".claudexor-artifacts";

/** One envelope-owned subtree below the shared project-level artifact root.
 * The envelope id is engine-generated; callers must never substitute user
 * input or fall back to excluding the shared root. */
export function claudexorArtifactRunDirectory(envelopeId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(envelopeId) || envelopeId === "." || envelopeId === "..") {
    throw new Error("artifact envelope id is not a safe path segment");
  }
  return join(CLAUDEXOR_ARTIFACT_DIR, envelopeId);
}

/** The browser-MCP screenshot output subdir under the run-owned child. */
export const CLAUDEXOR_BROWSER_ARTIFACT_SUBDIR = "browser";

/** Exact local command for the pinned Browser MCP. No npx, package download,
 * version alias, or user override participates at runtime. */
export function browserMcpCommand(browser: BrowserToolSpec): BrowserMcpCommand {
  const args = [launcherPath(), "--isolated", "--caps=core,pdf"];
  if (browser.headless) args.push("--headless");
  if (browser.output_dir) args.push(`--output-dir=${browser.output_dir}`);
  return { command: process.execPath, args };
}
