#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const args = new Set(process.argv.slice(2));
const registryMode = valueAfter("--registry");
if (registryMode && registryMode !== "before" && registryMode !== "after") {
  fail("--registry must be 'before' or 'after'");
}

const root = JSON.parse(readFileSync("package.json", "utf8"));
const npmPackage = JSON.parse(readFileSync("packages/claudexor/package.json", "utf8"));
const server = JSON.parse(readFileSync("server.json", "utf8"));
const plugin = JSON.parse(readFileSync("plugins/copilot/plugin.json", "utf8"));
const pluginMcp = JSON.parse(readFileSync("plugins/copilot/.mcp.json", "utf8"));
const expectedName = "io.github.razzant/claudexor";

if (npmPackage.name !== "claudexor")
  fail("the MCP package must be the executable claudexor package");
if (npmPackage.mcpName !== expectedName) fail("packages/claudexor mcpName is missing or wrong");
if (server.name !== expectedName) fail("server.json name must match the npm mcpName");
if (
  server.$schema !== "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
) {
  fail("server.json must use the pinned 2025-12-11 registry schema");
}
if (server.version !== root.version || plugin.version !== root.version) {
  fail("portable distribution versions must match the root package version");
}
if (!Array.isArray(server.packages) || server.packages.length !== 1) {
  fail("server.json must declare exactly one package");
}
const registryPackage = server.packages[0];
if (
  registryPackage.registryType !== "npm" ||
  registryPackage.identifier !== "claudexor" ||
  registryPackage.version !== root.version ||
  registryPackage.transport?.type !== "stdio"
) {
  fail("server.json npm package identity, version, or stdio transport is wrong");
}
if (
  !isDeepStrictEqual(registryPackage.packageArguments, [
    { type: "positional", value: "mcp" },
    { type: "positional", value: "serve" },
  ])
) {
  fail("server.json must start the embedded MCP server with package arguments: mcp serve");
}
if (registryPackage.environmentVariables !== undefined) {
  fail("the local MCP package must not request credentials or environment variables");
}
if (
  !isDeepStrictEqual(pluginMcp, {
    mcpServers: { claudexor: { command: "claudexor", args: ["mcp", "serve"] } },
  })
) {
  fail("portable Copilot MCP config must invoke the preinstalled claudexor command without env");
}

if (args.has("--npm")) {
  const url = `https://registry.npmjs.org/claudexor/${encodeURIComponent(root.version)}`;
  const published = await fetchJson(url, "npm package");
  if (
    published.name !== "claudexor" ||
    published.version !== root.version ||
    published.mcpName !== expectedName
  ) {
    fail(`npm claudexor@${root.version} does not expose the expected mcpName`);
  }
}

if (registryMode) {
  const query = new URLSearchParams({ search: expectedName, limit: "100" });
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?${query}`;
  const attempts = registryMode === "after" ? 12 : 1;
  let exact = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = await fetchJson(url, "MCP Registry");
    exact = (Array.isArray(body.servers) ? body.servers : []).filter(
      (entry) => entry?.server?.name === expectedName && entry?.server?.version === root.version,
    );
    if (exact.length > 1) fail(`MCP Registry returned duplicate ${expectedName}@${root.version}`);
    if (exact.length === 1 && !isDeepStrictEqual(exact[0].server, server)) {
      fail(`MCP Registry already has different metadata for ${expectedName}@${root.version}`);
    }
    if (exact.length === 1 || attempt + 1 === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const alreadyPublished = exact.length === 1;
  if (registryMode === "after" && !alreadyPublished) {
    fail(`MCP Registry does not expose ${expectedName}@${root.version} after publication`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `already_published=${alreadyPublished}\n`);
  }
  process.stdout.write(
    alreadyPublished
      ? `MCP Registry metadata verified: ${expectedName}@${root.version}\n`
      : `MCP Registry version is not published yet: ${expectedName}@${root.version}\n`,
  );
} else {
  process.stdout.write(
    `Portable MCP distribution metadata verified: ${expectedName}@${root.version}\n`,
  );
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`${label} request failed: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function fail(message) {
  console.error(`MCP distribution check failed: ${message}`);
  process.exit(1);
}
