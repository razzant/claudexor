#!/usr/bin/env node
// INV→verify link gate (M8, D6).
//
// The Bible's promise is that every invariant carries a `verify:` hint naming
// the artifact that PROVES it. A hint pointing at a deleted canary tag or a
// renamed file is worse than no hint — it reads as verified while proving
// nothing. This gate keeps the link honest for everything mechanically
// checkable:
//   1. every `- **INV-NNN**` block contains a `verify:` hint;
//   2. INV ids are unique;
//   3. every backticked canary tag `[INV-…:slug]` in a hint exists in a real
//      test/story file;
//   4. every backticked repo path with a file extension in a hint exists.
// Free-prose hints ("review question on any new adapter") are legitimately
// human-owned and stay unchecked — the gate never pretends otherwise.
//
// Negative control (same standard as staged-field v3): an embedded selfTest()
// runs synthetic cases before every real scan, so a gate that stops
// discriminating fails ITSELF instead of green-lighting the Bible.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Parse `- **INV-NNN**` blocks: id -> {line, text (incl. continuation lines)}. */
export function parseInvariantBlocks(bibleText) {
  const lines = bibleText.split("\n");
  const blocks = [];
  let current = null;
  for (const [i, line] of lines.entries()) {
    const start = line.match(/^- \*\*(INV-\d+)\*\*/);
    if (start) {
      if (current) blocks.push(current);
      current = { id: start[1], line: i + 1, text: line };
      continue;
    }
    if (current) {
      // A block continues through indented lines; any new top-level list item
      // or heading ends it.
      if (/^(\s+\S|$)/.test(line)) current.text += `\n${line}`;
      else {
        blocks.push(current);
        current = null;
      }
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

const CANARY_TAG_RE = /`\[(INV-\d+:[a-z0-9-]+)\]`/g;
// A checkable path ref: backticked, contains a slash, ends in a real file
// extension, no glob characters. Everything else in a hint is prose.
const PATH_REF_RE = /`([\w./-]*\/[\w./-]+\.(?:md|ts|mts|mjs|json|ya?ml|swift))`/g;

/**
 * Core check. `refExists` answers "does this canary tag appear in a test?",
 * `pathExists` answers "does this repo-relative file exist?" — injected so the
 * self-test can exercise the logic without touching the tree.
 */
export function findLinkViolations(blocks, refExists, pathExists) {
  const violations = [];
  const seen = new Map();
  for (const block of blocks) {
    if (seen.has(block.id)) {
      violations.push(
        `${block.id} (line ${block.line}): duplicate invariant id (first at line ${seen.get(block.id)})`,
      );
    } else {
      seen.set(block.id, block.line);
    }
    const verifyAt = block.text.indexOf("verify:");
    if (verifyAt === -1) {
      violations.push(`${block.id} (line ${block.line}): no verify: hint`);
      continue;
    }
    const hint = block.text.slice(verifyAt);
    for (const match of hint.matchAll(CANARY_TAG_RE)) {
      if (!refExists(match[1])) {
        violations.push(
          `${block.id} (line ${block.line}): verify hint names canary tag [${match[1]}] which exists in no test/story file`,
        );
      }
    }
    for (const match of hint.matchAll(PATH_REF_RE)) {
      if (!pathExists(match[1])) {
        violations.push(
          `${block.id} (line ${block.line}): verify hint names missing file ${match[1]}`,
        );
      }
    }
  }
  return violations;
}

function selfTest() {
  const bible = [
    "- **INV-900** wired invariant. verify: canary `[INV-900:wired]`;",
    "  `docs/REAL.md`.",
    "- **INV-901** no hint at all, only prose.",
    "- **INV-902** dangling refs. verify: canary `[INV-902:gone]` and",
    "  `docs/MISSING.md`.",
  ].join("\n");
  const blocks = parseInvariantBlocks(bible);
  const refExists = (tag) => tag === "INV-900:wired";
  const pathExists = (path) => path === "docs/REAL.md";
  const violations = findLinkViolations(blocks, refExists, pathExists);
  const expect = [
    ["INV-900", false],
    ["INV-901", true],
    ["INV-902", true],
  ];
  for (const [id, shouldViolate] of expect) {
    const actual = violations.some((v) => v.startsWith(`${id} `));
    if (actual !== shouldViolate) {
      console.error(
        `inv-verify-link SELF-TEST FAILED: ${id} expected violation=${shouldViolate}, got ${actual}. The gate no longer discriminates; fix the gate before trusting any verdict.`,
      );
      process.exit(1);
    }
  }
  if (violations.filter((v) => v.startsWith("INV-902 ")).length !== 2) {
    console.error(
      "inv-verify-link SELF-TEST FAILED: INV-902 must produce one violation per dangling ref",
    );
    process.exit(1);
  }
}

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

selfTest();

const bible = readFileSync(join(root, "CLAUDEXOR_BIBLE.md"), "utf8");
const blocks = parseInvariantBlocks(bible);
if (blocks.length === 0) {
  console.error("inv-verify-link check FAILED: no invariant blocks parsed from CLAUDEXOR_BIBLE.md");
  process.exit(1);
}

// Canary-tag haystack: every test/story file in TS packages + benchmarks +
// Swift test sources (a tag proven by an XCTest counts too).
const testFiles = [];
for (const r of [join(root, "packages"), join(root, "benchmarks"), join(root, "apps")]) {
  try {
    walk(r, testFiles, (p) => /\.(test|story)\.ts$/.test(p) || /Tests\/.*\.swift$/.test(p));
  } catch {
    /* absent root */
  }
}
const haystack = testFiles.map((p) => readFileSync(p, "utf8")).join("\n");
const refExists = (tag) => haystack.includes(`[${tag}]`);
const pathExists = (path) => existsSync(join(root, path));

const violations = findLinkViolations(blocks, refExists, pathExists);
if (violations.length > 0) {
  console.error("inv-verify-link check FAILED: Bible verify hints that prove nothing:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nA verify hint must point at a real artifact. Fix the hint, restore the artifact, or\n" +
      "rewrite the hint as an honest human-owned check (no backticked tag/path).",
  );
  process.exit(1);
}
console.log(
  `inv-verify-link check passed (${blocks.length} invariants, ${testFiles.length} test files scanned, self-test ok)`,
);
