import { WorkspaceError } from "@claudexor/core";
import type { GitDeliveryPair, GitObjectFormat, GitResultRefusal } from "@claudexor/schema";
import {
  git,
  gitFaultRefusalCode,
  GitOperationError,
  importIntoRepository,
  pairPaths,
  readRevertAnchor,
  readRevertPair,
  repositoryEndpoint,
  retainInObjectStore,
  revertDeliveryPair,
  revertWorkingTreePatch,
  snapshotTree,
  storeBoundaryCommit,
  treeOf,
  worktreeTopLevel,
  type PairRevertResult,
} from "@claudexor/workspace";
import { redactSecrets } from "@claudexor/util";

/** A delivery's object custody: what enters the user's repository before Git reads
 * it, the pair kept before a write, and that pair's revert. */

export const typed = (
  code: GitResultRefusal["code"],
  message: string,
  paths: string[] = [],
): GitResultRefusal => ({
  code,
  message,
  paths: paths.slice(0, 200),
  pathCount: paths.length,
});

export const objectsMissing = (
  missing: readonly string[],
  formats?: { kept: GitObjectFormat; repository: GitObjectFormat },
) =>
  typed(
    "result_objects_missing",
    formats
      ? `${missing.length} Git object(s) of this result are ${formats.kept} objects and this repository uses ${formats.repository}, so Git cannot read them here (first ${missing[0]}); nothing was written`
      : `${missing.length} Git object(s) of this result are in neither the project repository nor Claudexor's project store (first ${missing[0]}); nothing was written`,
    [],
  );

/**
 * A store or Git fault on the way to a write, as a refusal: no space, a stalled or
 * killed Git child, a prune that does not finish, a store that cannot be read.
 * A full disk is `space_insufficient` whether Git or a direct write met it.
 * Nothing was written; anything else is a bug and stays thrown.
 */
export function storeFaultRefusal(error: unknown, consequence: string): GitResultRefusal {
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (!(error instanceof WorkspaceError) && typeof errno !== "string") throw error;
  return typed(
    error instanceof GitOperationError
      ? gitFaultRefusalCode(error.code)
      : errno === "ENOSPC" || errno === "EDQUOT"
        ? "space_insufficient"
        : "git_failed",
    `${consequence}: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}`,
  );
}

/** Objects of a result or pair the user's repository must hold before Git reads them (D1). */
export async function importOrRefuse(
  projectRoot: string,
  repo: string,
  roots: string[],
): Promise<GitResultRefusal | null> {
  try {
    const imported = await importIntoRepository({ projectRoot, repo, roots });
    return imported.missing.length === 0
      ? null
      : objectsMissing(imported.missing, imported.formatMismatch);
  } catch (error) {
    return storeFaultRefusal(
      error,
      "the result's objects could not be imported, so nothing was written",
    );
  }
}

/** Store T and M beyond T's boundary under `owner` so revert survives the user's
 * gc; the root record names the pair, so a replay can recover it. */
async function retainDeliveryPair(
  projectRoot: string,
  top: string,
  pair: GitDeliveryPair,
  owner: string,
): Promise<void> {
  const boundary = await storeBoundaryCommit(top, pair.pre_commit);
  await retainInObjectStore({
    projectRoot,
    source: await repositoryEndpoint(top),
    roots: [pair.post_tree, pair.pre_commit],
    boundary: boundary ? { commit: boundary, tree: await treeOf(top, boundary) } : null,
    objectFormat: pair.object_format,
    owner,
    pair,
  });
}

/**
 * Keep the pair BEFORE the target is written (M's objects are already in the
 * user's repository after composition): a store fault (no space, a stalled or
 * killed Git child, a prune that does not finish) then refuses with nothing
 * written, instead of leaving an applied tree that revert can never undo.
 */
export async function retainPairOrRefuse(
  projectRoot: string,
  top: string,
  pair: GitDeliveryPair,
  owner: string,
): Promise<GitResultRefusal | null> {
  try {
    await retainDeliveryPair(projectRoot, top, pair, owner);
    return null;
  } catch (error) {
    return storeFaultRefusal(
      error,
      "the delivery pair could not be kept for revert, so nothing was written",
    );
  }
}

/** Revert one object delivery on its actual pair (rev 12 B), importing T and M first (D1). */
export async function revertDeliveredPairUnlocked(
  repoRoot: string,
  pair: GitDeliveryPair,
  projectRoot = repoRoot,
  /** Taking back a failed write: the paths whose content proof did not hold. */
  unproven?: readonly string[],
): Promise<{
  reverted: boolean;
  removed: string[];
  reason?: string;
  reasonCode?: "postimage_diverged" | "reverse_apply_failed";
  refusal?: GitResultRefusal;
}> {
  const top = await worktreeTopLevel(repoRoot);
  const missing = await importOrRefuse(projectRoot, top, [pair.pre_tree, pair.post_tree]);
  if (missing)
    return {
      reverted: false,
      removed: [],
      reason: missing.message,
      reasonCode: "reverse_apply_failed",
      refusal: missing,
    };
  const failed = (refusal: GitResultRefusal) => ({
    reverted: false,
    removed: [],
    reason: refusal.message,
    reasonCode: "reverse_apply_failed" as const,
    refusal,
  });
  let current: string;
  try {
    // What the delivery changed is read by content, never taken from the stat cache:
    // a file that kept its size and times still holds what it holds.
    const exact = await pairPaths(top, pair.pre_tree, pair.post_tree);
    current = await treeOf(top, await snapshotTree(repoRoot, exact));
  } catch (error) {
    return failed(storeFaultRefusal(error, "the revert could not run, so nothing was restored"));
  }
  let reverted: PairRevertResult;
  try {
    reverted = await revertDeliveryPair({
      worktree: top,
      pair,
      currentTree: current,
      ...(unproven ? { unproven } : {}),
    });
  } catch (error) {
    // Thrown from inside the revert, possibly after its checkout began: nothing
    // here says what it restored, so neither "nothing" nor "all" is claimed.
    return failed(
      storeFaultRefusal(
        error,
        "the revert stopped on an unexpected fault, so what it restored is unknown",
      ),
    );
  }
  if (reverted.ok) return { reverted: true, removed: [] };
  // "Changed after this turn" only for a later edit of what the delivery changed;
  // the sparse patterns, a path the revert cannot read, a store or Git fault leave
  // the revert available once their cause is gone, which the refusal names.
  return {
    reverted: false,
    removed: [],
    reason: reverted.refusal.message,
    reasonCode:
      reverted.diverged && !reverted.treeMutated ? "postimage_diverged" : "reverse_apply_failed",
    refusal: reverted.refusal,
  };
}

/**
 * Take a failed write back on its retained pair, under the revert's own law: a
 * later user edit outside the delivery is kept, one overlapping it refuses and
 * nothing is overwritten. Null when the write is gone, else why it stays; a
 * restore that cannot run is that same honest answer, never a throw over a
 * changed tree.
 */
export async function takeBackWrite(
  repoRoot: string,
  pair: GitDeliveryPair,
  projectRoot: string,
  unproven?: readonly string[],
): Promise<string | null> {
  try {
    const back = await revertDeliveredPairUnlocked(repoRoot, pair, projectRoot, unproven);
    return back.reverted ? null : (back.reason ?? "the revert refused");
  } catch (error) {
    return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  }
}

/** The one phrase every delivery path says when its write stays on the target. */
export const RECOVERY_REQUIRED = "RECOVERY REQUIRED — user state was not overwritten";

/** A result whose trees are equal has nothing to deliver in any mode (a legacy
 * patch's "empty patch; no commit created"). */
export const EMPTY_RESULT_REFUSAL = "empty result; no commit created and nothing written";

/** A legacy refusal's detail, with what became of leaving the new branch. */
export const detailWithCleanup = (detail: string, cleanupIssue: string | null) =>
  [detail, cleanupIssue, cleanupIssue ? RECOVERY_REQUIRED : null].filter(Boolean).join("; ");

/** Where a delivery that made a new branch returns HEAD to. */
export interface RestorePoint {
  ref: string;
  detached: boolean;
  headSha: string;
}

/** A delivery's own checkouts (a new branch, the way back): no hooks, and the
 * sparse-checkout patterns off. On, Git reapplies them to every entry and deletes a
 * clean file outside them that has no skip-worktree mark, which the delivery never
 * touched; off, only the paths the two commits differ in move. */
export const CHECKOUT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.sparseCheckout=false",
];

/** The one restore checkout: the branch HEAD was on, never a namesake Git would
 * recreate from a remote-tracking branch after the user deleted it, nor a file
 * of that name (`--` makes the argument a revision only). */
export function restoreCheckoutArgs(at: RestorePoint): string[] {
  return [
    ...CHECKOUT_CONFIG,
    "checkout",
    ...(at.detached ? ["--detach", at.ref] : ["--no-guess", at.ref, "--"]),
  ];
}

/** How to return by hand when the restore checkout failed; its branch may be gone. */
const wayBack = (at: RestorePoint) =>
  at.detached
    ? `run git checkout --detach ${at.headSha} to return`
    : `check out ${at.ref} if it still exists, otherwise run git checkout --detach ${at.headSha} to return`;

/** The restore checkout failed before the new branch could be left: HEAD stays on it. */
export const failedToLeaveBranch = (branch: string, stderr: string, at: RestorePoint) =>
  `failed to leave branch ${branch}: ${stderr.trim()}; ${wayBack(at)}`;

/** HEAD returned, but the delivery's new branch could not be deleted: only that ref stays. */
export const branchLeftBehind = (branch: string, stderr: string) =>
  `the delivery's branch ${branch} is left behind (deleting it failed: ${stderr.trim()}); remove it with git branch -D ${branch}`;

/** A `pr` whose push failed keeps its commit on the local branch and checks out
 * where HEAD was (INV-114); when that checkout fails, HEAD stays on the branch
 * and the detail says how to return. Both delivery paths answer this. */
export async function afterFailedPush(
  top: string,
  push: { stderr: string },
  branch: string,
  commit: string,
  at: RestorePoint,
) {
  const back = await git(top, restoreCheckoutArgs(at));
  const kept = `push failed: ${push.stderr.trim()}; the local branch ${branch} keeps the committed work`;
  return {
    mode: "pr" as const,
    applied: false,
    branch,
    commit,
    treeMutated: back.code !== 0,
    detail:
      back.code === 0
        ? kept
        : `${kept}, and HEAD stayed on it: checking out ${at.ref} failed (${back.stderr.trim()}); ${RECOVERY_REQUIRED}: ${wayBack(at)}`,
  };
}

/** Run-owned revert from the external immutable anchor: an object anchor reverts
 * on its recorded pair; a legacy patch anchor keeps today's reverse apply. An
 * anchor that is gone or unreadable refuses before anything is attempted. */
export async function revertAnchorUnlocked(repo: string, anchorId: string, projectRoot = repo) {
  let anchor: { pair: GitDeliveryPair } | { patch: string };
  try {
    const pair = readRevertPair(projectRoot, anchorId);
    anchor = pair ? { pair } : { patch: readRevertAnchor(repo, anchorId) };
  } catch (error) {
    const cause = redactSecrets(error instanceof Error ? error.message : String(error));
    const why =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "is missing"
        : `is unreadable (${cause.slice(0, 500)})`;
    return {
      reverted: false,
      removed: [],
      reason: `the retained revert anchor ${anchorId} ${why}; nothing was changed`,
      reasonCode: "reverse_apply_failed" as const,
    };
  }
  return "pair" in anchor
    ? revertDeliveredPairUnlocked(repo, anchor.pair, projectRoot)
    : revertWorkingTreePatch(repo, anchor.patch);
}

/** What a take-back restores: the target's tree as Git holds it, each restored file
 * written again through the target's checkout conversion. A file whose conversion does
 * not round-trip (an LF file under `core.autocrlf=true`) comes back with converted
 * bytes; its size moved, so Git's status lists it while its diff is empty. */
const TAKEN_BACK =
  "the write was taken back, so the target is unchanged as Git holds it (a restored file is written again through this checkout's conversion: one that does not round-trip, an LF file under core.autocrlf for one, can come back with converted bytes, and git status can then list it although git diff shows no change)";

/** The refusal of a write that reached the target, saying what became of that write;
 * `leftover`: the write is gone, but something else the delivery made stays (HEAD
 * on its branch, or that branch), which the detail names. */
export function afterWriteRefusal(
  refusal: GitResultRefusal,
  stays: string | null,
  leftover = false,
): GitResultRefusal {
  const gone = leftover ? "the write was taken back" : TAKEN_BACK;
  return {
    ...refusal,
    message:
      stays === null
        ? `${refusal.message}; ${gone}`
        : `${refusal.message}; the write could not be taken back (${stays}); ${RECOVERY_REQUIRED}`,
  };
}
