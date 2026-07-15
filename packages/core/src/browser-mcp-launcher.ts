#!/usr/bin/env node
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import "@playwright/mcp/package.json" with { type: "json" };
import { scrubBrowserEnvironment } from "./browser-mcp.js";

/** Dedicated egress child: remove provider/model credentials before loading
 * the pinned Browser MCP CLI in this process. */
scrubBrowserEnvironment(process.env);

const require = createRequire(import.meta.url);
const packageJson = require.resolve("@playwright/mcp/package.json");
const cli = join(dirname(packageJson), "cli.js");
process.argv = [process.execPath, cli, ...process.argv.slice(2)];
void import(pathToFileURL(cli).href).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
