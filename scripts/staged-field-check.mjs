#!/usr/bin/env node
// Staged-field gate.
//
// A "staged field" is a zod OBJECT FIELD declared in the schema package that NO
// real code outside the schema definition ever reads or writes. The schema is a
// contract: every field must have a producer or a consumer somewhere in the
// codebase (TS daemon/CLI/adapters; Swift reads via the generated DTOs but the
// control-api daemon projects every real DTO field in TS, so an honest field
// always has a TS reference). A field with ZERO references outside the schema
// src is dead surface area pretending to be contract — delete it or wire it.
//
// Algorithm (pragmatic, no AST dep):
//   1. For each packages/schema/src/*.ts (excluding index/primitives/*.test.ts),
//      extract object field names: lines of the form `  fieldName: z.…` or
//      `  fieldName: CapitalizedSchemaRef…` (a zod object field declaration).
//   2. For each field, scan every packages/**/src/**/*.ts OUTSIDE the schema
//      package src (and excluding generated/, dist/, *.test.ts) for any of:
//        .fieldName   fieldName:   "fieldName"   'fieldName'   [fieldName]
//      A field with zero such references is a violation.
//   3. A tiny, justified allowlist covers fields legitimately consumed only
//      outside the scanned TS surface. Keep it small; a growing allowlist means
//      the model is wrong — stop and fix the schema instead.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const schemaSrc = join(root, "packages", "schema", "src");

/**
 * Fields that are genuinely consumed but not by the scanned TS surface, with a
 * one-line justification each. MUST stay tiny. Empty today — the honest schema
 * has a TS producer/consumer for every field.
 */
const ALLOWLIST = new Map([
  // (field name) => reason. Add ONLY with a concrete justification.
]);

function walk(dir, acc, filter) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "generated") continue;
      walk(p, acc, filter);
    } else if (filter(p)) {
      acc.push(p);
    }
  }
}

// 1. Collect schema field declarations.
const fieldDeclRe = /^\s+([a-z_][a-zA-Z0-9_]*):\s*(z\.|[A-Z][A-Za-z0-9_]*[.(])/;
const schemaFiles = readdirSync(schemaSrc).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && f !== "primitives.ts",
);

/** field name -> Set of "file:line" where declared (for the violation report) */
const declaredAt = new Map();
for (const f of schemaFiles) {
  const lines = readFileSync(join(schemaSrc, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = line.match(fieldDeclRe);
    if (!m) return;
    const name = m[1];
    if (!declaredAt.has(name)) declaredAt.set(name, []);
    declaredAt.get(name).push(`packages/schema/src/${f}:${i + 1}`);
  });
}

// 2. Gather consumer sources: every packages/**/src/**/*.ts and apps/**/src
//    OUTSIDE the schema package src, minus generated/dist/test.
const consumerRoots = [join(root, "packages"), join(root, "apps"), join(root, "benchmarks")];
const consumerFiles = [];
for (const r of consumerRoots) {
  try {
    walk(r, consumerFiles, (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && p.includes(`${sep}src${sep}`));
  } catch {
    /* apps may not have a TS src; ignore */
  }
}
const schemaSrcPrefix = schemaSrc + sep;

/**
 * Strip `//` line comments and `/* … *​/` block comments so a field mentioned
 * ONLY in prose never counts as consumed (a comment is not a producer or a
 * consumer). String literals are kept: `payload["field"]` and event-key
 * strings are legitimate runtime references. The stripper is line-pragmatic,
 * not a full lexer — a `//` inside a string is rare in this codebase and only
 * risks a false NEGATIVE reference (over-stripping), never a false pass.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, (m, pre) => pre);
  return out;
}

const haystack = consumerFiles
  .filter((p) => !p.startsWith(schemaSrcPrefix))
  .map((p) => stripComments(readFileSync(p, "utf8")))
  .join("\n\n");

// 3. A field is referenced if its identifier appears as a real token anywhere in
//    consuming code: property access (.field), object literal key (field:),
//    object shorthand / destructuring / local binding (\bfield\b), or a string
//    literal key ("field"/'field'). We use a word-boundary identifier match so
//    shorthand props ({ requestedAccess }) and destructured reads
//    (const { open_tasks } = …) — both legitimate consumers — are recognized.
//    Comments can theoretically match, but field names here are distinctive
//    snake/camel identifiers, not bare English words used in prose.
const wordBoundaryCache = new Map();
function isReferenced(name) {
  let re = wordBoundaryCache.get(name);
  if (!re) {
    // (^|[^.\w]) avoids matching a longer identifier's suffix; ($|[^\w]) the prefix.
    re = new RegExp(`(^|[^\\w$])${name}(?![\\w$])`, "m");
    wordBoundaryCache.set(name, re);
  }
  return re.test(haystack);
}

const violations = [];
for (const [name, sites] of declaredAt) {
  if (ALLOWLIST.has(name)) continue;
  if (!isReferenced(name)) violations.push({ name, sites });
}

if (violations.length > 0) {
  console.error("staged-field check FAILED: schema field(s) with no consumer outside the schema definition:\n");
  for (const v of violations.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${v.name}  (declared at ${v.sites.join(", ")})`);
  }
  console.error(
    "\nA schema field with zero references is a staged field. Either delete it (and run pnpm schema:gen)\n" +
      "or wire a real producer/consumer. Allowlist ONLY with a concrete justification in scripts/staged-field-check.mjs.",
  );
  process.exit(1);
}

console.log(`staged-field check passed (${declaredAt.size} fields, ${ALLOWLIST.size} allowlisted)`);
