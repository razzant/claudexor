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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GEN_BEGIN, GEN_END, implementedEndpoints, renderEndpointBlock } from "./endpoints-lib.mjs";

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
    "web_policy", "effort_levels", "known_models", "models_authoritative",
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

  // CLI verb parity (one-directional, toward the help): every user-facing verb
  // the CLI's Usage block advertises must appear in the "## Surface Matrix"
  // SECTION of INTEGRATIONS (not just anywhere in the doc — a verb mentioned
  // only in a later example would not keep the matrix honest), so the
  // hand-written verb list cannot silently rot when commands are added.
  // (Internal/unlisted verbs are not force-documented.)
  const helpMatch2 = /const HELP = `([\s\S]*?)`;/.exec(cliSrc);
  // Case-insensitive heading match; the section may also be the last one
  // (no following `## ` heading), hence the `$` alternative.
  const matrixMatch = /^##\s+Surface Matrix\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(integrations);
  if (!matrixMatch) {
    failures.push("docs/INTEGRATIONS.md no longer has a '## Surface Matrix' section (CLI verb parity check needs it)");
  } else if (helpMatch2) {
    const verbs = new Set();
    for (const m of helpMatch2[1].matchAll(/^\s{2}claudexor ([a-z][a-z-]*)/gm)) {
      if (m[1] !== "help") verbs.add(m[1]);
    }
    for (const verb of verbs) {
      if (!new RegExp(`\\b${verb}\\b`, "i").test(matrixMatch[1])) {
        failures.push(`docs/INTEGRATIONS.md Surface Matrix does not mention CLI verb '${verb}' (advertised in cli.ts help)`);
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

if (failures.length > 0) {
  console.error("docs-truth check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("docs-truth check passed");
