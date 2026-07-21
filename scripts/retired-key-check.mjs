#!/usr/bin/env node
/**
 * Retired-key gate (S2, 2026-07-21 incident class).
 *
 * A config key removed from a PERSISTED CONFIG schema must land in the retired-key
 * registry. The incident: `default_portfolio`, `routing.default_policy`,
 * `budget.max_usd_per_run`, `harnesses.<id>.max_usd` were deleted from the schema
 * many releases ago but never registered, so a daemon that read an old v1/v2
 * config.yaml threw a bare strict-parse error (and /harnesses 500'd) instead of
 * sweeping the dead keys and moving on. Every schema removal is one registry
 * entry away from being silent migration debt; this gate makes the omission
 * impossible to land.
 *
 * SCOPE — persisted config schemas ONLY:
 *   - GlobalConfig  (~/.claudexor/v3/config.yaml)  → RETIRED_CONFIG_KEYS
 *   - ProjectConfig (.claudexor/config.yaml)        → RETIRED_PROJECT_CONFIG_KEYS
 * TrustConfig and ResolvedConfig are deliberately EXCLUDED. Trust is a
 * per-repo sensitive file whose strict parse stays strict BY DESIGN: an
 * unrecognized key in a trust file is a security signal, not migration debt,
 * so it must keep failing loudly and is never swept. Wire/control schemas are
 * likewise out of scope — they are not persisted config the user hand-carries
 * across upgrades. Excluded by construction: the extractor only reads the
 * two named `export const` schemas.
 *
 * MECHANISM (diff-scoped, mirrors scripts/concept-gate.mjs ref handling):
 *   1. Extract the schema key paths of GlobalConfig/ProjectConfig at a BASE ref
 *      and at the WORKING tree (or a target ref). Nested objects give dotted
 *      paths (routing.default_policy); a per-harness `z.record(z.string(),
 *      z.object({…}))` maps its value fields to a `*` wildcard segment
 *      (harnesses.*.max_usd) — matching the registry's own path-matcher shape.
 *   2. Load the CURRENT registry arrays RETIRED_CONFIG_KEYS /
 *      RETIRED_PROJECT_CONFIG_KEYS from packages/config/src/index.ts by parsing
 *      the source text for `path: [...]` literals (tolerant regex, same spirit
 *      as scripts/staged-field-check.mjs — no AST dependency).
 *   3. VERDICT: every path present in the BASE schema but absent from the
 *      WORKING schema must be COVERED by a registry entry for its schema
 *      (global vs project). A registry matcher covers a removed path when it
 *      matches a PREFIX of that path segment-for-segment, `*` matching any one
 *      segment — the same semantics as stripRetiredKeys() (deleting a subtree
 *      at the matcher removes every descendant). An uncovered removal FAILS
 *      with the exact path list and the fix instruction.
 *
 * SELF-TEST (mandatory negative control, staged-field-check.mjs pattern): an
 * embedded self-test runs BEFORE the real check. It proves the extractor
 * resolves nested + wildcard + subtree shapes, and proves the coverage checker
 * still DISCRIMINATES (an uncovered removal must go RED). A checker that stops
 * discriminating fails ITSELF loudly instead of green-lighting the tree.
 *
 * Usage:
 *   node scripts/retired-key-check.mjs                 # base = last v* tag, target = working tree
 *   node scripts/retired-key-check.mjs --base <ref>    # explicit base, target = working tree
 *   node scripts/retired-key-check.mjs --range A..B    # base = A, target = B (both git refs)
 *
 * Registry and schema are always read at the SAME target snapshot (working tree
 * by default, or B in --range), so the two are compared consistently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = "packages/schema/src/config.ts";
const REGISTRY_PATH = "packages/config/src/index.ts";

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// ---------------------------------------------------------------------------
// String/comment-aware micro-scanner. No AST dependency (the repo's gate style).
// atomicEnd(text, i): if text[i] begins a //-comment, /*…*/ comment, or a
// "…"/'…'/`…` string, return the index just PAST it; otherwise return i.
// ---------------------------------------------------------------------------
function atomicEnd(text, i) {
  const two = text.slice(i, i + 2);
  if (two === "//") {
    let j = i + 2;
    while (j < text.length && text[j] !== "\n") j += 1;
    return j;
  }
  if (two === "/*") {
    let j = i + 2;
    while (j < text.length && text.slice(j, j + 2) !== "*/") j += 1;
    return Math.min(j + 2, text.length);
  }
  const c = text[i];
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === c) return j + 1;
      j += 1;
    }
    return j;
  }
  return i;
}

/** Index of the delimiter matching the opener at openIdx (one of ([{). */
function matchDelim(text, openIdx) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const open = text[openIdx];
  const close = pairs[open];
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const a = atomicEnd(text, i);
    if (a !== i) {
      i = a;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error(`retired-key-check: unbalanced '${open}' while scanning schema source`);
}

/** Index of a `.<name>(` combinator at/after `from`, skipping strings/comments. */
function indexOfCombinator(text, name, from = 0) {
  const needle = `.${name}`;
  let i = from;
  while (i < text.length) {
    const a = atomicEnd(text, i);
    if (a !== i) {
      i = a;
      continue;
    }
    if (text.startsWith(needle, i)) {
      let j = i + needle.length;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      // The char right after the name must not extend it (`.object` not `.objectify`).
      const boundary = text[i + needle.length];
      if (text[j] === "(" && (boundary === undefined || boundary === "(" || /\s/.test(boundary)))
        return i;
    }
    i += 1;
  }
  return -1;
}

/** Body (between { and }) of the object literal passed to the `.object(` at combIdx. */
function objectBodyAt(text, combIdx) {
  let j = text.indexOf("(", combIdx);
  if (j < 0) return "";
  while (j < text.length) {
    const a = atomicEnd(text, j);
    if (a !== j) {
      j = a;
      continue;
    }
    if (text[j] === "{") break;
    if (text[j] === ")") return ""; // no object literal arg (e.g. z.object(ImportedRef))
    j += 1;
  }
  if (text[j] !== "{") return "";
  return text.slice(j + 1, matchDelim(text, j));
}

/** Split an object body into its top-level (depth-0) comma-separated segments. */
function topLevelSegments(body) {
  const segs = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const a = atomicEnd(body, i);
    if (a !== i) {
      i = a;
      continue;
    }
    const c = body[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      segs.push(body.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  segs.push(body.slice(start));
  return segs;
}

/** Leading `name:` of a field segment (skipping leading whitespace/comments). */
function fieldNameAndValue(seg) {
  let i = 0;
  while (i < seg.length) {
    if (/\s/.test(seg[i])) {
      i += 1;
      continue;
    }
    if (seg[i] === "/") {
      const a = atomicEnd(seg, i);
      if (a !== i) {
        i = a;
        continue;
      }
    }
    break;
  }
  const rest = seg.slice(i);
  const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
  if (!m) return null;
  return { name: m[1], value: rest.slice(m[0].length) };
}

/** Recursively collect dotted field paths from an object body. */
function collectPaths(objectBody, prefix, out) {
  for (const seg of topLevelSegments(objectBody)) {
    const fv = fieldNameAndValue(seg);
    if (!fv) continue;
    const path = [...prefix, fv.name];
    out.add(path.join("."));
    const recordIdx = indexOfCombinator(fv.value, "record");
    const objectIdx = indexOfCombinator(fv.value, "object");
    if (recordIdx >= 0 && (objectIdx < 0 || recordIdx < objectIdx)) {
      // z.record(z.string(), z.object({…})) → value fields live under `*`.
      const innerObj = indexOfCombinator(fv.value, "object", recordIdx);
      if (innerObj >= 0) collectPaths(objectBodyAt(fv.value, innerObj), [...path, "*"], out);
    } else if (objectIdx >= 0) {
      collectPaths(objectBodyAt(fv.value, objectIdx), path, out);
    }
  }
}

/** All key paths of a named `export const <schemaName> = z.object({…})`. */
function extractSchemaPaths(sourceText, schemaName) {
  const startRe = new RegExp(`export const ${schemaName}\\s*=`);
  const m = startRe.exec(sourceText);
  if (!m) throw new Error(`retired-key-check: schema ${schemaName} not found in ${SCHEMA_PATH}`);
  let slice = sourceText.slice(m.index + m[0].length);
  const end = /\nexport (?:const|type) /.exec(slice);
  if (end) slice = slice.slice(0, end.index);
  const objIdx = indexOfCombinator(slice, "object");
  if (objIdx < 0) throw new Error(`retired-key-check: no z.object in ${schemaName}`);
  const out = new Set();
  collectPaths(objectBodyAt(slice, objIdx), [], out);
  return out;
}

/** Parse `path: [...]` literals from a named registry array's source. */
function extractRegistry(sourceText, arrayName) {
  const decl = new RegExp(`${arrayName}[^=]*=\\s*\\[`).exec(sourceText);
  if (!decl)
    throw new Error(`retired-key-check: registry ${arrayName} not found in ${REGISTRY_PATH}`);
  // The declaration match ENDS at the array's own `[` (the type annotation's
  // `string[]` bracket must not be mistaken for the array opener).
  const openIdx = decl.index + decl[0].length - 1;
  const body = sourceText.slice(openIdx + 1, matchDelim(sourceText, openIdx));
  const matchers = [];
  for (const pm of body.matchAll(/path:\s*\[([^\]]*)\]/g)) {
    matchers.push([...pm[1].matchAll(/"([^"]*)"/g)].map((s) => s[1]));
  }
  return matchers;
}

/** A registry matcher covers a removed path when it matches a prefix (`*` = any one segment). */
function matcherCovers(matcher, pathSegs) {
  if (matcher.length > pathSegs.length) return false;
  return matcher.every((seg, i) => seg === "*" || seg === pathSegs[i]);
}

/** Paths in base but not in working that no registry matcher covers. */
function computeViolations(basePaths, workingPaths, matchers) {
  const violations = [];
  for (const p of [...basePaths].filter((x) => !workingPaths.has(x)).sort()) {
    if (!matchers.some((m) => matcherCovers(m, p.split(".")))) violations.push(p);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Embedded negative control (staged-field-check.mjs pattern). Proves the
// extractor resolves nested/wildcard/subtree shapes AND the coverage checker
// still discriminates, BEFORE trusting any verdict on the real tree.
// ---------------------------------------------------------------------------
const SELFTEST_SCHEMA = [
  "export const GlobalConfig = z",
  "  .object({",
  "    version: z.literal(1).default(1).describe('has an z.object( decoy in prose'),",
  "    routing: z",
  "      .object({",
  "        goal: RoutingGoal.default('auto'),",
  "        default_policy: z.string(),",
  "      })",
  "      .strict()",
  "      .default({}),",
  "    secrets: z.object({ ref: z.string() }).strict(),",
  "    harnesses: z",
  "      .record(",
  "        z.string(),",
  "        z",
  "          .object({",
  "            enabled: z.boolean().default(true),",
  "            max_usd: z.number(),",
  "          })",
  "          .strict(),",
  "      )",
  "      .default({}),",
  "  })",
  "  .strict();",
  "export type GlobalConfig = z.infer<typeof GlobalConfig>;",
].join("\n");

function fail(msg) {
  console.error(
    `retired-key SELF-TEST FAILED: ${msg}\nThe gate no longer discriminates; fix the gate before trusting any verdict.`,
  );
  process.exit(1);
}

function selfTest() {
  const base = extractSchemaPaths(SELFTEST_SCHEMA, "GlobalConfig");
  // 1. Extraction resolves the real config.ts shapes.
  for (const expected of [
    "version",
    "routing",
    "routing.goal",
    "routing.default_policy", // nested path
    "secrets",
    "secrets.ref",
    "harnesses",
    "harnesses.*.enabled",
    "harnesses.*.max_usd", // wildcard (per-harness record) path
  ]) {
    if (!base.has(expected)) fail(`extractor did not resolve '${expected}'`);
  }
  // A `.object(` decoy inside a describe() string must NOT become a path.
  if (base.has("version.ref") || [...base].some((p) => p.includes("decoy")))
    fail("extractor treated a string-literal .object( as structure");

  // 2. Coverage discrimination: simulate removing keys, vary the registry.
  const removed = ["routing.default_policy", "harnesses.*.max_usd", "secrets", "secrets.ref"];
  const working = new Set([...base].filter((p) => !removed.includes(p)));
  const cases = [
    {
      name: "full registry covers every removal (incl. subtree via prefix)",
      registry: [["routing", "default_policy"], ["harnesses", "*", "max_usd"], ["secrets"]],
      expect: [],
    },
    {
      name: "missing wildcard entry is flagged",
      registry: [["routing", "default_policy"], ["secrets"]],
      expect: ["harnesses.*.max_usd"],
    },
    {
      name: "missing nested entry is flagged",
      registry: [["harnesses", "*", "max_usd"], ["secrets"]],
      expect: ["routing.default_policy"],
    },
    {
      name: "empty registry flags every removal",
      registry: [],
      expect: ["harnesses.*.max_usd", "routing.default_policy", "secrets", "secrets.ref"],
    },
  ];
  for (const c of cases) {
    const got = computeViolations(base, working, c.registry).sort();
    const want = [...c.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want))
      fail(`case '${c.name}' — expected [${want.join(", ")}], got [${got.join(", ")}]`);
  }
}

// ---------------------------------------------------------------------------
// Ref resolution (concept-gate.mjs conventions).
// ---------------------------------------------------------------------------
function resolveRefs() {
  const args = process.argv.slice(2);
  let baseRef = null;
  let targetRef = null;
  const rangeI = args.indexOf("--range");
  if (rangeI >= 0) {
    const [a, b] = (args[rangeI + 1] ?? "").split("..");
    baseRef = a || null;
    targetRef = b || null;
  }
  const baseI = args.indexOf("--base");
  if (baseI >= 0) baseRef = args[baseI + 1];
  if (!baseRef) baseRef = git(["describe", "--tags", "--abbrev=0"]).trim();
  return { baseRef, targetRef };
}

/** File text at a git ref, or from the working tree when ref is null. */
function fileAt(ref, relPath) {
  if (ref === null) return readFileSync(join(root, relPath), "utf8");
  return git(["show", `${ref}:${relPath}`]);
}

function main() {
  selfTest();

  const { baseRef, targetRef } = resolveRefs();

  // Diagnostic: print the resolved schema key paths and exit (proves extraction).
  if (process.argv.includes("--dump")) {
    for (const name of ["GlobalConfig", "ProjectConfig"]) {
      const paths = [...extractSchemaPaths(fileAt(targetRef, SCHEMA_PATH), name)].sort();
      console.log(`\n${name} (${paths.length} paths):`);
      for (const p of paths) console.log(`  ${p}`);
    }
    return;
  }

  const baseSchema = fileAt(baseRef, SCHEMA_PATH);
  const targetSchema = fileAt(targetRef, SCHEMA_PATH);
  const registrySrc = fileAt(targetRef, REGISTRY_PATH);

  const schemas = [
    { name: "GlobalConfig", registry: "RETIRED_CONFIG_KEYS" },
    { name: "ProjectConfig", registry: "RETIRED_PROJECT_CONFIG_KEYS" },
  ];

  const failures = [];
  for (const s of schemas) {
    const basePaths = extractSchemaPaths(baseSchema, s.name);
    const workingPaths = extractSchemaPaths(targetSchema, s.name);
    const matchers = extractRegistry(registrySrc, s.registry);
    const violations = computeViolations(basePaths, workingPaths, matchers);
    if (violations.length > 0) failures.push({ ...s, violations });
    console.log(
      `retired-key-check: ${s.name} — ${basePaths.size} paths at ${baseRef}, ` +
        `${workingPaths.size} at ${targetRef ?? "working tree"}, ` +
        `${matchers.length} ${s.registry} entries, ${violations.length} uncovered removal(s)`,
    );
  }

  if (failures.length > 0) {
    console.error("\nretired-key-check FAILED: config key(s) removed from a persisted schema");
    console.error("without a matching retired-key registry entry:\n");
    for (const f of failures) {
      for (const v of f.violations)
        console.error(`  ${f.name}: ${v}  → add to ${f.registry} in ${REGISTRY_PATH}`);
    }
    console.error(
      `\nA persisted-config key removed from the schema but absent from the registry makes old\n` +
        `config files fail strict parse with a bare error (2026-07-21 incident). Add a ${schemas[0].registry}\n` +
        `(or ${schemas[1].registry}) entry: { path: [...], retired: "<one-line reason>" }.\n` +
        `Use a "*" segment for a per-harness key (e.g. ["harnesses", "*", "max_usd"]).`,
    );
    process.exit(1);
  }
  console.log(`retired-key-check passed (base ${baseRef}, self-test ok)`);
}

main();
