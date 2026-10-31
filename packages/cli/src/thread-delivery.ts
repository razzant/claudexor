import type { ProjectThreadPort } from "@claudexor/daemon";
import { verifyAndDeliver } from "@claudexor/delivery";
import {
  advanceThreadWorktree,
  captureWorkingTreeTransient,
  captureFailureEvidence,
  git,
  snapshotTree,
} from "@claudexor/workspace";
import type { ControlDeliveryResponse } from "@claudexor/schema";
import { dirname } from "node:path";

export interface ThreadApplyOptions {
  mode: string;
  branch?: string;
  message?: string;
  gates?: NonNullable<Parameters<typeof verifyAndDeliver>[3]>;
}

/** Deliver an isolated thread and advance its persistent branch/watermark. */
export async function applyThreadDiff(
  threads: ProjectThreadPort,
  id: string,
  opts: ThreadApplyOptions,
): Promise<{
  applied: boolean;
  status: string;
  headMoved: boolean;
  detail: string | null;
  delivery: ControlDeliveryResponse | null;
}> {
  const thread = threads.getThread(id);
  if (!thread) throw Object.assign(new Error(`no such thread: ${id}`), { status: 404 });
  const ws = thread.workspace;
  if (ws.mode !== "isolated" || !ws.worktree_path || !thread.repo) {
    throw Object.assign(
      new Error(
        ws.mode === "delegated"
          ? "a delegated thread executes in a caller-owned workspace; Claudexor never applies it to the project"
          : "thread has no isolated worktree to apply (in-place threads write directly)",
      ),
      { status: 400 },
    );
  }
  const projectRoot = thread.repo.root;
  const base = ws.base_sha ?? "HEAD";
  // The thread's own runtime directory keeps the captured objects in the store.
  const owner = dirname(ws.worktree_path);
  const captured = await captureWorkingTreeTransient(ws.worktree_path, base, [], {
    projectRoot,
    owner,
  });
  if (captured.captureIncomplete) {
    const failure = captureFailureEvidence(captured.captureFailure);
    // Problem context is the existing wire/journal carrier of typed facts, so
    // the first refusal and every idempotent replay answer the same evidence.
    throw Object.assign(
      new Error(`Thread changes could not be captured completely: ${failure.message}`),
      {
        status: 409,
        code: failure.code,
        context: { captureFailure: failure },
      },
    );
  }
  const patch = captured.patch;
  const changed = captured.result
    ? captured.result.base_tree !== captured.result.candidate_tree
    : patch.trim().length > 0;
  if (!changed)
    return {
      applied: false,
      status: "empty",
      headMoved: false,
      detail: "no changes to apply",
      delivery: null,
    };
  let headMoved = false;
  try {
    const head = (await git(projectRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const mergeBase = (await git(projectRoot, ["merge-base", "HEAD", base])).stdout.trim();
    headMoved = mergeBase !== "" && head !== "" && mergeBase !== head;
  } catch {
    // Advisory only; the exact preimage check remains authoritative.
  }
  const mode = (["apply", "branch", "commit", "pr"].includes(opts.mode) ? opts.mode : "apply") as
    "apply" | "branch" | "commit" | "pr";
  // INV-146: the thread applies its LIVE worktree capture (exact bytes), so a
  // local apply/branch/commit keeps secret-like strings where the agent wrote
  // them. Only `pr` refuses — inside the one delivery owner, before anything
  // is created or pushed — when the publication scanner does not pass it.
  const delivered = await verifyAndDeliver(
    projectRoot,
    captured.result
      ? { result: captured.result, renderedPatch: captured.patchViewUnavailable ? null : patch }
      : patch,
    {
      mode,
      branch: opts.branch,
      message: opts.message,
      projectRoot,
      owner,
    },
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
    ? delivered.refused
      ? "rejected"
      : "conflict"
    : mode === "branch"
      ? "branched"
      : mode === "commit"
        ? "committed"
        : mode === "pr"
          ? delivered.prUrl
            ? "pr_opened"
            : "branched"
          : "applied";
  // `headStranded` is the delivery owner's fact for a run's revert anchor, not part
  // of the strict receipt: `detail` is what names the way back.
  const { headStranded: _internal, ...receipt } = delivered;
  return {
    applied: delivered.applied,
    status,
    headMoved,
    detail: delivered.detail ?? null,
    // #26: the receipt now carries a typed alreadyApplied flag (default false
    // for a fresh apply); normalize the optional producer field to the receipt.
    delivery: { ...receipt, alreadyApplied: receipt.alreadyApplied ?? false },
  };
}
