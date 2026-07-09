#!/usr/bin/env node
/**
 * Docs-truth gate v2: public docs must describe the implemented surface, no
 * more, no less. Deterministic source-vs-docs comparison — no LLM, no regex
 * governance of behavior (this checks documentation claims only).
 *
 * Checks:
 *  1. Control API endpoints: docs/ARCHITECTURE.md carries the CANONICAL
 *     generated inventory (markers + freshness + bidirectional completeness);
 *     other docs may mention endpoints but every mention must be real.
 *  2. Canonical mode ids in the schema vs README.md / CLI help.
 *  3. CLI flags accepted by cli.ts (KNOWN_FLAGS) vs flags shown in its help.
 *  4. Version parity across the generated constant and every manifest.
 *  5. macOS debug-route parity (AppModel.swift vs apps/macos/README.md).
 *  6. Deleted-screen guard (chat-first collapse must not silently revert).
 *  7. Dead-symbol check: code-shaped backticked identifiers in public docs
 *     must exist in the source tree (catches NavigationSplitView/glowHi-class
 *     staleness).
 *  8. Enum parity: inspector tabs vs DESIGN_SYSTEM; MCP tool names vs
 *     INTEGRATIONS.
 *  9. Version-anchor lint: descriptions of current behavior must not carry
 *     `v0.N` anchors (history phrasing is allowed) — Bible INV-133.
 *
 * Exit 1 with an explicit list on any mismatch.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GEN_BEGIN, GEN_END, endpointDetails, implementedEndpoints, renderEndpointBlock, renderEndpointsJson } from "./endpoints-lib.mjs";

const failures = [];

// --------------------------------------------------------------------------
// 1. Control API endpoints
// --------------------------------------------------------------------------

function documentedEndpoints(docText) {
  const out = new Set();
  const re = /`((?:GET|POST|DELETE|PUT|PATCH)(?:\|(?:GET|POST|DELETE|PUT|PATCH))*) ([^`]+)`/g;
  for (let m = re.exec(docText); m; m = re.exec(docText)) {
    for (const method of m[1].split("|")) {
      const path = m[2].trim().replace(/:[A-Za-z_]+/g, ":id");
      out.add(`${method} ${path}`);
    }
  }
  return out;
}

const implemented = implementedEndpoints();

// 1a. ARCHITECTURE holds the canonical generated block: present, fresh, and
// its documented set matches the implemented set in both directions.
{
  const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
  const begin = arch.indexOf(GEN_BEGIN);
  const end = arch.indexOf(GEN_END);
  if (begin === -1 || end === -1) {
    failures.push("docs/ARCHITECTURE.md is missing the GENERATED ENDPOINTS markers (run node scripts/gen-endpoints-doc.mjs)");
  } else {
    const current = arch.slice(begin, end + GEN_END.length);
    const expected = renderEndpointBlock(implemented);
    if (current !== expected) {
      failures.push("docs/ARCHITECTURE.md endpoint inventory is stale; run node scripts/gen-endpoints-doc.mjs and commit");
    }
    const documented = documentedEndpoints(arch);
    for (const ep of documented) {
      if (!implemented.has(ep)) failures.push(`docs/ARCHITECTURE.md documents '${ep}' but daemon-server.ts does not implement it`);
    }
    for (const ep of implemented) {
      if (ep === "GET /healthz") continue; // internal liveness; optional in docs
      if (!documented.has(ep)) failures.push(`docs/ARCHITECTURE.md is missing implemented endpoint '${ep}'`);
    }
  }

  // 1a-ii. The machine-readable endpoint map (docs/reference/endpoints.json)
  // is fresh, and every schema name it references has a generated JSON Schema.
  {
    const details = endpointDetails();
    const expectedJson = renderEndpointsJson(details);
    let currentJson = null;
    try {
      currentJson = readFileSync("docs/reference/endpoints.json", "utf8");
    } catch {
      failures.push("docs/reference/endpoints.json is missing; run node scripts/gen-endpoints-doc.mjs and commit");
    }
    if (currentJson !== null && currentJson !== expectedJson) {
      failures.push("docs/reference/endpoints.json is stale; run node scripts/gen-endpoints-doc.mjs and commit");
    }
    for (const d of details) {
      for (const ref of [d.requestSchema, d.responseSchema]) {
        if (ref && !existsSync(`packages/schema/generated/${ref}.schema.json`)) {
          failures.push(`endpoints.json references schema '${ref}' but packages/schema/generated/${ref}.schema.json does not exist`);
        }
      }
    }
  }
}

// 1b. Other public docs: every endpoint they mention must exist (they are no
// longer required to be complete — the canonical inventory lives in ARCH).
for (const docPath of ["docs/INTEGRATIONS.md", "README.md"]) {
  const documented = documentedEndpoints(readFileSync(docPath, "utf8"));
  for (const ep of documented) {
    if (!implemented.has(ep)) failures.push(`${docPath} documents '${ep}' but daemon-server.ts does not implement it`);
  }
}

// --------------------------------------------------------------------------
// 2. Mode ids
// --------------------------------------------------------------------------

// The registry (built artifact) is the ONE owner of the CLI surface: verbs,
// flags, help, and `help --json` are all views of it, so the old
// source-regex extractions (KNOWN_FLAGS block, HELP literal) are gone by
// construction. The gate now checks the REGISTRY against the docs.
// Fail FAST when the artifact is missing (same contract as
// mcp-cli-parity-check): a partial docs-truth pass must never read as green.
const registryDist = "packages/cli/dist/command-registry.js";
if (!existsSync(registryDist)) {
  console.error(`docs-truth: ${registryDist} is missing — run \`pnpm build\` first (the gate reads the built command registry)`);
  process.exit(1);
}
const cliRegistry = await import(join(process.cwd(), registryDist));

const schemaSrc = readFileSync("packages/schema/src/primitives.ts", "utf8");
// Whitespace-tolerant: prettier may break `z.enum([...])` across lines when a
// .describe() chain lengthens the statement.
const modeMatch = /ModeKind = z\s*\.enum\(\[([^\]]+)\]\)/.exec(schemaSrc);
if (!modeMatch) {
  failures.push("could not locate ModeKind enum in packages/schema/src/primitives.ts");
} else {
  const modes = [...modeMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const readme = readFileSync("README.md", "utf8");
  const renderedHelp = cliRegistry.renderHelp("0.0.0");
  for (const mode of modes) {
    if (!readme.includes(mode)) failures.push(`README.md does not mention canonical mode id '${mode}'`);
    if (!renderedHelp.includes(mode)) failures.push(`CLI help (command registry) does not mention canonical mode id '${mode}'`);
  }
}

// --------------------------------------------------------------------------
// 3. CLI registry self-consistency (flags referenced by commands must exist;
//    every accepted flag must be documented in help or inline under a command)
// --------------------------------------------------------------------------

{
  const flagNames = new Set(cliRegistry.CLI_FLAGS.map((f) => f.name));
  for (const cmd of cliRegistry.CLI_COMMANDS) {
    for (const flag of cmd.flags) {
      if (!flagNames.has(flag)) failures.push(`command registry: command '${cmd.id}' references unknown flag '--${flag}'`);
    }
  }
  const renderedHelp = cliRegistry.renderHelp("0.0.0");
  for (const m of renderedHelp.matchAll(/--([a-z-]+)/g)) {
    if (!flagNames.has(m[1])) failures.push(`CLI help mentions '--${m[1]}' but the command registry does not declare it`);
  }
  // Every declared flag must be consumed by at least one command (no orphan knobs).
  const consumed = new Set(cliRegistry.CLI_COMMANDS.flatMap((c) => [...c.flags]));
  consumed.add("help").add("version"); // global preflight affordances
  for (const flag of flagNames) {
    if (!consumed.has(flag)) failures.push(`command registry declares '--${flag}' but no command consumes it`);
  }
}

// --------------------------------------------------------------------------
// 4. Version parity: generated constant, root package.json, every manifest.
// --------------------------------------------------------------------------

const versionTs = readFileSync("packages/util/src/version.ts", "utf8");
const constMatch = /CLAUDEXOR_VERSION\s*=\s*"([^"]+)"/.exec(versionTs);
if (!constMatch) {
  failures.push("could not locate CLAUDEXOR_VERSION in packages/util/src/version.ts (run `pnpm gen:version`)");
} else {
  const constant = constMatch[1];
  const rootVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
  if (constant !== rootVersion) {
    failures.push(`CLAUDEXOR_VERSION (${constant}) != root package.json version (${rootVersion}); run \`pnpm gen:version\``);
  }
  const manifests = [];
  for (const pkg of readdirSync("packages")) {
    const path = `packages/${pkg}/package.json`;
    try {
      manifests.push([path, JSON.parse(readFileSync(path, "utf8")).version]);
    } catch {
      /* not a package dir */
    }
  }
  try {
    manifests.push(["benchmarks/runner/package.json", JSON.parse(readFileSync("benchmarks/runner/package.json", "utf8")).version]);
  } catch {
    /* runner absent */
  }
  for (const [path, version] of manifests) {
    if (version !== constant) {
      failures.push(`${path} version (${version}) != CLAUDEXOR_VERSION (${constant}); bump it (changesets fixed lockstep)`);
    }
  }
}

// --------------------------------------------------------------------------
// 5. Debug-route parity (AppModel.swift vs apps/macos/README.md).
// --------------------------------------------------------------------------

const appModelSrc = readFileSync("apps/macos/ClaudexorApp/Sources/ClaudexorApp/AppModel.swift", "utf8");
const switchMatch = /switch ProcessInfo\.processInfo\.environment\["CLAUDEXOR_DEBUG_ROUTE"\]\s*\{([\s\S]*?)\n\s*\}/.exec(
  appModelSrc,
);
if (!switchMatch) {
  failures.push("could not locate the CLAUDEXOR_DEBUG_ROUTE switch in AppModel.swift");
} else {
  const handledRoutes = new Set([...switchMatch[1].matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
  const macReadme = readFileSync("apps/macos/README.md", "utf8");
  const bulletMatch = /- `CLAUDEXOR_DEBUG_ROUTE`:[\s\S]*?(?=\n- `|\n\n)/.exec(macReadme);
  const documentedRoutes = new Set();
  if (bulletMatch) {
    for (const m of bulletMatch[0].matchAll(/`([a-z_]+)`/g)) {
      if (m[1] !== "CLAUDEXOR_DEBUG_ROUTE") documentedRoutes.add(m[1]);
    }
  } else {
    failures.push("could not locate the CLAUDEXOR_DEBUG_ROUTE bullet in apps/macos/README.md");
  }
  for (const r of handledRoutes) {
    if (!documentedRoutes.has(r)) failures.push(`AppModel.swift handles debug route '${r}' but apps/macos/README.md does not document it`);
  }
  for (const r of documentedRoutes) {
    if (!handledRoutes.has(r)) failures.push(`apps/macos/README.md documents debug route '${r}' but AppModel.swift does not handle it`);
  }
}

// --------------------------------------------------------------------------
// 6. Deleted-screen guard: removed screens must not reappear as current.
// --------------------------------------------------------------------------

const DELETED_SCREEN_PHRASES = [
  "Mission-control dashboard",
  "Mission control dashboard",
  "Home screen",
  "Tasks list screen",
  "Task list screen",
  "Review Queue screen",
];
const NEGATION_BEFORE = /\b(no|not|never|without|removed|deleted|dropped|former|old|legacy|previous|no longer|instead of)\b[^.]*$/i;

for (const docPath of ["docs/DESIGN_SYSTEM.md", "docs/ARCHITECTURE.md"]) {
  const text = readFileSync(docPath, "utf8");
  for (const phrase of DELETED_SCREEN_PHRASES) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      const paraStart = text.lastIndexOf("\n\n", idx);
      const dotStart = text.lastIndexOf(".", idx);
      const sentenceStart = Math.max(paraStart, dotStart) + 1;
      const before = text.slice(sentenceStart, idx).replace(/\s+/g, " ");
      if (!NEGATION_BEFORE.test(before)) {
        const line = text.slice(0, idx).split("\n").length;
        failures.push(`${docPath}:${line} reintroduces deleted screen '${phrase}' as a current screen (use a negation if describing its removal)`);
      }
      idx = text.indexOf(phrase, idx + phrase.length);
    }
  }
}

// --------------------------------------------------------------------------
// 7. Dead-symbol check: code-shaped backticked identifiers in public docs must
//    exist somewhere in the source tree. Catches NavigationSplitView / glowHi /
//    MeshGradient-class staleness where docs legislate about deleted code.
// --------------------------------------------------------------------------

// docs/FEATURES.md is deliberately absent: the ledger's rows describe MISSING
// or broken surface (protocol fields the server lacks, dead knobs slated for
// deletion), so "symbol not in source" is often exactly the documented fact.
const PUBLIC_DOCS = [
  "README.md",
  "CLAUDEXOR_BIBLE.md",
  "CONTRIBUTING.md",
  "docs/ARCHITECTURE.md",
  "docs/INTEGRATIONS.md",
  "docs/DESIGN_SYSTEM.md",
  "docs/WHITEPAPER.md",
  "docs/DEVELOPMENT.md",
  "docs/CHECKLISTS.md",
  "apps/macos/README.md",
];

function collectSourceHaystack() {
  const roots = ["packages", "apps", "scripts", "benchmarks"];
  const chunks = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name === ".build" || name === "generated") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(ts|swift|mjs|js|py|sh|json|ya?ml|plist)$/.test(name)) {
        try {
          chunks.push(readFileSync(p, "utf8"));
        } catch {
          /* unreadable */
        }
      }
    }
  };
  for (const r of roots) walk(r);
  chunks.push(readFileSync("package.json", "utf8"));
  return chunks.join("\n");
}

{
  const haystack = collectSourceHaystack();
  // Code-shaped: CamelCase with an interior capital, snake_case with an
  // underscore, or dotted identifiers. Plain words, flags, paths, and
  // env-style ALLCAPS with dashes are skipped (flags/env are covered by
  // their own checks).
  const codeShaped = /^(?:[A-Za-z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+)$/;
  // Terms that are conceptual vocabulary, wire values, or external names —
  // not identifiers this repo's source must contain.
  const allow = new Set([
    // wire/status/config VALUES documented as data, not symbols
    "in_place", "workspace_write", "external_sandbox_full", "inherit_native",
    "best_of_n", "max_attempts", "until_clean", "readonly_audit", "daily",
    "until_convergence", "readonly_swarm", "create_from_scratch", "auto_safe",
    "auto_full", "not_converged", "stuck_no_progress", "no_op", "new_repo",
    "accept_risk", "override_needs_human", "accept_clean_patch",
    "rerun_with_feedback", "revert_run", "waiting_on_user", "api_key",
    "local_session", "native_session", "api_key_env", "provider_auth_file",
    "os_keychain", "http_header", "config_file", "env_var", "oauth_token_env",
    "subscription-first", "claude_oauth", "browser_tool", "image_input",
    "web_policy", "effort_levels", "known_models",
    "web_search", "node_repl", "review_not_run", "cross_family_review",
    "applied_review_blocked", "not_applied", "user.name", "user.email",
    // external tools / ecosystem names
    "swift.org", "cursor.com", "opencode.ai", "modelcontextprotocol.io",
    "openrouter.ai", "claude.ai", "openai.com",
  ]);
  for (const docPath of PUBLIC_DOCS) {
    const text = readFileSync(docPath, "utf8");
    const seen = new Set();
    for (const m of text.matchAll(/`([^`\n]{2,60})`/g)) {
      const token = m[1].trim();
      if (seen.has(token)) continue;
      seen.add(token);
      if (!codeShaped.test(token)) continue;
      if (allow.has(token)) continue;
      if (token.endsWith(".md") || token.endsWith(".json") || token.endsWith(".yaml") || token.endsWith(".yml")) continue;
      if (haystack.includes(token)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      failures.push(`${docPath}:${line} references \`${token}\` which does not exist in the source tree (stale symbol?)`);
    }
  }
}

// --------------------------------------------------------------------------
// 8. Enum parity: inspector tabs vs DESIGN_SYSTEM; MCP tools vs INTEGRATIONS.
// --------------------------------------------------------------------------

{
  const taskDetail = readFileSync("apps/macos/ClaudexorApp/Sources/ClaudexorApp/TaskDetailView.swift", "utf8");
  const tabEnum = /enum Tab[^{]*\{([\s\S]*?)\n\s*\}/.exec(taskDetail);
  if (!tabEnum) {
    failures.push("could not locate the inspector Tab enum in TaskDetailView.swift");
  } else {
    // Declaration lines only (`case a, b, c` — no dot, no colon), NOT the
    // switch labels of the label accessor. A one-line comma list must yield
    // every id, not just the first (`/case (\w+)/` extracted 1 of 8 tabs).
    const tabs = [...tabEnum[1].matchAll(/^\s*case ([\w][\w, ]*)$/gm)]
      .flatMap((m) => m[1].split(","))
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (tabs.length < 2) {
      failures.push(`inspector Tab enum extraction looks broken: found ${tabs.length} tab(s) in TaskDetailView.swift`);
    }
    // Docs speak the user-facing label (`Outcome`, `Timeline`), so parity
    // accepts either the label from the `label` switch or the raw case id.
    const labelByCase = new Map(
      [...tabEnum[1].matchAll(/case \.(\w+):\s*return "([^"]+)"/g)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]),
    );
    const design = readFileSync("docs/DESIGN_SYSTEM.md", "utf8").toLowerCase();
    for (const tab of tabs) {
      const label = labelByCase.get(tab);
      if (!design.includes(tab) && !(label && design.includes(label))) {
        failures.push(
          `docs/DESIGN_SYSTEM.md does not mention inspector tab '${tab}'${label ? ` (label "${label}")` : ""} (TaskDetailView.swift Tab enum)`,
        );
      }
    }
  }

  const mcpSrc = readFileSync("packages/mcp-server/src/index.ts", "utf8");
  const tools = new Set([...mcpSrc.matchAll(/"(claudexor_[a-z_]+)"/g)].map((m) => m[1]));
  const integrations = readFileSync("docs/INTEGRATIONS.md", "utf8");
  for (const tool of tools) {
    if (!integrations.includes(tool)) failures.push(`docs/INTEGRATIONS.md does not document MCP tool '${tool}'`);
  }
  for (const m of integrations.matchAll(/`(claudexor_[a-z_]+)`/g)) {
    if (!tools.has(m[1])) failures.push(`docs/INTEGRATIONS.md documents MCP tool '${m[1]}' which the server does not expose`);
  }

  // CLI verb parity (one-directional, toward the registry): every user-facing
  // verb the command registry advertises must appear in the "## Surface
  // Matrix" SECTION of INTEGRATIONS (not just anywhere in the doc — a verb
  // mentioned only in a later example would not keep the matrix honest), so
  // the hand-written verb list cannot silently rot when commands are added.
  // Case-insensitive heading match; the section may also be the last one
  // (no following `## ` heading), hence the `$` alternative.
  const matrixMatch = /^##\s+Surface Matrix\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(integrations);
  if (!matrixMatch) {
    failures.push("docs/INTEGRATIONS.md no longer has a '## Surface Matrix' section (CLI verb parity check needs it)");
  } else {
    for (const cmd of cliRegistry.CLI_COMMANDS) {
      if (cmd.id === "help") continue;
      if (!new RegExp(`\\b${cmd.id}\\b`, "i").test(matrixMatch[1])) {
        failures.push(`docs/INTEGRATIONS.md Surface Matrix does not mention CLI verb '${cmd.id}' (declared in the command registry)`);
      }
    }
  }
}

// --------------------------------------------------------------------------
// 9. Version-anchor lint (INV-133): current-behavior descriptions must be
//    era-neutral. `v0.N` is allowed only on lines that read as history
//    (introduced/removed/since/legacy/…) or inside explicit history docs.
// --------------------------------------------------------------------------

{
  const HISTORY_CUE =
    /\b(introduced|added|removed|deleted|dropped|replaced|superseded|collapsed|renamed|since|until|was|were|had|history|changelog|release[sd]?|legacy|former|old|pre-|migration|lands?|shipped|arrives?|program|scheduled)\b/i;
  const ANCHOR_DOCS = [
    "CLAUDEXOR_BIBLE.md",
    "docs/ARCHITECTURE.md",
    "docs/DESIGN_SYSTEM.md",
    "docs/WHITEPAPER.md",
    "docs/INTEGRATIONS.md",
  ];
  for (const docPath of ANCHOR_DOCS) {
    const lines = readFileSync(docPath, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/\bv0\.\d/.test(line)) return;
      if (HISTORY_CUE.test(line)) return;
      failures.push(
        `${docPath}:${i + 1} anchors current behavior to a version ('${line.trim().slice(0, 80)}…') — describe the present era-neutrally or phrase it as history (INV-133)`,
      );
    });
  }
}

// --------------------------------------------------------------------------
// 10. FEATURES ledger self-consistency: the "Rows: **N** (status: n, …)"
//     header claim must match the actual table (the ledger's shrink-toward-
//     empty contract is meaningless if the count can silently drift).
// --------------------------------------------------------------------------

{
  const ledger = readFileSync("docs/FEATURES.md", "utf8");
  const header = /Rows: \*\*(\d+)\*\* \(([^)]*)\)/.exec(ledger);
  const rows = ledger
    .split("\n")
    .filter((l) => /^\|/.test(l) && !/^\|\s*Area\s*\|/.test(l) && !/^\|[-\s|]*$/.test(l));
  if (!header) {
    failures.push("docs/FEATURES.md is missing the 'Rows: **N** (…)' count header");
  } else {
    if (Number(header[1]) !== rows.length) {
      failures.push(`docs/FEATURES.md claims ${header[1]} rows but the table has ${rows.length}`);
    }
    const claimed = {};
    for (const part of header[2].split(",")) {
      const m = /([a-z-]+):\s*(\d+)/.exec(part.trim());
      if (m) claimed[m[1]] = Number(m[2]);
    }
    const actual = {};
    for (const row of rows) {
      const status = row.split("|").map((c) => c.trim())[3];
      if (status) actual[status] = (actual[status] ?? 0) + 1;
    }
    for (const status of new Set([...Object.keys(claimed), ...Object.keys(actual)])) {
      if ((claimed[status] ?? 0) !== (actual[status] ?? 0)) {
        failures.push(
          `docs/FEATURES.md header claims ${claimed[status] ?? 0} '${status}' rows but the table has ${actual[status] ?? 0}`,
        );
      }
    }
  }
}

// --------------------------------------------------------------------------
// 11. Environment reference completeness: every CLAUDEXOR_* env var a
//     PRODUCT source reads (packages/, excluding tests) must appear in the
//     INTEGRATIONS environment reference. A knob agents cannot discover is a
//     dead knob.
// --------------------------------------------------------------------------

{
  const integrations = readFileSync("docs/INTEGRATIONS.md", "utf8");
  if (!/^## Environment reference$/m.test(integrations)) {
    failures.push("docs/INTEGRATIONS.md is missing the '## Environment reference' section");
  } else {
    // Over-approximate on purpose: ANY CLAUDEXOR_* string literal in product
    // sources (helper-based env reads like positiveIntEnv("CLAUDEXOR_...")
    // included), minus the explicit non-env literals below. A knob agents
    // cannot discover is a dead knob.
    const NOT_ENV_VARS = new Set([
      "CLAUDEXOR_BIBLE", // the constitution filename (CLAUDEXOR_BIBLE.md)
      "CLAUDEXOR_VERSION", // the generated version CONSTANT in @claudexor/util
      "CLAUDEXOR_ARTIFACT_DIRS", // exported const of artifact dir names, not env
    ]);
    const envVars = new Set();
    const allLiterals = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "generated") continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".story.ts")) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/\bCLAUDEXOR_[A-Z_]+\b/g)) {
            allLiterals.add(m[0]);
            if (!NOT_ENV_VARS.has(m[0])) envVars.add(m[0]);
          }
        }
      }
    };
    walk("packages");
    for (const v of envVars) {
      if (!integrations.includes(v)) {
        failures.push(`docs/INTEGRATIONS.md Environment reference is missing '${v}' (read by product source)`);
      }
    }
    // Allowlist self-check: a renamed/removed literal must not linger as a
    // silent stale exclusion.
    for (const excluded of NOT_ENV_VARS) {
      if (!allLiterals.has(excluded)) {
        failures.push(`docs-truth NOT_ENV_VARS lists '${excluded}' which no longer appears in product sources — stale exclusion`);
      }
    }
  }
}

// --------------------------------------------------------------------------
// 12. Agent onboarding contour: the doc exists and anchors the live
//     machine-readable surfaces it points agents at.
// --------------------------------------------------------------------------

{
  let onboarding = null;
  try {
    onboarding = readFileSync("docs/AGENT_ONBOARDING.md", "utf8");
  } catch {
    failures.push("docs/AGENT_ONBOARDING.md is missing");
  }
  if (onboarding) {
    for (const anchor of ["help --json", "capabilities --json", "docs/reference/endpoints.json", "claudexor decision", "inline_secret_rejected"]) {
      if (!onboarding.includes(anchor)) failures.push(`docs/AGENT_ONBOARDING.md no longer mentions '${anchor}'`);
    }
  }
}

// --------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("docs-truth check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("docs-truth check passed");
