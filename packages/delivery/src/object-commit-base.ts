import type { GitObjectResult, GitResultRefusal } from "@claudexor/schema";
import {
  git,
  gitObserved,
  revParse,
  statusPorcelainMeaningful,
  treeOf,
} from "@claudexor/workspace";
import { typed } from "./object-custody.js";

/** What a commit-class delivery (`branch`, `commit`, `pr`) composes onto and commits
 * onto, and the live index it returns after a write it took back. */

/** Names of the paths two trees differ in. */
async function differingPaths(top: string, from: string, to: string): Promise<string[]> {
  const listed = await gitObserved(
    top,
    ["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to],
    { label: "diff-tree --name-only" },
  );
  return listed.stdout.split("\0").filter(Boolean);
}

/**
 * The tree a commit-class delivery composes onto: HEAD's, the tree it commits onto
 * (main's `apply --index` built the same commit). Its admission is a clean
 * `git status`; a snapshot that still differs from HEAD then holds only what the
 * user's marks hide from Git (an edit under assume-unchanged or skip-worktree, a
 * file deleted under one), which is the user's local state: it stays on disk and
 * out of the commit, and so does its mark unless Git itself clears it (Git clears
 * the skip-worktree mark of a present file when it reads a sparse checkout's
 * index). A result that changes such a path refuses, since writing it would
 * overwrite or recreate that state. A target Git calls dirty composes onto its
 * snapshot, as before, and the write refuses it as dirty.
 */
export async function commitOnto(
  repoRoot: string,
  top: string,
  result: GitObjectResult,
  snapshot: { commit: string; tree: string },
): Promise<{ commit: string; tree: string } | { refusal: GitResultRefusal }> {
  const headSha = await revParse(top, "HEAD");
  const headTree = await treeOf(top, headSha);
  if (headTree === snapshot.tree || (await statusPorcelainMeaningful(repoRoot)).length > 0)
    return snapshot;
  const changed = new Set(await differingPaths(top, result.base_tree, result.candidate_tree));
  const hidden = (await differingPaths(top, headTree, snapshot.tree)).filter((path) =>
    changed.has(path),
  );
  if (hidden.length > 0)
    return {
      refusal: typed(
        "delivery_conflict",
        `this result changes ${hidden.length} path(s) whose local state Git does not report (a file marked assume-unchanged or skip-worktree that was edited or deleted here), so committing it would overwrite or recreate that state; nothing was written: ${hidden.slice(0, 20).join(", ")}`,
        hidden,
      ),
    };
  return { commit: headSha, tree: headTree };
}

/** The commit's parent must hold the tree the result was composed onto: anything
 * else moved since, and committing M would undo that move. */
export async function headMovedSince(
  top: string,
  headSha: string,
  composedOnto: string,
): Promise<GitResultRefusal | null> {
  return (await treeOf(top, headSha)) === composedOnto
    ? null
    : typed("delivery_target_changed", "HEAD changed after final verify; refusing stale delivery");
}

/** After a taken-back commit-class write: the real index it moved returns to HEAD's
 * tree, unless it holds something else (then the receipt says why). Only the
 * entries the write changed are replaced (`-m -i`, the index alone): every other
 * entry keeps its stat data and the user's skip-worktree or assume-unchanged mark
 * (unless Git itself clears it: the skip-worktree mark of a present file, when it
 * reads a sparse checkout's index), which a plain `read-tree` would drop (in a
 * sparse checkout every excluded file would then read as deleted). */
export async function returnLiveIndex(
  top: string,
  postTree: string,
  headTree: string,
): Promise<string | null> {
  const staged = (await git(top, ["write-tree"])).stdout.trim();
  if (staged === headTree) return null; // a checkout that stopped never moved it
  if (staged !== postTree) return "the live index holds state outside the delivered tree";
  const reset = await git(top, ["read-tree", "-m", "-i", headTree]);
  if (reset.code !== 0)
    return `the live index stayed on the delivered tree: ${reset.stderr.trim()}`;
  await git(top, ["update-index", "-q", "--refresh"]);
  return null;
}
