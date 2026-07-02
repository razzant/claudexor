#!/usr/bin/env node
/**
 * Concept gate — constitutional changes to CLAUDEXOR_BIBLE.md require an
 * owner-approved CONCEPT-CHANGE(INV-…) marker in the commit message.
 *
 * The Bible is the frozen concept seed external agents converge to. An agent
 * "helpfully" editing an invariant so its diff passes review is the primary
 * concept-drift vector; this gate makes such an edit impossible to land
 * silently: any commit touching the Bible must name the affected invariant
 * ids in its message, and the marker is only added when the owner explicitly
 * approved the change.
 *
 * Also enforces id hygiene inside the file itself:
 *   - INV ids are unique;
 *   - INV ids are never REMOVED by a commit (retire with a RETIRED marker
 *     instead — numbers are stable and never reused).
 *
 * Usage:
 *   node scripts/concept-gate.mjs                 # checks HEAD (local/release)
 *   node scripts/concept-gate.mjs --range A..B    # checks every commit in range (CI)
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIBLE = "CLAUDEXOR_BIBLE.md";
const MARKER_RE = /CONCEPT-CHANGE\(\s*(INV-\d{3}(?:\s*,\s*INV-\d{3})*)\s*\)/;

const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function invIds(text) {
  return new Set([...text.matchAll(/\*\*(INV-\d{3})\*\*/g)].map((m) => m[1]));
}

function checkCommit(sha) {
  const changed = git(["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split("\n");
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

  // Id hygiene: no invariant id may disappear (retire, don't delete).
  let before = "";
  try {
    before = git(["show", `${sha}~1:${BIBLE}`]);
  } catch {
    return null; // first commit introducing the file
  }
  const after = git(["show", `${sha}:${BIBLE}`]);
  const gone = [...invIds(before)].filter((id) => !invIds(after).has(id));
  if (gone.length > 0) {
    return (
      `commit ${sha.slice(0, 10)} REMOVES invariant id(s) ${gone.join(", ")} from ${BIBLE}.\n` +
      `  Ids are stable and never reused: mark the invariant RETIRED (keeping its id) instead of deleting it.`
    );
  }

  // Print the informed-approval summary (added/edited ids per the diff).
  const diff = git(["diff", `${sha}~1..${sha}`, "--", BIBLE]);
  const touched = new Set();
  for (const line of diff.split("\n")) {
    if (/^[+-]/.test(line) && !/^[+-]{3}/.test(line)) {
      for (const m of line.matchAll(/INV-\d{3}/g)) touched.add(m[0]);
    }
  }
  console.log(
    `concept-gate: ${sha.slice(0, 10)} carries ${marker[0]}; INV ids in diff: ${[...touched].sort().join(", ") || "(none)"}`,
  );
  return null;
}

function checkDuplicateIds() {
  const text = git(["show", `HEAD:${BIBLE}`]);
  const seen = new Map();
  for (const m of text.matchAll(/\*\*(INV-\d{3})\*\*/g)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const dups = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  return dups.length > 0 ? `duplicate invariant id(s) in ${BIBLE}: ${dups.join(", ")}` : null;
}

const rangeIdx = process.argv.indexOf("--range");
const shas =
  rangeIdx >= 0
    ? git(["rev-list", process.argv[rangeIdx + 1]]).split("\n").filter(Boolean)
    : [git(["rev-parse", "HEAD"]).trim()];

const failures = [];
for (const sha of shas) {
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
