import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "@claudexor/core";
import type { GitDeliveryPair, GitResultRefusal } from "@claudexor/schema";
import { lstatPresent } from "./fs-presence.js";
import {
  composeOnTarget,
  parseRawRecords,
  pathspecBatches,
  type ComposeStats,
  type RawRecord,
} from "./object-compose.js";
import { materializeTree } from "./object-materialize.js";
import { sparseCheckoutRefusal } from "./object-sparse.js";
import { diskProgress, gitObserved } from "./git-observed.js";
import { SCRATCH_INDEX_CONFIG } from "./git-run.js";

export type PairRevertResult =
  | { ok: true; reverted: true; tree: string; changed: number; stats: ComposeStats }
  | {
      ok: false;
      reverted: false;
      refusal: GitResultRefusal;
      treeMutated: boolean;
      stats: ComposeStats | null;
      /** A path the delivery changed was changed again since (an overlap, or an edit
       * under the checkout): the revert cannot run on this tree. Every other refusal
       * (the sparse patterns, a path it cannot read, a store or Git fault) can, once
       * its cause is gone. */
      diverged: boolean;
    };

/** `path` holds exactly what checkout writes for blob `oid`: the same filters render it. */
async function holdsCheckoutOf(worktree: string, path: string, oid: string): Promise<boolean> {
  const file = join(worktree, path);
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  const rendered = createHash("sha256");
  await gitObserved(worktree, ["cat-file", "--filters", `--path=${path}`, oid], {
    label: "cat-file --filters",
    stdout: {
      write: (chunk) => void rendered.update(chunk),
      end: () => "",
    },
  });
  const onDisk = createHash("sha256");
  for await (const chunk of createReadStream(file)) onDisk.update(chunk as Buffer);
  return rendered.digest("hex") === onDisk.digest("hex");
}

/**
 * The tree a failed write actually left. A path whose content proof failed can
 * still hold exactly what checkout wrote (a filter that does not round-trip):
 * such a path enters the revert's base as the snapshot saw it, so it reverts
 * like any other. Every other path keeps M's entry, so a later edit of it (its
 * bytes or its mode) stays an overlap the composition refuses.
 */
async function asWrittenTree(
  worktree: string,
  postTree: string,
  currentTree: string,
  unproven: readonly string[],
): Promise<string> {
  const wanted = new Set(unproven);
  const records = parseRawRecords(
    (
      await gitObserved(
        worktree,
        ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", postTree, currentTree],
        { label: "diff-tree --raw (as written)" },
      )
    ).stdout,
  );
  let info = "";
  for (const record of records) {
    if (!wanted.has(record.src) || record.status === "A" || record.status === "D") continue;
    if (record.newMode !== record.oldMode) continue; // a chmod since the write is the user's
    if (await holdsCheckoutOf(worktree, record.src, record.oldOid))
      info += `${record.newMode} ${record.newOid}\t${record.src}\0`;
  }
  if (!info) return postTree;
  const scratch = mkdtempSync(join(tmpdir(), "claudexor-as-written-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0" };
    await gitObserved(worktree, [...SCRATCH_INDEX_CONFIG, "read-tree", postTree], {
      env,
      label: "read-tree (as written)",
    });
    await gitObserved(worktree, [...SCRATCH_INDEX_CONFIG, "update-index", "-z", "--index-info"], {
      env,
      label: "update-index --index-info (as written)",
      input: info,
    });
    const tree = await gitObserved(worktree, [...SCRATCH_INDEX_CONFIG, "write-tree"], {
      env,
      label: "write-tree (as written)",
    });
    return tree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Whether `path` is a file or symlink Git can reach: no parent is a symlink or a
 * file. Only ENOENT and ENOTDIR are absence: a path the revert cannot look at (a
 * parent it cannot search, an I/O error) is thrown, so the revert refuses with
 * nothing written instead of calling the addition gone.
 */
function reachableFile(worktree: string, path: string): boolean {
  try {
    const parts = path.split("/");
    for (let at = 1; at < parts.length; at += 1)
      if (!lstatPresent(join(worktree, ...parts.slice(0, at)))?.isDirectory()) return false;
    const stat = lstatPresent(join(worktree, path));
    return stat !== undefined && !stat.isDirectory();
  } catch (error) {
    throw new WorkspaceError(
      `the revert cannot tell whether ${path}, which the delivery added, is still as delivered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The pair's own records: what the delivery changed, T to M. */
async function deliveredRecords(
  worktree: string,
  pair: Pick<GitDeliveryPair, "pre_tree" | "post_tree">,
): Promise<RawRecord[]> {
  return parseRawRecords(
    (
      await gitObserved(
        worktree,
        [
          "diff-tree",
          "-r",
          "--raw",
          "-z",
          "--no-renames",
          "--no-abbrev",
          pair.pre_tree,
          pair.post_tree,
        ],
        { label: "diff-tree --raw (delivered pair)" },
      )
    ).stdout,
  );
}

/** The paths two trees differ in (a delivery's T to M, a result's B to C): what an
 * operation on them decides on, so what its snapshot reads by content. */
export async function pairPaths(
  worktree: string,
  from: string,
  to: string,
  env: Record<string, string> = {},
): Promise<string[]> {
  return parseRawRecords(
    (
      await gitObserved(
        worktree,
        ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev", from, to],
        { env, label: "diff-tree --raw (pair paths)" },
      )
    ).stdout,
  ).map((record) => record.src);
}

/** Which of `paths` `tree` holds, read through the same literal pathspec batches. */
async function heldBy(worktree: string, tree: string, paths: readonly string[]) {
  const held = new Set<string>();
  for (const batch of pathspecBatches(paths)) {
    const listed = await gitObserved(
      worktree,
      ["ls-tree", "-r", "-z", "--name-only", tree, "--", ...batch],
      { label: "ls-tree (delivered additions)" },
    );
    for (const path of listed.stdout.split("\0")) if (path) held.add(path);
  }
  return held;
}

/**
 * S with what the delivery added that S lacks while it is on disk: what the target's
 * ignore rules hide now (a name in `.git/info/exclude`, a rule written after the
 * apply, an ignored empty directory a delivered file replaced), and a file inside a
 * nested repository, which a snapshot leaves out. Such a path read as already gone
 * and the revert answered reverted:true over it. Exactly those paths are taken in as
 * they are, no others: a changed one is an overlap the composition refuses, an
 * unchanged one is removed, and every other ignored file stays out of reach.
 * `add -f` silently skips a path inside a nested repository (exit 0), so whatever
 * the written tree lacks is staged by `update-index --add`, which has no such rule
 * and, unlike `hash-object`, reads a symlink as a link; a path that still cannot
 * be taken in refuses the revert, naming it, with nothing written.
 */
async function withDeliveredAdditions(
  worktree: string,
  delivered: readonly RawRecord[],
  currentTree: string,
): Promise<{ ok: true; tree: string } | { ok: false; refusal: GitResultRefusal }> {
  const added = delivered
    .filter((record) => record.oldMode === "000000" && record.newMode !== "160000")
    .map((record) => record.src)
    .filter((path) => reachableFile(worktree, path));
  if (added.length === 0) return { ok: true, tree: currentTree };
  const inS = await heldBy(worktree, currentTree, added);
  const hidden = added.filter((path) => !inS.has(path));
  if (hidden.length === 0) return { ok: true, tree: currentTree };
  const scratch = mkdtempSync(join(tmpdir(), "claudexor-revert-snapshot-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0" };
    const progress = diskProgress(worktree);
    const git = (
      args: string[],
      label: string,
      extra: { input?: string; allowFailure?: boolean } = {},
    ) =>
      gitObserved(worktree, [...SCRATCH_INDEX_CONFIG, ...args], { env, label, progress, ...extra });
    const writeTree = async () =>
      (await git(["write-tree"], "write-tree (revert snapshot)")).stdout.trim();
    await git(["read-tree", currentTree], "read-tree (revert snapshot)");
    for (const batch of pathspecBatches(hidden))
      await git(["add", "-f", "--", ...batch], "add -f (delivered additions)");
    let tree = await writeTree();
    const forced = await heldBy(worktree, tree, hidden);
    const skipped = hidden.filter((path) => !forced.has(path));
    if (skipped.length === 0) return { ok: true, tree };
    const staged = await git(
      ["update-index", "--add", "-z", "--stdin"],
      "update-index --add (delivered additions)",
      { allowFailure: true, input: skipped.map((path) => `${path}\0`).join("") },
    );
    tree = await writeTree();
    const held = await heldBy(worktree, tree, skipped);
    const missing = skipped.filter((path) => !held.has(path)).sort();
    if (missing.length === 0) return { ok: true, tree };
    return {
      ok: false,
      refusal: {
        code: "revert_conflict",
        message:
          `revert refused: what the delivery added at ${missing.length} path(s) could not be read into the revert's view of the target, so the revert cannot tell whether it is still as delivered; nothing was written: ${missing.slice(0, 20).join(", ")}${staged.stderr.trim() ? ` (${staged.stderr.trim()})` : ""}`.slice(
            0,
            4_000,
          ),
        paths: missing.slice(0, 200),
        pathCount: missing.length,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Revert one object delivery on its actual pair (rev 12 B): with M the tree the
 * delivery wrote, T the target it started from and S the tree the worktree holds
 * now, `read-tree -m -i --aggressive M S T` keeps every later change outside
 * the delivery, and the paths both moved get the reversed M->T records by
 * today's apply rules (offsets allowed, overlap refused), all-or-nothing.
 * Revert IS composition with roles (base M, target S, candidate T), so one owner
 * holds the per-path semantics of both directions. S includes what the delivery
 * added that S lacks on disk ({@link withDeliveredAdditions}). A pair path outside
 * the sparse-checkout patterns refuses first: S cannot see what such a path holds.
 */
export async function revertDeliveryPair(input: {
  worktree: string;
  pair: Pick<GitDeliveryPair, "pre_tree" | "post_tree">;
  /** Tree of the current worktree snapshot S (tracked and untracked state). */
  currentTree: string;
  /** Taking back a failed write: the paths whose content proof did not hold. */
  unproven?: readonly string[];
}): Promise<PairRevertResult> {
  const refused = (refusal: GitResultRefusal): PairRevertResult => ({
    ok: false,
    reverted: false,
    treeMutated: false,
    stats: null,
    refusal,
    diverged: false,
  });
  const delivered = await deliveredRecords(input.worktree, input.pair);
  const outside = await sparseCheckoutRefusal(
    input.worktree,
    delivered.map((record) => record.src),
    "revert",
  );
  if (outside) return refused(outside);
  const additions = await withDeliveredAdditions(input.worktree, delivered, input.currentTree);
  if (!additions.ok) return refused(additions.refusal);
  const current = additions.tree;
  const composed = await composeOnTarget({
    repo: input.worktree,
    base: input.unproven?.length
      ? await asWrittenTree(input.worktree, input.pair.post_tree, current, input.unproven)
      : input.pair.post_tree,
    target: current,
    candidate: input.pair.pre_tree,
  });
  if (!composed.ok) {
    // A name that cannot be addressed keeps its own code; anything else is a conflict.
    const encoding = composed.refusal.code === "result_path_encoding";
    return {
      ok: false,
      reverted: false,
      treeMutated: false,
      stats: composed.stats,
      refusal: {
        ...composed.refusal,
        code: encoding ? "result_path_encoding" : "revert_conflict",
        message: `revert refused: ${composed.refusal.message}`,
      },
      diverged: !encoding,
    };
  }
  const written = await materializeTree({
    worktree: input.worktree,
    from: current,
    to: composed.tree,
    index: "temporary",
  });
  if (!written.ok) {
    const changed = written.refusal.code === "delivery_target_changed";
    return {
      ok: false,
      reverted: false,
      treeMutated: written.treeMutated,
      stats: composed.stats,
      refusal: {
        ...written.refusal,
        code: changed ? "revert_target_changed" : written.refusal.code,
      },
      diverged: changed,
    };
  }
  return {
    ok: true,
    reverted: true,
    tree: composed.tree,
    changed: written.changed,
    stats: composed.stats,
  };
}

/** The worktree's top level, the only directory materialization and composition address. */
export async function worktreeTopLevel(repo: string): Promise<string> {
  return (
    await gitObserved(repo, ["rev-parse", "--show-toplevel"], {
      label: "rev-parse --show-toplevel",
    })
  ).stdout.trim();
}
