#!/usr/bin/env node
/**
 * Concept gate — constitutional changes to CLAUDEXOR_BIBLE.md require an
 * owner-approved CONCEPT-CHANGE(INV-…) marker in the commit message, and the
 * marker must COVER the invariants the commit actually touched.
 *
 * The Bible is the frozen concept seed external agents converge to. An agent
 * "helpfully" editing an invariant so its diff passes review is the primary
 * concept-drift vector; this gate makes such an edit impossible to land
 * silently:
 *   - any commit touching the Bible must carry CONCEPT-CHANGE(INV-…);
 *   - the named ids must be a SUPERSET of the invariant blocks whose text the
 *     commit changed (computed by block-level before/after comparison, so
 *     editing a paragraph deep inside INV-103 is attributed to INV-103 even
 *     when the changed lines carry no id);
 *   - INV ids are unique and never REMOVED (retire with a RETIRED marker —
 *     ids are stable and never reused);
 *   - preamble/heading edits (outside any invariant block) require only the
 *     marker itself.
 *
 * Usage:
 *   node scripts/concept-gate.mjs                    # checks HEAD
 *   node scripts/concept-gate.mjs --range A..B       # every commit in range
 *   node scripts/concept-gate.mjs --since-last-tag   # every commit since the
 *                                                    # previous v* tag (release)
 *
 * Assumptions: linear history is the norm (merge commits are inspected via
 * diff-tree -m against each parent). On a SHALLOW clone, a commit whose
 * parent is outside the clone boundary skips the before/after comparison
 * (the `show sha~1` failure path) — CI fetches depth=100 to keep realistic
 * ranges fully comparable; deepen the fetch if a range ever exceeds that.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIBLE = "CLAUDEXOR_BIBLE.md";
const MARKER_RE = /CONCEPT-CHANGE\(\s*(INV-\d{3}(?:\s*,\s*INV-\d{3})*)\s*\)/;
// Ids may carry annotations inside the bold span (e.g. **INV-042 (RETIRED)**).
const ID_RE = /\*\*(INV-\d{3})[^*]*\*\*/g;

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function invIds(text) {
  return new Set([...text.matchAll(ID_RE)].map((m) => m[1]));
}

/** Split the Bible into { id -> block text } (block = from its id line to the next id/heading). */
function invBlocks(text) {
  const blocks = new Map();
  const lines = text.split("\n");
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) blocks.set(current, buf.join("\n"));
    buf = [];
  };
  for (const line of lines) {
    const m = /\*\*(INV-\d{3})[^*]*\*\*/.exec(line);
    if (m) {
      flush();
      current = m[1];
      buf.push(line);
    } else if (/^#{1,3} /.test(line)) {
      flush();
      current = null;
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

function checkCommit(sha) {
  // -m: also inspect merge commits against their first parent so a Bible edit
  // cannot ride in unmarked through a merge.
  const changed = git(["diff-tree", "-m", "--no-commit-id", "--name-only", "-r", sha]).split("\n");
  if (!changed.includes(BIBLE)) return null;

  const msg = git(["log", "-1", "--format=%B", sha]);
  const marker = msg.match(MARKER_RE);
  if (!marker) {
    return (
      `commit ${sha.slice(0, 10)} touches ${BIBLE} without a CONCEPT-CHANGE(INV-…) marker in its message.\n` +
      `  Bible edits are constitutional: add the marker naming every affected invariant id,\n` +
      `  and add it only when the owner explicitly approved the change.`
    );
  }
  const markedIds = new Set(marker[1].split(",").map((s) => s.trim()));

  let before = "";
  try {
    before = git(["show", `${sha}~1:${BIBLE}`]);
  } catch {
    return null; // first commit introducing the file
  }
  const after = git(["show", `${sha}:${BIBLE}`]);

  // Founding rule: if the BEFORE version carries no invariant ids at all (the
  // pre-constitutional prose format), per-id coverage semantics cannot apply —
  // the entire numbered constitution is new surface and the marker's presence
  // (owner-approved rewrite) is the whole check.
  if (invIds(before).size === 0) {
    console.log(`concept-gate: ${sha.slice(0, 10)} carries ${marker[0]} (founding numbered-constitution commit)`);
    return null;
  }

  // Id hygiene: no invariant id may disappear (retire, don't delete).
  const gone = [...invIds(before)].filter((id) => !invIds(after).has(id));
  if (gone.length > 0) {
    return (
      `commit ${sha.slice(0, 10)} REMOVES invariant id(s) ${gone.join(", ")} from ${BIBLE}.\n` +
      `  Ids are stable and never reused: mark the invariant RETIRED (keeping its id) instead of deleting it.`
    );
  }

  // Marker coverage: the named ids must cover every invariant whose BLOCK text
  // changed (added, edited, or retired-in-place).
  const beforeBlocks = invBlocks(before);
  const afterBlocks = invBlocks(after);
  const touched = new Set();
  for (const [id, text] of afterBlocks) {
    if (!beforeBlocks.has(id) || beforeBlocks.get(id) !== text) touched.add(id);
  }
  for (const id of beforeBlocks.keys()) {
    if (!afterBlocks.has(id)) touched.add(id); // structural move; ids still exist per the check above
  }
  const uncovered = [...touched].filter((id) => !markedIds.has(id));
  if (uncovered.length > 0) {
    return (
      `commit ${sha.slice(0, 10)}: ${marker[0]} does not cover invariant(s) it changes: ${uncovered.sort().join(", ")}.\n` +
      `  The marker must name EVERY invariant whose text the commit adds, edits, or retires.`
    );
  }

  console.log(
    `concept-gate: ${sha.slice(0, 10)} carries ${marker[0]}; touched invariant blocks: ${[...touched].sort().join(", ") || "(preamble/headings only)"}`,
  );
  return null;
}

function checkDuplicateIds() {
  const text = git(["show", `HEAD:${BIBLE}`]);
  const seen = new Map();
  for (const m of text.matchAll(ID_RE)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  return dups.length > 0 ? `duplicate invariant id(s) in ${BIBLE}: ${dups.join(", ")}` : null;
}

function resolveShas() {
  const rangeIdx = process.argv.indexOf("--range");
  if (rangeIdx >= 0) {
    return git(["rev-list", process.argv[rangeIdx + 1]]).split("\n").filter(Boolean);
  }
  if (process.argv.includes("--since-last-tag")) {
    let baseTag = "";
    try {
      // The previous release tag strictly before HEAD (skip a tag pointing AT
      // HEAD so a tagged release checks its own cumulative range).
      baseTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD~1"]).trim();
    } catch {
      /* no prior tag — check full history below */
    }
    const range = baseTag ? `${baseTag}..HEAD` : "HEAD";
    return git(["rev-list", range]).split("\n").filter(Boolean);
  }
  return [git(["rev-parse", "HEAD"]).trim()];
}

const failures = [];
for (const sha of resolveShas()) {
  const err = checkCommit(sha);
  if (err) failures.push(err);
}
const dupErr = checkDuplicateIds();
if (dupErr) failures.push(dupErr);

if (failures.length > 0) {
  console.error("concept-gate FAILED:\n");
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log("concept-gate passed");
