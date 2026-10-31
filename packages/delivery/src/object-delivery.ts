import { runCapture } from "@claudexor/core";
import {
  GIT_OBJECTS_V1,
  type FinalVerifyRecord,
  type GitDeliveryPair,
  type GitObjectResult,
  type GitResultRefusal,
  type PublicationRefusal,
} from "@claudexor/schema";
import type { GateSpec } from "@claudexor/review";
import {
  composeOnTarget,
  git,
  materializeTree,
  occupiedByWrite,
  pairPaths,
  retainedDeliveryPair,
  revParse,
  snapshotTree,
  statusPorcelainMeaningful,
  treeOf,
  worktreeTopLevel,
} from "@claudexor/workspace";
import { claudexorOwnedRoot, newId, redactSecrets } from "@claudexor/util";
import { finalVerifyBlocks, finalVerifyPatch, type VerifyEventLog } from "./final-verifier.js";
import { commitOnto, headMovedSince, returnLiveIndex } from "./object-commit-base.js";
import {
  afterWriteRefusal,
  CHECKOUT_CONFIG,
  EMPTY_RESULT_REFUSAL,
  importOrRefuse,
  afterFailedPush,
  branchLeftBehind,
  failedToLeaveBranch,
  RECOVERY_REQUIRED,
  restoreCheckoutArgs,
  retainPairOrRefuse,
  storeFaultRefusal,
  takeBackWrite,
  typed,
} from "./object-custody.js";
import { PR_UNRENDERED_REFUSAL } from "./publication.js";
import { gatePublication } from "./publication-gate.js";

export interface ObjectDeliverOptions {
  mode: "apply" | "branch" | "commit" | "pr";
  branch?: string;
  message?: string;
  prBodyFile?: string;
  /** Config root holding the provisioned publication scanner (#555). */
  scannerConfigDir?: string;
  protectedApply?: boolean;
  /** The rendered patch view, when one exists (pr inspects it before any push). */
  renderedPatch?: string | null;
  /** Project root owning the object store (defaults to the delivery target). */
  projectRoot?: string;
  /** Path whose existence keeps the delivery pair's objects (the run directory). */
  owner?: string;
}

/** An object result (canonical) with its rendered view when one exists. */
export interface ObjectDelivery {
  result: GitObjectResult;
  renderedPatch: string | null;
}

export interface ObjectDeliverResult {
  mode: ObjectDeliverOptions["mode"];
  applied: boolean;
  refused?: boolean;
  treeMutated?: boolean;
  alreadyApplied?: boolean;
  branch?: string;
  commit?: string;
  prUrl?: string;
  detail?: string;
  refusal?: GitResultRefusal;
  /** The publication scanner stopped `pr` before anything was created or sent. */
  publicationRefusal?: PublicationRefusal;
  finalVerify: FinalVerifyRecord;
  targetPreimageSha: string;
  /** The actual delivery pair (T, M), present while a written tree stays on the
   * target; its objects are in the project store under the delivery's owner. */
  deliveryPair?: GitDeliveryPair;
  /** The write is gone but HEAD could not return to where it was: no revert
   * anchor can bring it back, only the way back the detail names. */
  headStranded?: boolean;
}

const NOT_ATTEMPTED = (reason: string): FinalVerifyRecord => ({
  attempted: false,
  base_sha: null,
  applied_cleanly: null,
  gates_passed: null,
  gates: [],
  duration_ms: null,
  reason,
});

function refused(
  mode: ObjectDeliverOptions["mode"],
  targetPreimageSha: string,
  refusal: GitResultRefusal,
  finalVerify: FinalVerifyRecord = NOT_ATTEMPTED(refusal.code),
): ObjectDeliverResult {
  return {
    mode,
    applied: false,
    refused: true,
    treeMutated: false,
    detail: refusal.message,
    refusal,
    finalVerify,
    targetPreimageSha,
  };
}

/**
 * Deliver an object result onto the current target (rev 14 A + C), one owner
 * for every mode: import first, compose B..C onto T in a temporary index,
 * verify the composed tree in a fresh private clone, recheck T, keep the pair
 * (T, M) in the project store, then write M with the mode's admission. `pr`
 * of an unrendered result refuses (G). The caller holds the repository
 * mutation lease.
 */
export async function verifyAndDeliverResultUnlocked(
  repoRoot: string,
  delivery: ObjectDelivery,
  deliverOptions: Omit<ObjectDeliverOptions, "renderedPatch">,
  gates: GateSpec[],
  authorize: ((finalVerify: FinalVerifyRecord) => string | null) | undefined,
  log: VerifyEventLog,
): Promise<ObjectDeliverResult> {
  const { result } = delivery;
  const options: ObjectDeliverOptions = {
    ...deliverOptions,
    renderedPatch: delivery.renderedPatch,
  };
  const top = await worktreeTopLevel(repoRoot);
  const mode = options.protectedApply ? "apply" : options.mode;
  // Decided from the request alone, before the snapshot (a dirty target's writes
  // an object) and any import, verify or mutation: no write is ever attempted for
  // an empty result, nor a branch, commit or push for a result without a rendered
  // view (G).
  if (result.base_tree === result.candidate_tree)
    return {
      mode,
      applied: false,
      refused: true,
      treeMutated: false,
      detail: EMPTY_RESULT_REFUSAL,
      finalVerify: NOT_ATTEMPTED("empty_result"),
      targetPreimageSha: await revParse(top, "HEAD"),
    };
  if (mode === "pr" && (options.renderedPatch === null || options.renderedPatch === undefined))
    return refused(
      mode,
      await revParse(top, "HEAD"),
      typed("pr_unrendered_result", PR_UNRENDERED_REFUSAL),
    );
  let prepared: PreparedWrite | ObjectDeliverResult;
  try {
    prepared = await composeAndVerify(repoRoot, top, result, options, mode, gates, authorize, log);
  } catch (error) {
    const refusal = storeFaultRefusal(
      error,
      "the delivery could not be prepared, so nothing was written",
    );
    return refused(mode, await revParse(top, "HEAD"), refusal);
  }
  if (!("pair" in prepared)) return prepared;
  const { pair, finalVerify, targetPreimageSha } = prepared;
  const projectRoot = options.projectRoot ?? repoRoot;
  if (mode === "apply") {
    const custody = await retainPairOrRefuse(projectRoot, top, pair, options.owner ?? projectRoot);
    if (custody) return refused(mode, targetPreimageSha, custody, finalVerify);
    const written = await materializeTree({
      worktree: top,
      from: pair.pre_tree,
      to: pair.post_tree,
      index: "temporary",
    });
    if (!written.ok) {
      if (!written.treeMutated)
        return refused(mode, targetPreimageSha, written.refusal, finalVerify);
      // Not applied means unchanged (INV-114): the write goes back on its retained pair.
      const stays = await takeBackWrite(repoRoot, pair, projectRoot, written.unproven);
      const refusal = afterWriteRefusal(written.refusal, stays);
      return {
        ...refused(mode, targetPreimageSha, refusal, finalVerify),
        ...(stays === null ? {} : { treeMutated: true, deliveryPair: pair }),
      };
    }
    return {
      mode,
      applied: true,
      treeMutated: true,
      finalVerify,
      targetPreimageSha,
      deliveryPair: pair,
    };
  }
  return {
    ...(await commitClass(repoRoot, top, pair, options, mode)),
    finalVerify,
    targetPreimageSha,
  };
}

/** A delivery ready to write: its pair, its fresh verify and the snapshot it rests on. */
interface PreparedWrite {
  pair: GitDeliveryPair;
  finalVerify: FinalVerifyRecord;
  targetPreimageSha: string;
}

/**
 * Everything before the first write: snapshot, import, composition, the fresh
 * verify and the target recheck. An answer other than a pair is final (replay,
 * refusal); a store fault thrown from here refuses in the caller, nothing written.
 */
async function composeAndVerify(
  repoRoot: string,
  top: string,
  result: GitObjectResult,
  options: ObjectDeliverOptions,
  mode: ObjectDeliverOptions["mode"],
  gates: GateSpec[],
  authorize: ((finalVerify: FinalVerifyRecord) => string | null) | undefined,
  log: VerifyEventLog,
): Promise<PreparedWrite | ObjectDeliverResult> {
  const projectRoot = options.projectRoot ?? repoRoot;
  const missing = await importOrRefuse(projectRoot, top, [result.base_tree, result.candidate_tree]);
  if (missing) return refused(mode, await snapshotTree(repoRoot), missing);
  // Apply reads the result's paths by content; commit-class trusts the real index's stat cache.
  const exact =
    mode === "apply" ? await pairPaths(top, result.base_tree, result.candidate_tree) : [];
  const targetPreimageSha = await snapshotTree(repoRoot, exact);
  const targetTree = await treeOf(top, targetPreimageSha);
  const onto =
    mode === "apply"
      ? { commit: targetPreimageSha, tree: targetTree }
      : await commitOnto(repoRoot, top, result, { commit: targetPreimageSha, tree: targetTree });
  if ("refusal" in onto) return refused(mode, targetPreimageSha, onto.refusal);
  const composed = await composeOnTarget({
    repo: top,
    base: result.base_tree,
    target: onto.tree,
    candidate: result.candidate_tree,
  });
  if (!composed.ok) {
    return refused(mode, targetPreimageSha, composed.refusal, {
      attempted: true,
      base_sha: targetPreimageSha,
      applied_cleanly: false,
      gates_passed: null,
      gates: [],
      duration_ms: null,
      reason: composed.refusal.message,
    });
  }
  const pair: GitDeliveryPair = {
    schema: GIT_OBJECTS_V1,
    object_format: result.object_format,
    pre_commit: onto.commit,
    pre_tree: onto.tree,
    post_tree: composed.tree,
  };
  // Idempotent replay (#26): the target already holds every change of the result.
  if (composed.tree === onto.tree) {
    const finalVerify = NOT_ATTEMPTED("already_applied");
    if (mode === "apply") {
      // A delivery whose caller died before recording it kept its pair first.
      const retained = options.owner
        ? retainedDeliveryPair(projectRoot, options.owner, targetTree)
        : null;
      return {
        mode,
        applied: true,
        treeMutated: false,
        alreadyApplied: true,
        detail: "already applied; idempotent no-op (no files changed)",
        finalVerify,
        targetPreimageSha,
        ...(retained ? { deliveryPair: retained } : {}),
      };
    }
    return {
      ...refused(
        mode,
        targetPreimageSha,
        typed(
          "delivery_conflict",
          `result already present in the working tree; '${mode}' needs an unapplied result (an earlier apply already delivered these changes — commit them directly or revert first)`,
        ),
        finalVerify,
      ),
    };
  }
  // Nothing a verify or a gate could say would let this write happen.
  const occupied = await occupiedByWrite(top, onto.tree, composed.tree);
  if (occupied) return refused(mode, targetPreimageSha, occupied);
  // INV-115: re-verified in a fresh envelope (a private clone at T with the
  // composed tree written by checkout, plus the configured gates) immediately
  // before the target preimage recheck, gates or not.
  const finalVerify = await finalVerifyPatch(
    repoRoot,
    { baseSha: onto.commit, baseTree: onto.tree, tree: composed.tree, projectRoot },
    gates,
    log,
  );
  let refusalText: string | null;
  if (finalVerify.applied_cleanly !== true)
    refusalText =
      finalVerify.reason ?? "final verify failed: the composed tree did not check out cleanly";
  else if (authorize) {
    refusalText = authorize(finalVerify);
    if (refusalText === "") refusalText = "delivery authorization returned an empty refusal";
  } else refusalText = finalVerifyBlocks(finalVerify) ? "final verify failed" : null;
  if (refusalText)
    return {
      mode,
      applied: false,
      refused: true,
      treeMutated: false,
      detail: refusalText,
      finalVerify,
      targetPreimageSha,
    };
  const observed = await snapshotTree(repoRoot, exact);
  if ((await treeOf(top, observed)) !== targetTree)
    return refused(
      mode,
      targetPreimageSha,
      typed(
        "delivery_target_changed",
        "target changed after final verify; refusing stale delivery",
      ),
      finalVerify,
    );
  return { pair, finalVerify, targetPreimageSha };
}

type CommitClassResult = Omit<ObjectDeliverResult, "finalVerify" | "targetPreimageSha">;

/**
 * Commit-class delivery keeps today's admission: a clean tree, index and worktree
 * move together. `pr` sends bytes off this machine (#555): its exact commit is
 * built from M and the publication scanner checks the outgoing range and its
 * metadata before any branch, index or ref changes, so a refusal writes nothing.
 */
async function commitClass(
  repoRoot: string,
  top: string,
  pair: GitDeliveryPair,
  options: ObjectDeliverOptions,
  mode: "branch" | "commit" | "pr",
): Promise<CommitClassResult> {
  const dirty = await statusPorcelainMeaningful(repoRoot);
  if (dirty.length > 0)
    return { mode, applied: false, detail: "working tree is dirty; refusing delivery mutation" };
  const headSha = (await git(top, ["rev-parse", "HEAD"])).stdout.trim();
  const moved = await headMovedSince(top, headSha, pair.pre_tree);
  if (moved)
    return {
      mode,
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: moved,
      detail: moved.message,
    };
  const branch =
    mode === "commit" ? options.branch : (options.branch ?? `claudexor/${newId("wp")}`);
  const message = options.message ?? "claudexor: apply work product";
  const publication =
    mode === "pr"
      ? await gatePublication({
          repoRoot: top,
          tree: pair.post_tree,
          parent: headSha,
          message,
          branch: branch!,
          prBodyFile: options.prBodyFile,
          configDir: options.scannerConfigDir ?? claudexorOwnedRoot(),
        })
      : null;
  if (publication && !publication.ok)
    return {
      mode,
      applied: false,
      refused: true,
      treeMutated: false,
      detail: publication.refusal.detail,
      publicationRefusal: publication.refusal,
    };
  try {
    const scanned = publication?.ok ? publication : null;
    return await writeAndCommit(repoRoot, top, pair, options, mode, { headSha, branch, scanned });
  } finally {
    if (publication?.ok) publication.cleanup();
  }
}

/** M through the real index, its commit, and for `pr` the push of exactly the scanned commit. */
async function writeAndCommit(
  repoRoot: string,
  top: string,
  pair: GitDeliveryPair,
  options: ObjectDeliverOptions,
  mode: "branch" | "commit" | "pr",
  at: {
    headSha: string;
    branch: string | undefined;
    scanned: { commit: string; bodyFile: string | undefined } | null;
  },
): Promise<CommitClassResult> {
  const { headSha, branch, scanned } = at;
  const projectRoot = options.projectRoot ?? repoRoot;
  const custody = await retainPairOrRefuse(projectRoot, top, pair, options.owner ?? projectRoot);
  if (custody)
    return {
      mode,
      applied: false,
      refused: true,
      treeMutated: false,
      refusal: custody,
      detail: custody.message,
    };
  const branchName = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const restoreDetached = !branchName || branchName === "HEAD";
  const restorePoint = {
    ref: restoreDetached ? headSha : branchName,
    detached: restoreDetached,
    headSha,
  };
  const headTree = await treeOf(top, headSha);
  let onNewBranch = false;
  if (mode === "branch" || mode === "pr") {
    const created = await git(top, [...CHECKOUT_CONFIG, "checkout", "-b", branch!]);
    if (created.code !== 0)
      return { mode, applied: false, detail: `branch failed: ${created.stderr.trim()}` };
    onNewBranch = true;
  }
  /** Back where HEAD was, the new branch deleted: null, else what stays and
   * whether it is HEAD itself (`stranded`) or only the branch. */
  const leaveBranch = async (): Promise<{ issue: string; stranded: boolean } | null> => {
    if (!onNewBranch || !branch) return null;
    const back = await git(top, restoreCheckoutArgs(restorePoint));
    if (back.code !== 0)
      return { issue: failedToLeaveBranch(branch, back.stderr, restorePoint), stranded: true };
    const removed = await git(top, ["branch", "-D", branch]);
    return removed.code === 0
      ? null
      : { issue: branchLeftBehind(branch, removed.stderr), stranded: false };
  };
  const written = await materializeTree({
    worktree: top,
    from: headTree,
    to: pair.post_tree,
    index: "real",
  });
  if (!written.ok) {
    // Not applied means unchanged (INV-114): the write goes back on its retained
    // pair, then the live index it moved follows, also when that take-back could
    // not prove itself: a later revert works on the pair and never touches this index.
    let stays: string | null = null;
    if (written.treeMutated) {
      const back = await takeBackWrite(repoRoot, pair, projectRoot, written.unproven);
      const index = await returnLiveIndex(top, pair.post_tree, headTree);
      stays = [back, index].filter(Boolean).join("; ") || null;
    }
    const left = await leaveBranch();
    const stranded = left?.stranded === true;
    const mutated = stays !== null || stranded;
    const refusal = written.treeMutated
      ? afterWriteRefusal(written.refusal, stays, left !== null)
      : written.refusal;
    return {
      mode,
      applied: false,
      refused: true,
      branch,
      treeMutated: mutated,
      refusal,
      detail: [refusal.message, left?.issue, stranded && stays === null ? RECOVERY_REQUIRED : null]
        .filter(Boolean)
        .join("; "),
      ...(mutated ? { deliveryPair: pair } : {}),
      ...(stays === null && stranded ? { headStranded: true } : {}),
    };
  }
  const restore = async (why: string) => {
    const back = await materializeTree({
      worktree: top,
      from: pair.post_tree,
      to: headTree,
      index: "real",
    });
    const left = back.ok ? await leaveBranch() : null;
    const mutated = !back.ok || left?.stranded === true;
    return {
      mode,
      applied: false,
      refused: true, // like a failed write: the result was not delivered
      branch,
      treeMutated: mutated,
      ...(mutated ? { deliveryPair: pair } : {}),
      ...(back.ok && left?.stranded ? { headStranded: true } : {}),
      detail: [
        why,
        back.ok ? "delivered tree removed" : back.refusal.message,
        left?.issue,
        mutated ? RECOVERY_REQUIRED : null,
      ]
        .filter(Boolean)
        .join("; "),
    };
  };
  const staged = (await git(top, ["write-tree"])).stdout.trim();
  if (staged !== pair.post_tree)
    return restore("live index contains state outside the exact delivered tree");
  const message = options.message ?? "claudexor: apply work product";
  const committed = scanned
    ? { code: 0, stdout: scanned.commit, stderr: "" }
    : await git(
        top,
        [
          "-c",
          "user.email=claudexor@local",
          "-c",
          "user.name=claudexor",
          "commit-tree",
          pair.post_tree,
          "-p",
          headSha,
          "-F",
          "-",
        ],
        `${message}\n`,
      );
  const commit = committed.stdout.trim();
  if (committed.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit))
    return restore(`commit object creation failed: ${committed.stderr.trim()}`);
  const symbolic = await git(top, ["symbolic-ref", "-q", "HEAD"]);
  const targetRef = symbolic.code === 0 ? symbolic.stdout.trim() : "HEAD";
  const updated = await git(
    top,
    targetRef === "HEAD"
      ? ["update-ref", "--no-deref", "HEAD", commit, headSha]
      : ["update-ref", targetRef, commit, headSha],
  );
  if (updated.code !== 0)
    return restore(`target ref changed before commit: ${updated.stderr.trim()}`);
  if (mode !== "pr") return { mode, applied: true, branch, commit, deliveryPair: pair };
  // Push the scanned commit OBJECT and nothing beside it (no followed tags, no
  // submodule pushes): exactly the bytes the publication scan passed (#555).
  const push = await git(top, [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "origin",
    `${commit}:refs/heads/${branch!}`,
  ]);
  if (push.code !== 0) {
    const failed = await afterFailedPush(top, push, branch!, commit, restorePoint);
    return { ...failed, ...(failed.treeMutated ? { deliveryPair: pair } : {}) };
  }
  // The local branch tracks the published one (best effort; the push already landed).
  await git(top, ["config", `branch.${branch!}.remote`, "origin"]);
  await git(top, ["config", `branch.${branch!}.merge`, `refs/heads/${branch!}`]);
  const args = [
    "pr",
    "create",
    "--head",
    branch!,
    "--title",
    message,
    // The body gh reads is the scanner-owned copy of the exact scanned bytes.
    ...(scanned?.bodyFile
      ? ["--body-file", scanned.bodyFile]
      : ["--body", "Created by Claudexor."]),
  ];
  const pr = await runCapture("gh", args, { cwd: top, timeoutMs: 60_000 }).catch(() => null);
  const prUrl = pr && pr.code === 0 ? pr.stdout.trim() : undefined;
  return {
    mode,
    applied: true,
    branch,
    commit,
    prUrl,
    deliveryPair: pair,
    detail: prUrl
      ? undefined
      : `branch pushed; PR was not opened${pr ? `: ${redactSecrets(pr.stderr.trim()) || `gh exited ${pr.code}`}` : ": gh unavailable"}`,
  };
}
