import { runCapture, runCaptureRaw } from "@claudexor/core";
import {
  applyPatchAndIndexProtected,
  applyPatchProtected,
  materializePatchTree,
  reversePatchAndIndexProtected,
  statusPorcelainMeaningful,
} from "@claudexor/workspace";
import { newId } from "@claudexor/util";

export * from "./gate.js";

// Server-owned in-place revert (restore the live tree to a run's pre-turn
// snapshot, refusing if the tree diverged). Co-located with apply; control-api
// calls it for the revert_run operator decision.
export { revertWorkingTreeTo as revertInPlace, type RevertResult } from "@claudexor/workspace";

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

export type DeliverMode = "artifact_only" | "apply" | "branch" | "commit" | "pr";
export const DELIVER_MODES = new Set<DeliverMode>([
  "artifact_only",
  "apply",
  "branch",
  "commit",
  "pr",
]);

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
  if (!DELIVER_MODES.has(opts.mode))
    return {
      mode: "artifact_only",
      applied: false,
      detail: `unsupported delivery mode: ${opts.mode}`,
    };
  if (opts.mode === "artifact_only") {
    return {
      mode: "artifact_only",
      applied: false,
      detail: "patch emitted; working tree untouched",
    };
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
    applied: Boolean(prUrl),
    branch,
    commit,
    prUrl,
    detail: prUrl ? undefined : "gh pr create unavailable",
  };
}
