import { rmSync } from "node:fs";
import { join } from "node:path";
import { parseUnifiedDiff, runCapture, runCaptureRaw } from "@claudexor/core";
import { applyPatchProtected, stageAllExcludingArtifacts, statusPorcelainMeaningful } from "@claudexor/workspace";
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
export const DELIVER_MODES = new Set<DeliverMode>(["artifact_only", "apply", "branch", "commit", "pr"]);

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
export async function deliver(repoRoot: string, patch: string, opts: DeliverOptions): Promise<DeliverResult> {
  if (!DELIVER_MODES.has(opts.mode)) return { mode: "artifact_only", applied: false, detail: `unsupported delivery mode: ${opts.mode}` };
  if (opts.mode === "artifact_only") {
    return { mode: "artifact_only", applied: false, detail: "patch emitted; working tree untouched" };
  }
  // Claudexor's own run/workspace artifacts are not user working-tree state
  // (single owner: workspace artifact-paths — the `:(exclude)` pathspec used
  // here before HARD-ERRORS when the project gitignores `.claudexor`, which
  // Claudexor-initialized repos DO, and it missed `.claudexor-review-evidence`).
  const dirty = await statusPorcelainMeaningful(repoRoot).catch((err: unknown) => {
    return err instanceof Error ? err : new Error(String(err));
  });
  if (dirty instanceof Error) return { mode: opts.mode, applied: false, detail: `status failed: ${dirty.message}` };
  if (dirty.length > 0) return { mode: opts.mode, applied: false, detail: "working tree is dirty; refusing delivery mutation" };

  // Detached-HEAD safe restore point: `--abbrev-ref HEAD` on a detached head
  // yields the literal "HEAD" (useless for checkout-restore); capture the sha.
  const branchName = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const headSha = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  const restoreRef = branchName && branchName !== "HEAD" ? branchName : headSha;
  const restoreDetached = !branchName || branchName === "HEAD";

  let branch = opts.branch;
  let onNewBranch = false;
  if (opts.mode === "branch" || opts.mode === "pr") {
    branch = branch ?? `claudexor/${newId("wp")}`;
    const cb = await git(repoRoot, ["checkout", "-b", branch]);
    if (cb.code !== 0) return { mode: opts.mode, applied: false, detail: `branch failed: ${cb.stderr.trim()}` };
    onNewBranch = true;
  }

  /** Leave the fresh branch and delete it; report honestly if that fails. */
  const cleanupBranch = async (): Promise<string | null> => {
    if (!onNewBranch || !branch) return null;
    const back = restoreDetached
      ? await git(repoRoot, ["checkout", "--detach", restoreRef])
      : await git(repoRoot, ["checkout", restoreRef]);
    if (back.code !== 0) return `failed to leave branch ${branch}: ${back.stderr.trim()}`;
    const del = await git(repoRoot, ["branch", "-D", branch]);
    if (del.code !== 0) return `failed to delete branch ${branch}: ${del.stderr.trim()}`;
    onNewBranch = false;
    return null;
  };

  const ap = await applyPatchProtected(repoRoot, patch);
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

  /** Post-apply failure: the patch IS in the tree — restore before reporting. */
  const restoreAppliedTree = async (why: string): Promise<DeliverResult> => {
    const added = parseUnifiedDiff(patch)
      .files.filter((f) => f.added && f.newPath)
      .map((f) => f.newPath as string);
    for (const rel of added) {
      try {
        rmSync(join(repoRoot, rel), { force: true });
      } catch {
        /* verified below */
      }
    }
    await git(repoRoot, ["reset", "--quiet"]);
    await git(repoRoot, ["checkout", "--", "."]);
    const cleanupIssue = await cleanupBranch();
    const residue = await statusPorcelainMeaningful(repoRoot).catch(() => ["status failed"]);
    const treeMutated = residue.length > 0 || cleanupIssue !== null;
    return {
      mode: opts.mode,
      applied: false,
      branch,
      treeMutated,
      detail: [why, cleanupIssue, treeMutated ? "RESTORE INCOMPLETE — inspect the tree manually" : "tree restored"].filter(Boolean).join("; "),
    };
  };

  try {
    await stageAllExcludingArtifacts(repoRoot);
  } catch (err) {
    return restoreAppliedTree(`staging failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const message = opts.message ?? "claudexor: apply work product";
  const commitRes = await git(repoRoot, [
    "-c",
    "user.email=claudexor@local",
    "-c",
    "user.name=claudexor",
    "commit",
    "-m",
    message,
  ]);
  if (commitRes.code !== 0) {
    return restoreAppliedTree(`commit failed: ${commitRes.stderr.trim()}`);
  }
  const commit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  if (opts.mode === "commit" || opts.mode === "branch") {
    return { mode: opts.mode, applied: true, branch, commit };
  }

  // pr
  const push = await git(repoRoot, ["push", "-u", "origin", branch as string]);
  if (push.code !== 0) {
    return { mode: "pr", applied: false, branch, commit, treeMutated: true, detail: `push failed: ${push.stderr.trim()}; the local branch keeps the committed work` };
  }
  const ghArgs = ["pr", "create", "--head", branch as string, "--title", message];
  if (opts.prBodyFile) ghArgs.push("--body-file", opts.prBodyFile);
  else ghArgs.push("--body", "Created by Claudexor.");
  const pr = await runCapture("gh", ghArgs, { cwd: repoRoot, timeoutMs: 60_000 }).catch(() => null);
  const prUrl = pr && pr.code === 0 ? pr.stdout.trim() : undefined;
  return { mode: "pr", applied: Boolean(prUrl), branch, commit, prUrl, detail: prUrl ? undefined : "gh pr create unavailable" };
}
