import { runCapture, runCaptureRaw } from "@claudexor/core";
import { realpath } from "node:fs/promises";
import {
  applyPatchAndIndexProtected,
  applyPatchProtected,
  materializePatchTree,
  readRevertAnchor,
  revertWorkingTreePatch,
  reversePatchAndIndexProtected,
  revParse,
  snapshotTree,
  statusPorcelainMeaningful,
} from "@claudexor/workspace";
import { newId, redactSecrets } from "@claudexor/util";
import type { FinalVerifyRecord } from "@claudexor/schema";
import type { GateSpec } from "@claudexor/review";
import { finalVerifyBlocks, finalVerifyPatch, type VerifyEventLog } from "./final-verifier.js";

export * from "./gate.js";
export * from "./final-verifier.js";

const repositoryMutationTails = new Map<string, Promise<void>>();

async function withRepositoryMutationLease<T>(
  repoRoot: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = await realpath(repoRoot);
  const previous = repositoryMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => held);
  repositoryMutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (repositoryMutationTails.get(key) === tail) repositoryMutationTails.delete(key);
  }
}

/** GC-independent in-place revert from the external immutable anchor. */
export async function revertInPlaceFromAnchor(repo: string, anchorId: string) {
  return withRepositoryMutationLease(repo, () =>
    revertWorkingTreePatch(repo, readRevertAnchor(repo, anchorId)),
  );
}

async function git(repo: string, args: string[], input?: string) {
  // Raw capture: the patch rides stdin already; stdout may carry diffs too.
  return runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000, input });
}

export interface ApplyResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

/** Dry-run: does this patch apply cleanly? (git apply --check) */
export async function checkPatch(repoRoot: string, patch: string): Promise<ApplyResult> {
  const r = await git(repoRoot, ["apply", "--check", "-"], patch);
  return { ok: r.code === 0, code: r.code, stderr: r.stderr };
}

/**
 * Reverse dry-run: is the tree ALREADY this patch's exact postimage? (#26)
 * `git apply --reverse --check` succeeds only when every hunk's postimage
 * context is present — a strong fingerprint that the delivered result is in the
 * tree. Used to distinguish an idempotent already-applied replay (forward
 * refuses, reverse applies) from a real conflict (both refuse).
 */
export async function checkPatchReverse(repoRoot: string, patch: string): Promise<ApplyResult> {
  const r = await git(repoRoot, ["apply", "--reverse", "--check", "-"], patch);
  return { ok: r.code === 0, code: r.code, stderr: r.stderr };
}

export type DeliverMode = "apply" | "branch" | "commit" | "pr";
export const DELIVER_MODES = new Set<DeliverMode>(["apply", "branch", "commit", "pr"]);

export interface DeliverOptions {
  mode: DeliverMode;
  branch?: string;
  message?: string;
  prBodyFile?: string;
}

export interface DeliverResult {
  mode: DeliverMode;
  applied: boolean;
  branch?: string;
  commit?: string;
  prUrl?: string;
  detail?: string;
  /** True when a FAILED delivery left the tree mutated (restore failed);
   * `applied:false, treeMutated:false` guarantees the tree is untouched. */
  treeMutated?: boolean;
  /** #26: TRUE when delivery was an idempotent already-applied no-op (the tree
   * was already this patch's exact postimage). `applied:true` with no mutation. */
  alreadyApplied?: boolean;
}

export interface VerifiedDeliverResult extends DeliverResult {
  finalVerify: FinalVerifyRecord;
  targetPreimageSha: string;
  refused?: boolean;
}

/** One mutation entry point for manual/thread/race delivery. It verifies the
 * patch on a fresh worktree bound to the current target preimage, lets the
 * caller project its semantic apply policy, rechecks the preimage, then
 * performs exactly one protected mutation. */
export async function verifyAndDeliver(
  repoRoot: string,
  patch: string,
  options: DeliverOptions & { protectedApply?: boolean },
  gates: GateSpec[] = [],
  authorize?: (finalVerify: FinalVerifyRecord) => string | null,
  log: VerifyEventLog = { emit: () => undefined },
): Promise<VerifiedDeliverResult> {
  return withRepositoryMutationLease(repoRoot, () =>
    verifyAndDeliverUnlocked(repoRoot, patch, options, gates, authorize, log),
  );
}

async function verifyAndDeliverUnlocked(
  repoRoot: string,
  patch: string,
  options: DeliverOptions & { protectedApply?: boolean },
  gates: GateSpec[],
  authorize: ((finalVerify: FinalVerifyRecord) => string | null) | undefined,
  log: VerifyEventLog,
): Promise<VerifiedDeliverResult> {
  const targetPreimageSha = await snapshotTree(repoRoot);
  const targetPreimageTree = await revParse(repoRoot, `${targetPreimageSha}^{tree}`);
  const finalVerify = await finalVerifyPatch(
    repoRoot,
    { baseSha: targetPreimageSha, diff: patch },
    gates,
    log,
  );
  let refusal: string | null;
  if (finalVerify.applied_cleanly === false) {
    // Idempotent replay (#26): the forward patch no longer applies onto a fresh
    // copy. That is EITHER a real conflict OR an already-delivered no-op — the
    // tree is already this patch's exact postimage. Distinguish the two by a
    // reverse --check against the current tree (the same preimage/postimage
    // comparison the revert machinery uses): reverse-clean proves the delivered
    // result is present, so return a typed already-applied no-op (applied:true,
    // NO mutation) instead of failing "patch does not apply" on every replay.
    // A partial/diverged tree (reverse also refuses) still refuses as a real
    // conflict — never a false success.
    if ((await checkPatchReverse(repoRoot, patch)).ok) {
      return {
        mode: options.mode,
        applied: true,
        treeMutated: false,
        alreadyApplied: true,
        detail: "already applied; idempotent no-op (no files changed)",
        finalVerify,
        targetPreimageSha,
      };
    }
    // Mechanical applicability is never waivable, even when a caller owns the
    // semantic risk decision for failed gates or verifier infrastructure.
    refusal = finalVerify.reason ?? "final verify failed: patch did not apply cleanly";
  } else if (authorize) {
    // A supplied policy owns the semantic verdict. In particular, null is an
    // affirmative allow after a hash-bound accept_risk decision; do not replace
    // it via nullish coalescing with the default refusal.
    refusal = authorize(finalVerify);
    if (refusal === "") refusal = "delivery authorization returned an empty refusal";
  } else {
    refusal = finalVerifyBlocks(finalVerify) ? "final verify failed" : null;
  }
  if (refusal) {
    return {
      mode: options.mode,
      applied: false,
      treeMutated: false,
      detail: refusal,
      finalVerify,
      targetPreimageSha,
      refused: true,
    };
  }
  const observedSha = await snapshotTree(repoRoot);
  const observedTree = await revParse(repoRoot, `${observedSha}^{tree}`);
  if (observedTree !== targetPreimageTree) {
    return {
      mode: options.mode,
      applied: false,
      treeMutated: false,
      detail: "target changed after final verify; refusing stale delivery",
      finalVerify,
      targetPreimageSha,
      refused: true,
    };
  }
  if (options.protectedApply) {
    const applied = await applyPatchProtected(repoRoot, patch);
    return {
      mode: "apply",
      applied: applied.ok,
      treeMutated: applied.treeMutated,
      detail: applied.detail,
      finalVerify,
      targetPreimageSha,
    };
  }
  const delivered = await deliverUnlocked(repoRoot, patch, options);
  return { ...delivered, finalVerify, targetPreimageSha };
}

/**
 * Deliver a WorkProduct patch according to a mutation mode. `pr` requires `gh`
 * and a configured remote. Commit identity is set per-command (no global config
 * mutation). Protected path: `--check` before any mutation, restore
 * on failure (detached-HEAD safe), and HONEST `treeMutated` when a restore
 * itself fails — never a clean-looking result over a conflicted tree.
 */
export async function deliver(
  repoRoot: string,
  patch: string,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  return withRepositoryMutationLease(repoRoot, () => deliverUnlocked(repoRoot, patch, opts));
}

async function deliverUnlocked(
  repoRoot: string,
  patch: string,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  // Mode validity is schema-enforced at every ingress; reaching this layer
  // with an unknown mode is a programming error, not a user state.
  if (!DELIVER_MODES.has(opts.mode)) {
    throw new Error(`unsupported delivery mode: ${opts.mode}`);
  }
  // Runtime is external in v2. Every path reported by the repository,
  // including `.claudexor*`, is user state and blocks a clean-tree mutation.
  const dirty = await statusPorcelainMeaningful(repoRoot).catch((err: unknown) => {
    return err instanceof Error ? err : new Error(String(err));
  });
  if (dirty instanceof Error)
    return { mode: opts.mode, applied: false, detail: `status failed: ${dirty.message}` };
  if (dirty.length > 0)
    return {
      mode: opts.mode,
      applied: false,
      detail: "working tree is dirty; refusing delivery mutation",
    };

  // Detached-HEAD safe restore point: `--abbrev-ref HEAD` on a detached head
  // yields the literal "HEAD" (useless for checkout-restore); capture the sha.
  const branchName = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const headSha = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const restoreRef = branchName && branchName !== "HEAD" ? branchName : headSha;
  const restoreDetached = !branchName || branchName === "HEAD";
  let expectedTree: string;
  try {
    expectedTree = await materializePatchTree(repoRoot, headSha, patch);
  } catch (error) {
    return {
      mode: opts.mode,
      applied: false,
      treeMutated: false,
      detail: `candidate materialization failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let branch = opts.branch;
  let onNewBranch = false;
  if (opts.mode === "branch" || opts.mode === "pr") {
    branch = branch ?? `claudexor/${newId("wp")}`;
    const cb = await git(repoRoot, ["-c", "core.hooksPath=/dev/null", "checkout", "-b", branch]);
    if (cb.code !== 0)
      return { mode: opts.mode, applied: false, detail: `branch failed: ${cb.stderr.trim()}` };
    onNewBranch = true;
  }

  /** Leave the fresh branch and delete it; report honestly if that fails. */
  const cleanupBranch = async (): Promise<string | null> => {
    if (!onNewBranch || !branch) return null;
    const back = restoreDetached
      ? await git(repoRoot, ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", restoreRef])
      : await git(repoRoot, ["-c", "core.hooksPath=/dev/null", "checkout", restoreRef]);
    if (back.code !== 0) return `failed to leave branch ${branch}: ${back.stderr.trim()}`;
    const del = await git(repoRoot, ["branch", "-D", branch]);
    if (del.code !== 0) return `failed to delete branch ${branch}: ${del.stderr.trim()}`;
    onNewBranch = false;
    return null;
  };

  const ap =
    opts.mode === "apply"
      ? await applyPatchProtected(repoRoot, patch)
      : await applyPatchAndIndexProtected(repoRoot, patch);
  if (!ap.ok) {
    const cleanupIssue = await cleanupBranch();
    return {
      mode: opts.mode,
      applied: false,
      branch,
      treeMutated: ap.treeMutated || cleanupIssue !== null,
      detail: [ap.detail ?? "apply failed", cleanupIssue].filter(Boolean).join("; "),
    };
  }
  if (opts.mode === "apply") return { mode: "apply", applied: true };

  if (!patch.trim()) {
    const cleanupIssue = await cleanupBranch();
    return {
      mode: opts.mode,
      applied: false,
      branch,
      treeMutated: cleanupIssue !== null,
      detail: ["empty patch; no commit created", cleanupIssue].filter(Boolean).join("; "),
    };
  }

  /**
   * Post-apply failure: compensate only by reverse-applying the exact patch to
   * worktree+index. A concurrent overlapping edit blocks compensation and is
   * left intact with `treeMutated:true`; broad reset/checkout rollback is
   * forbidden because it can erase user state.
   */
  const restoreAppliedTree = async (why: string): Promise<DeliverResult> => {
    const reverse = await reversePatchAndIndexProtected(repoRoot, patch);
    const cleanupIssue = reverse.ok ? await cleanupBranch() : null;
    const treeMutated = !reverse.ok || cleanupIssue !== null;
    return {
      mode: opts.mode,
      applied: false,
      branch,
      treeMutated,
      detail: [
        why,
        reverse.ok ? "exact patch postimage removed" : reverse.detail,
        cleanupIssue,
        treeMutated ? "RECOVERY REQUIRED — user state was not overwritten" : null,
      ]
        .filter(Boolean)
        .join("; "),
    };
  };

  const stagedTree = (await git(repoRoot, ["write-tree"])).stdout.trim();
  const observedHeadBeforeCommit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  if (stagedTree !== expectedTree || observedHeadBeforeCommit !== headSha) {
    return restoreAppliedTree(
      stagedTree !== expectedTree
        ? "live index contains state outside the exact candidate tree"
        : "target HEAD changed before commit",
    );
  }

  const message = opts.message ?? "claudexor: apply work product";
  const commitRes = await git(
    repoRoot,
    [
      "-c",
      "user.email=claudexor@local",
      "-c",
      "user.name=claudexor",
      "commit-tree",
      expectedTree,
      "-p",
      headSha,
      "-F",
      "-",
    ],
    `${message}\n`,
  );
  if (commitRes.code !== 0) {
    return restoreAppliedTree(`commit object creation failed: ${commitRes.stderr.trim()}`);
  }
  const commit = commitRes.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    return restoreAppliedTree("commit object creation returned an invalid object id");
  }

  const symbolicRef = await git(repoRoot, ["symbolic-ref", "-q", "HEAD"]);
  const targetRef = symbolicRef.code === 0 ? symbolicRef.stdout.trim() : "HEAD";
  const updateArgs =
    targetRef === "HEAD"
      ? ["update-ref", "--no-deref", "HEAD", commit, headSha]
      : ["update-ref", targetRef, commit, headSha];
  const update = await git(repoRoot, updateArgs);
  if (update.code !== 0) {
    return restoreAppliedTree(`target ref changed before commit: ${update.stderr.trim()}`);
  }

  const committedHead = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const committedTree = (await git(repoRoot, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
  if (committedHead !== commit || committedTree !== expectedTree) {
    // The CAS update itself succeeded, so reversing the index/worktree would
    // create a false clean state over an authoritative commit. Surface the
    // divergence for recovery and leave every byte intact.
    return {
      mode: opts.mode,
      applied: false,
      branch,
      commit,
      treeMutated: true,
      detail:
        "commit ref advanced but current HEAD no longer identifies the exact candidate; recovery required",
    };
  }

  if (opts.mode === "commit" || opts.mode === "branch") {
    return { mode: opts.mode, applied: true, branch, commit };
  }

  // pr
  const push = await git(repoRoot, [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "-u",
    "origin",
    branch as string,
  ]);
  if (push.code !== 0) {
    return {
      mode: "pr",
      applied: false,
      branch,
      commit,
      treeMutated: true,
      detail: `push failed: ${push.stderr.trim()}; the local branch keeps the committed work`,
    };
  }
  const ghArgs = ["pr", "create", "--head", branch as string, "--title", message];
  if (opts.prBodyFile) ghArgs.push("--body-file", opts.prBodyFile);
  else ghArgs.push("--body", "Created by Claudexor.");
  const pr = await runCapture("gh", ghArgs, { cwd: repoRoot, timeoutMs: 60_000 }).catch(() => null);
  const prUrl = pr && pr.code === 0 ? pr.stdout.trim() : undefined;
  return {
    mode: "pr",
    // The commit and remote branch are already durable at this point. A PR
    // creation failure is a partial delivery, not a clean refusal that callers
    // may safely retry as if nothing happened.
    applied: true,
    branch,
    commit,
    prUrl,
    detail: prUrl
      ? undefined
      : `branch pushed; PR was not opened${pr ? `: ${redactSecrets(pr.stderr.trim()) || `gh exited ${pr.code}`}` : ": gh unavailable"}`,
  };
}
