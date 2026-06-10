#!/usr/bin/env node
/**
 * Docs-truth gate: public docs must describe the implemented surface, no more,
 * no less. Deterministic source-vs-docs set comparison — no LLM, no regex
 * governance of behavior (this checks documentation claims only).
 *
 * Checks:
 *  1. Control API endpoints implemented in daemon-server.ts vs documented in
 *     docs/ARCHITECTURE.md and docs/INTEGRATIONS.md.
 *  2. Canonical mode ids in the schema vs README.md / docs.
 *  3. CLI flags accepted by cli.ts (KNOWN_FLAGS) vs flags shown in its help.
 *
 * Exit 1 with an explicit list on any mismatch.
 */

import { readFileSync } from "node:fs";

const failures = [];

// --------------------------------------------------------------------------
// 1. Control API endpoints
// --------------------------------------------------------------------------

function implementedEndpoints(src) {
  const out = new Set();
  // Literal routes: method === "GET" && path === "/runs". Multi-method routes
  // are implemented as separate `if` blocks in daemon-server, so this single
  // pattern is the complete literal-route extractor.
  const litRe = /method === "(GET|POST|DELETE|PUT|PATCH)"\s*&&\s*path === "([^"]+)"/g;
  for (let m = litRe.exec(src); m; m = litRe.exec(src)) out.add(`${m[1]} ${m[2]}`);
  // Regex routes: const xMatch = /^\/runs\/([^/]+)\/apply$/ ... method === "POST" && xMatch
  const regexDecl = /const (\w+Match) = (\/\^[^;]+\/)\.exec\(path\);\s*\n\s*if \(method === "(\w+)" && \1\)/g;
  for (let m = regexDecl.exec(src); m; m = regexDecl.exec(src)) {
    const template = m[2]
      .replace(/^\/\^/, "")
      .replace(/\$\/$/, "")
      .replaceAll("\\/", "/")
      .replace(/\(\[\^\/\]\+\)/g, ":id")
      .replace(/\(\.\+\)/g, "<path>");
    out.add(`${m[3]} ${template}`);
  }
  return out;
}

function documentedEndpoints(docText) {
  const out = new Set();
  const re = /`((?:GET|POST|DELETE|PUT|PATCH)(?:\|(?:GET|POST|DELETE|PUT|PATCH))*) ([^`]+)`/g;
  for (let m = re.exec(docText); m; m = re.exec(docText)) {
    for (const method of m[1].split("|")) {
      // Normalize :name placeholders to :id for comparison.
      const path = m[2].trim().replace(/:[A-Za-z_]+/g, ":id");
      out.add(`${method} ${path}`);
    }
  }
  return out;
}

const serverSrc = readFileSync("packages/control-api/src/daemon-server.ts", "utf8");
const implemented = implementedEndpoints(serverSrc);
implemented.add("GET /healthz"); // declared before auth with hostIsLoopback guard

for (const docPath of ["docs/ARCHITECTURE.md", "docs/INTEGRATIONS.md"]) {
  const documented = documentedEndpoints(readFileSync(docPath, "utf8"));
  for (const ep of documented) {
    if (!implemented.has(ep)) failures.push(`${docPath} documents '${ep}' but daemon-server.ts does not implement it`);
  }
  for (const ep of implemented) {
    if (ep === "GET /healthz") continue; // internal liveness; optional in docs
    if (!documented.has(ep)) failures.push(`${docPath} is missing implemented endpoint '${ep}'`);
  }
}

// --------------------------------------------------------------------------
// 2. Mode ids
// --------------------------------------------------------------------------

const schemaSrc = readFileSync("packages/schema/src/primitives.ts", "utf8");
const modeMatch = /ModeKind = z\.enum\(\[([^\]]+)\]\)/.exec(schemaSrc);
if (!modeMatch) {
  failures.push("could not locate ModeKind enum in packages/schema/src/primitives.ts");
} else {
  const modes = [...modeMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const readme = readFileSync("README.md", "utf8");
  const cliHelp = readFileSync("packages/cli/src/cli.ts", "utf8");
  for (const mode of modes) {
    if (!readme.includes(mode)) failures.push(`README.md does not mention canonical mode id '${mode}'`);
    if (!cliHelp.includes(mode)) failures.push(`cli.ts help/modes does not mention canonical mode id '${mode}'`);
  }
}

// --------------------------------------------------------------------------
// 3. CLI flags vs help text
// --------------------------------------------------------------------------

const cliSrc = readFileSync("packages/cli/src/cli.ts", "utf8");
const knownMatch = /const KNOWN_FLAGS = new Set\(\[([\s\S]*?)\]\);/.exec(cliSrc);
if (!knownMatch) {
  failures.push("could not locate KNOWN_FLAGS in packages/cli/src/cli.ts");
} else {
  const flags = [...knownMatch[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  const helpMatch = /const HELP = `([\s\S]*?)`;/.exec(cliSrc);
  const help = helpMatch ? helpMatch[1] : "";
  // Flags that are subcommand-scoped and documented next to their command, not
  // in the global Options block.
  const subcommandScoped = new Set(["all", "dry-run", "deep", "from-env", "json"]);
  for (const flag of flags) {
    if (subcommandScoped.has(flag)) continue;
    if (!help.includes(`--${flag}`)) failures.push(`cli.ts KNOWN_FLAGS has '--${flag}' but the help text does not document it`);
  }
  for (const m of help.matchAll(/--([a-z-]+)/g)) {
    if (!flags.includes(m[1])) failures.push(`cli.ts help documents '--${m[1]}' but KNOWN_FLAGS does not accept it`);
  }
}

// --------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("docs-truth check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("docs-truth check passed");
