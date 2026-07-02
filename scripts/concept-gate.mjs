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
 * Merge commits (including GitHub's synthetic refs/pull/N/merge, whose
 * auto-generated message can never carry a marker): the constituent commits
 * are checked individually by the range walk, so a CLEAN merge needs no
 * marker of its own. The merge itself is checked by direct text comparison
 * against every parent, piece by piece — each invariant block and the
 * non-block remainder (preamble/headings) — never via `diff-tree --cc`,
 * which is silent when a resolution picks one side wholesale. No parent's
 * invariant id may disappear in the result, and any piece matching NO
 * parent is hand-crafted resolution content that needs the same marker +
 * block-coverage discipline as a normal commit (including the
 * preamble/heading-only case).
 *
 * Shallow clones fail LOUDLY: if a commit in the range has a parent whose
 * object is outside the clone boundary, the gate errors and tells the
 * caller to deepen the fetch — it never silently skips the comparison
 * (CI checks out with fetch-depth: 0, so this only triggers on local
 * shallow experiments).
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

/**
 * Split the Bible into { blocks: id -> block text, remainder: string }.
 * A block runs from its id line to the next id/heading; the remainder is
 * every line outside any block (preamble, headings, inter-section prose).
 */
function splitBible(text) {
  const blocks = new Map();
  const remainder = [];
  const lines = text.split("\n");
  let current = null;
  let buf = [];
  // Trailing whitespace is trimmed so inserting a NEW invariant after an
  // existing one does not "touch" the neighbor merely by absorbing the blank
  // line that used to close its block.
  const flush = () => {
    if (current) blocks.set(current, buf.join("\n").replace(/\s+$/, ""));
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
      remainder.push(line);
    } else if (current) {
      buf.push(line);
    } else {
      remainder.push(line);
    }
  }
  flush();
  return { blocks, remainder: remainder.join("\n").replace(/\s+$/, "") };
}

function invBlocks(text) {
  return splitBible(text).blocks;
}

/** Bible text at a commit; "" when the file does not exist in that tree. */
function bibleAt(sha) {
  try {
    return git(["show", `${sha}:${BIBLE}`]);
  } catch {
    return "";
  }
}

/** Fail loudly (throw) when a parent object is outside a shallow clone. */
function assertParentReachable(sha, parent) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${parent}^{commit}`]);
  } catch {
    throw new Error(
      `concept-gate: parent ${parent.slice(0, 10)} of ${sha.slice(0, 10)} is outside this (shallow) clone — ` +
        `cannot compare the ${BIBLE} before/after. Deepen the fetch (fetch-depth: 0) and rerun.`,
    );
  }
}

function checkCommit(sha) {
  const parents = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/).slice(1);

  if (parents.length > 1) {
    // Merge commit. Its constituent commits are range-walked individually, so
    // requiring a marker HERE would deterministically fail every synthetic PR
    // merge (refs/pull/N/merge) whose message GitHub generates — including a
    // CLEAN auto-merge whose whole-file text matches neither parent because
    // each side edited a different region. The honest comparison unit is the
    // invariant BLOCK plus the non-block remainder (preamble/headings),
    // checked against every parent by direct text comparison (never
    // `diff-tree --cc`, which stays silent when a resolution picks one
    // parent's file wholesale and thereby drops the other parent's
    // invariants). The merge itself owes a marker only for content that
    // matches NO parent — hand-crafted resolution text.
    for (const p of parents) assertParentReachable(sha, p);
    const after = bibleAt(sha);
    const parentTexts = parents.map(bibleAt);
    if (parentTexts.every((t) => t === after)) return null; // Bible untouched by this merge

    // Id hygiene across the merge: an id present in ANY parent must survive,
    // even when the resolution picked the other parent's file wholesale.
    const afterIds = invIds(after);
    const gone = [...new Set(parentTexts.flatMap((t) => [...invIds(t)]))].filter((id) => !afterIds.has(id));
    if (gone.length > 0) {
      return (
        `merge commit ${sha.slice(0, 10)} REMOVES invariant id(s) ${gone.join(", ")} from ${BIBLE}.\n` +
        `  Ids are stable and never reused: mark the invariant RETIRED (keeping its id) instead of deleting it\n` +
        `  (a conflict resolution that picks one side's file wholesale still loses the other side's invariants).`
      );
    }

    const afterSplit = splitBible(after);
    const parentSplits = parentTexts.map(splitBible);
    const touched = new Set();
    for (const [id, text] of afterSplit.blocks) {
      if (!parentSplits.some((ps) => ps.blocks.get(id) === text)) touched.add(id);
    }
    const remainderTouched = !parentSplits.some((ps) => ps.remainder === afterSplit.remainder);
    if (touched.size === 0 && !remainderTouched) return null; // clean merge: every piece came from a parent

    // Hand-crafted resolution content: same marker discipline as a normal
    // commit — marker required even for preamble/heading-only changes,
    // coverage required for every invariant block matching NO parent.
    const msg = git(["log", "-1", "--format=%B", sha]);
    const marker = msg.match(MARKER_RE);
    if (!marker) {
      return (
        `merge commit ${sha.slice(0, 10)} itself changes ${BIBLE} beyond its parents (conflict resolution / evil merge)\n` +
        `  without a CONCEPT-CHANGE(INV-…) marker. Resolve Bible conflicts in a marked non-merge commit,\n` +
        `  or mark the merge itself if the owner approved the resolution.`
      );
    }
    const markedIds = new Set(marker[1].split(",").map((s) => s.trim()));
    const uncovered = [...touched].filter((id) => !markedIds.has(id));
    if (uncovered.length > 0) {
      return (
        `merge commit ${sha.slice(0, 10)}: ${marker[0]} does not cover invariant(s) its resolution changes: ${uncovered.sort().join(", ")}.\n` +
        `  The marker must name EVERY invariant whose text the merge resolution adds, edits, or retires.`
      );
    }
    console.log(
      `concept-gate: merge ${sha.slice(0, 10)} resolves ${BIBLE} conflicts under ${marker[0]}; touched invariant blocks: ${[...touched].sort().join(", ") || "(preamble/headings only)"}`,
    );
    return null;
  }

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
  const markedIds = new Set(marker[1].split(",").map((s) => s.trim()));

  let before = "";
  if (parents.length === 1) {
    assertParentReachable(sha, parents[0]);
    before = bibleAt(parents[0]); // "" when this commit introduces the file
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
  try {
    const err = checkCommit(sha);
    if (err) failures.push(err);
  } catch (e) {
    failures.push(e.message);
  }
}
const dupErr = checkDuplicateIds();
if (dupErr) failures.push(dupErr);

if (failures.length > 0) {
  console.error("concept-gate FAILED:\n");
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}
console.log("concept-gate passed");
