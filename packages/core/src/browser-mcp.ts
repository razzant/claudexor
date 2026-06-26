import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserToolSpec } from "@claudexor/schema";

/**
 * Resolve a usable `npx` for spawning the Playwright browser MCP. Prefer the
 * bundled node's npx (the daemon runs under the notarized node, so `npx` sits
 * alongside `node`), fall back to PATH `npx`; an explicit env override wins for
 * unusual layouts. Centralized so every adapter's browser injection agrees.
 */
export function resolveNpxBin(): string {
  const override = process.env.CLAUDEXOR_NPX_BIN;
  if (override) return override;
  const bundled = join(dirname(process.execPath), "npx");
  return existsSync(bundled) ? bundled : "npx";
}

/**
 * The argv (after `npx`) that launches the Playwright MCP server for a run's
 * BrowserToolSpec: an isolated profile, core+pdf capabilities, headed by default
 * (a real visible window the user watches), and an output dir pointed at the run
 * artifact tree so captures surface in the Canvas gallery. Adapters wrap this in
 * their own MCP-injection flag (codex `-c mcp_servers.*` overrides, claude
 * `--mcp-config` inline JSON).
 */
export function playwrightMcpArgs(browser: BrowserToolSpec): string[] {
  const args = ["-y", "@playwright/mcp@latest", "--isolated", "--caps=core,pdf"];
  if (browser.headless) args.push("--headless");
  if (browser.output_dir) args.push(`--output-dir=${browser.output_dir}`);
  return args;
}
