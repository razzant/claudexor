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

import { readdirSync, readFileSync } from "node:fs";

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
  // Regex routes, matched in TWO independent passes so intervening lines
  // between the declaration and its `if (method === ... && xMatch)` use can
  // never silently drop an endpoint from the implemented set.
  const regexByName = new Map();
  const declRe = /const (\w+Match) = (\/\^[^;]+\/)\.exec\(path\);/g;
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) regexByName.set(m[1], m[2]);
  const useRe = /method === "(\w+)" && (\w+Match)\b/g;
  for (let m = useRe.exec(src); m; m = useRe.exec(src)) {
    const pattern = regexByName.get(m[2]);
    if (!pattern) continue;
    const template = pattern
      .replace(/^\/\^/, "")
      .replace(/\$\/$/, "")
      .replaceAll("\\/", "/")
      .replace(/\(\[\^\/\]\+\)/g, ":id")
      .replace(/\(\.\+\)/g, "<path>");
    out.add(`${m[1]} ${template}`);
  }
  // Self-check: every declared regex route must have been bound to a method.
  for (const [name] of regexByName) {
    if (!src.includes(`&& ${name}`)) {
      throw new Error(`docs-truth extractor: regex route '${name}' is declared but never used with a method guard`);
    }
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

for (const docPath of ["docs/ARCHITECTURE.md", "docs/INTEGRATIONS.md", "README.md"]) {
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
// 4. Version parity (DV3): the generated CLAUDEXOR_VERSION constant, the root
//    package.json, and EVERY workspace manifest must agree. This makes the
//    single-version SSOT (DV1) enforceable so versions can never drift again.
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
  // Every workspace manifest must match (changesets `fixed` keeps them in lockstep).
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
// 5. Debug-route parity (DV3): the CLAUDEXOR_DEBUG_ROUTE values the macOS app
//    actually handles (the `switch` cases in AppModel.swift) MUST equal the set
//    documented in apps/macos/README.md. A route the code handles but doesn't
//    document — or a documented route the code dropped — is a docs lie.
// --------------------------------------------------------------------------

const appModelSrc = readFileSync("apps/macos/ClaudexorApp/Sources/ClaudexorApp/AppModel.swift", "utf8");
// Isolate the `switch …CLAUDEXOR_DEBUG_ROUTE… { … }` block, then collect its
// non-default `case "x":` labels.
const switchMatch = /switch ProcessInfo\.processInfo\.environment\["CLAUDEXOR_DEBUG_ROUTE"\]\s*\{([\s\S]*?)\n\s*\}/.exec(
  appModelSrc,
);
if (!switchMatch) {
  failures.push("could not locate the CLAUDEXOR_DEBUG_ROUTE switch in AppModel.swift");
} else {
  const handledRoutes = new Set([...switchMatch[1].matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]));
  const macReadme = readFileSync("apps/macos/README.md", "utf8");
  // The documented set is the backticked tokens on the README lines describing
  // what `CLAUDEXOR_DEBUG_ROUTE` handles: take the bullet plus its continuation
  // up to the next bullet, and read `code` spans that aren't the env-var name.
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
// 6. Deleted-screen guard (DV3): the v0.9 screens removed in the v0.10
//    chat-first collapse must not reappear as SCREENS in the design/arch docs.
//    Conservative: we flag only the specific affirmative deleted-screen
//    phrasings, and explicitly allow honest negations ("no separate Review
//    Queue screen") so the docs can still SAY a screen was removed.
// --------------------------------------------------------------------------

const DELETED_SCREEN_PHRASES = [
  "Mission-control dashboard",
  "Mission control dashboard",
  "Home screen",
  "Tasks list screen",
  "Task list screen",
  "Review Queue screen",
];
// Negation cues that, immediately before a phrase, mark an honest "this screen
// is gone" statement rather than a reintroduction.
const NEGATION_BEFORE = /\b(no|not|never|without|removed|deleted|dropped|former|old|legacy|previous|no longer|instead of)\b[^.]*$/i;

for (const docPath of ["docs/DESIGN_SYSTEM.md", "docs/ARCHITECTURE.md"]) {
  const text = readFileSync(docPath, "utf8");
  for (const phrase of DELETED_SCREEN_PHRASES) {
    let idx = text.indexOf(phrase);
    while (idx !== -1) {
      // Look back to the start of the SENTENCE (markdown soft-wraps sentences
      // across single newlines, so the boundary is "." or a paragraph break,
      // not a lone "\n"); newlines within the sentence collapse to spaces so a
      // negation cue on the previous wrapped line is still seen.
      const paraStart = text.lastIndexOf("\n\n", idx);
      const dotStart = text.lastIndexOf(".", idx);
      const sentenceStart = Math.max(paraStart, dotStart) + 1;
      const before = text.slice(sentenceStart, idx).replace(/\s+/g, " ");
      if (!NEGATION_BEFORE.test(before)) {
        const line = text.slice(0, idx).split("\n").length;
        failures.push(`${docPath}:${line} reintroduces deleted v0.10 screen '${phrase}' as a current screen (use a negation if describing its removal)`);
      }
      idx = text.indexOf(phrase, idx + phrase.length);
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
