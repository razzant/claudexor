import type { ProjectPartitions } from "@claudexor/daemon";
import { verifyAndDeliver } from "@claudexor/delivery";
import { advanceThreadWorktree, diffStaged, git, snapshotTree } from "@claudexor/workspace";
import { containsSecretLikeToken } from "@claudexor/util";

export interface ThreadApplyOptions {
  mode: string;
  branch?: string;
  message?: string;
  gates?: NonNullable<Parameters<typeof verifyAndDeliver>[3]>;
}

/** Deliver an isolated thread and advance its persistent branch/watermark. */
export async function applyThreadDiff(
  threads: ProjectPartitions,
  id: string,
  opts: ThreadApplyOptions,
): Promise<{ applied: boolean; status: string; headMoved: boolean; detail: string | null }> {
  const thread = threads.getThread(id);
  if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
  const ws = thread.workspace;
  if (ws.mode !== "isolated" || !ws.worktree_path || !thread.repo) {
    throw Object.assign(
      new Error("thread has no isolated worktree to apply (in-place threads write directly)"),
      { status: 400 },
    );
  }
  const projectRoot = thread.repo.root;
  const base = ws.base_sha ?? "HEAD";
  const patch = await diffStaged(ws.worktree_path, base);
  if (!patch.trim())
    return { applied: false, status: "empty", headMoved: false, detail: "no changes to apply" };
  if (containsSecretLikeToken(patch)) {
    return {
      applied: false,
      status: "rejected",
      headMoved: false,
      detail: "patch contains a secret-like token; refusing apply",
    };
  }
  let headMoved = false;
  try {
    const head = (await git(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const mergeBase = (await git(projectRoot, ["merge-base", "HEAD", base])).stdout.trim();
    headMoved = mergeBase !== "" && head !== "" && mergeBase !== head;
  } catch {
    // Advisory only; the exact preimage check remains authoritative.
  }
  const mode = (["apply", "branch", "commit", "pr"].includes(opts.mode) ? opts.mode : "apply") as
    | "apply"
    | "branch"
    | "commit"
    | "pr";
  const delivered = await verifyAndDeliver(
    projectRoot,
    patch,
    { mode, branch: opts.branch, message: opts.message },
    opts.gates ?? [],
  );
  if (delivered.applied) {
    const targetSha = await snapshotTree(projectRoot);
    threads.setThreadWorktree(
      id,
      ws.worktree_path,
      await advanceThreadWorktree(projectRoot, id, ws.worktree_path, targetSha),
      thread.head_run_id ?? undefined,
    );
  }
  const status = !delivered.applied
    ? "conflict"
    : mode === "branch"
      ? "branched"
      : mode === "commit"
        ? "committed"
        : mode === "pr"
          ? delivered.prUrl
            ? "pr_opened"
            : "branched"
          : "applied";
  return { applied: delivered.applied, status, headMoved, detail: delivered.detail ?? null };
}
