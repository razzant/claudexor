#!/usr/bin/env node
// Staged-field gate (v3).
//
// A "staged field" is a zod OBJECT FIELD declared in the schema package that NO
// real code outside the schema definition ever reads or writes. The schema is a
// contract: every field must have a producer or a consumer somewhere in the
// codebase (TS daemon/CLI/adapters; Swift reads via the generated DTOs but the
// control-api daemon projects every real DTO field in TS, so an honest field
// always has a TS reference). A field with ZERO references outside the schema
// src is dead surface area pretending to be contract — delete it or wire it.
//
// v3 (immune negative control, PLAN D6 / advisor addendum #6): the gate runs
// an embedded SELF-TEST against synthetic fixtures BEFORE every real scan —
// a no-reference field must go RED, a code-referenced field GREEN, a
// comment-only reference RED. A gate that stops discriminating fails ITSELF
// loudly instead of green-lighting everything (the "vacuum pin" class: a
// checker that no longer checks). The SEMANTIC half of the promise ("the
// producer produces the declared behavior, not a placeholder") cannot be a
// grep — it is owned by canary golden stories per invariant.
//
// Algorithm (pragmatic, no AST dep):
//   1. For each packages/schema/src/*.ts (excluding index/primitives/*.test.ts),
//      extract object field names: lines of the form `  fieldName: z.…` or
//      `  fieldName: CapitalizedSchemaRef…` (a zod object field declaration).
//   2. For each field, scan every packages/**/src/**/*.ts OUTSIDE the schema
//      package src (and excluding generated/, dist/, *.test.ts) for a real
//      token reference (comments stripped first).
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

const fieldDeclRe = /^\s+([a-z_][a-zA-Z0-9_]*):\s*(z\.|[A-Z][A-Za-z0-9_]*[.(])/;

/** Extract declared field names from schema-source texts: name -> sites. */
function collectDeclarations(files) {
  const declaredAt = new Map();
  for (const { label, text } of files) {
    text.split("\n").forEach((line, i) => {
      const m = line.match(fieldDeclRe);
      if (!m) return;
      const name = m[1];
      if (!declaredAt.has(name)) declaredAt.set(name, []);
      declaredAt.get(name).push(`${label}:${i + 1}`);
    });
  }
  return declaredAt;
}

/**
 * Strip `//` line comments and block comments so a field mentioned ONLY in
 * prose never counts as consumed (a comment is not a producer or a consumer).
 * String literals are kept: `payload["field"]` and event-key strings are
 * legitimate runtime references. The stripper is line-pragmatic, not a full
 * lexer — a `//` inside a string is rare in this codebase and only risks a
 * false NEGATIVE reference (over-stripping), never a false pass.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, (m, pre) => pre);
  return out;
}

/** Core check: declared fields vs a consumer haystack. Returns violations. */
function findStagedFields(declaredAt, consumerTexts, allowlist) {
  const haystack = consumerTexts.map(stripComments).join("\n\n");
  const violations = [];
  for (const [name, sites] of declaredAt) {
    if (allowlist.has(name)) continue;
    const re = new RegExp(`(^|[^\\w$])${name}(?![\\w$])`, "m");
    if (!re.test(haystack)) violations.push({ name, sites });
  }
  return violations;
}

/**
 * Embedded negative control: prove the gate still DISCRIMINATES before
 * trusting its verdict on the real tree. Each case is a synthetic schema +
 * consumer pair with a known expected verdict.
 */
function selfTest() {
  const schema = [
    {
      label: "fixture/schema.ts",
      text: [
        "export const Fixture = z.object({",
        "  wired_field: z.string(),",
        "  orphan_field: z.string(),",
        "  comment_only_field: z.string(),",
        "});",
      ].join("\n"),
    },
  ];
  const decls = collectDeclarations(schema);
  const cases = [
    {
      name: "code reference passes",
      consumers: ["const x = payload.wired_field;"],
      expectViolation: { wired_field: false },
    },
    {
      name: "zero references fails",
      consumers: ["const y = 1;"],
      expectViolation: { orphan_field: true },
    },
    {
      name: "comment-only reference fails",
      consumers: ["// comment_only_field is planned\n/* comment_only_field soon */\nconst z1 = 1;"],
      expectViolation: { comment_only_field: true },
    },
  ];
  for (const testCase of cases) {
    const violations = findStagedFields(decls, testCase.consumers, new Map());
    for (const [field, expected] of Object.entries(testCase.expectViolation)) {
      const actual = violations.some((v) => v.name === field);
      if (actual !== expected) {
        console.error(
          `staged-field SELF-TEST FAILED: case '${testCase.name}' — field '${field}' expected violation=${expected}, got ${actual}. The gate no longer discriminates; fix the gate before trusting any verdict.`,
        );
        process.exit(1);
      }
    }
  }
}

selfTest();

// Real scan. Test files are excluded by the walk filter below — a *.test.ts
// reference alone must never count as wiring (the self-test above pins the
// comment class; the filter pins the test class by construction).
const schemaFiles = readdirSync(schemaSrc)
  .filter(
    (f) =>
      f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && f !== "primitives.ts",
  )
  .map((f) => ({
    label: `packages/schema/src/${f}`,
    text: readFileSync(join(schemaSrc, f), "utf8"),
  }));
const declaredAt = collectDeclarations(schemaFiles);

const consumerRoots = [join(root, "packages"), join(root, "apps"), join(root, "benchmarks")];
const consumerFiles = [];
for (const r of consumerRoots) {
  try {
    walk(
      r,
      consumerFiles,
      (p) => p.endsWith(".ts") && !p.endsWith(".test.ts") && p.includes(`${sep}src${sep}`),
    );
  } catch {
    /* apps may not have a TS src; ignore */
  }
}
const schemaSrcPrefix = schemaSrc + sep;
const consumerTexts = consumerFiles
  .filter((p) => !p.startsWith(schemaSrcPrefix))
  .map((p) => readFileSync(p, "utf8"));

const violations = findStagedFields(declaredAt, consumerTexts, ALLOWLIST);

if (violations.length > 0) {
  console.error(
    "staged-field check FAILED: schema field(s) with no consumer outside the schema definition:\n",
  );
  for (const v of violations.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${v.name}  (declared at ${v.sites.join(", ")})`);
  }
  console.error(
    "\nA schema field with zero references is a staged field. Either delete it (and run pnpm schema:gen)\n" +
      "or wire a real producer/consumer. Allowlist ONLY with a concrete justification in scripts/staged-field-check.mjs.",
  );
  process.exit(1);
}

console.log(
  `staged-field check passed (${declaredAt.size} fields, ${ALLOWLIST.size} allowlisted, self-test ok)`,
);
