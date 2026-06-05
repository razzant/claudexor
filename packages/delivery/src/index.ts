import { runCapture } from "@claudex/core";
import { newId } from "@claudex/util";

async function git(repo: string, args: string[], input?: string) {
  return runCapture("git", ["-C", repo, ...args], { timeoutMs: 60_000, input });
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

export async function applyPatch(repoRoot: string, patch: string): Promise<ApplyResult> {
  const r = await git(repoRoot, ["apply", "--3way", "-"], patch);
  return { ok: r.code === 0, code: r.code, stderr: r.stderr };
}

export type DeliverMode = "artifact_only" | "apply" | "branch" | "commit" | "pr";

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
}

/**
 * Deliver a WorkProduct patch according to a mutation mode. `pr` requires `gh`
 * and a configured remote. Commit identity is set per-command (no global config
 * mutation).
 */
export async function deliver(repoRoot: string, patch: string, opts: DeliverOptions): Promise<DeliverResult> {
  if (opts.mode === "artifact_only") {
    return { mode: "artifact_only", applied: false, detail: "patch emitted; working tree untouched" };
  }

  let branch = opts.branch;
  if (opts.mode === "branch" || opts.mode === "pr") {
    branch = branch ?? `claudex/${newId("wp")}`;
    const cb = await git(repoRoot, ["checkout", "-b", branch]);
    if (cb.code !== 0) return { mode: opts.mode, applied: false, detail: `branch failed: ${cb.stderr.trim()}` };
  }

  const ap = await applyPatch(repoRoot, patch);
  if (!ap.ok) return { mode: opts.mode, applied: false, branch, detail: `apply failed: ${ap.stderr.trim()}` };
  if (opts.mode === "apply") return { mode: "apply", applied: true };

  await git(repoRoot, ["add", "-A"]);
  const message = opts.message ?? "claudex: apply work product";
  const commitRes = await git(repoRoot, [
    "-c",
    "user.email=claudex@local",
    "-c",
    "user.name=claudex",
    "commit",
    "-m",
    message,
  ]);
  if (commitRes.code !== 0) {
    return { mode: opts.mode, applied: true, branch, detail: `commit failed: ${commitRes.stderr.trim()}` };
  }
  const commit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  if (opts.mode === "commit" || opts.mode === "branch") {
    return { mode: opts.mode, applied: true, branch, commit };
  }

  // pr
  const push = await git(repoRoot, ["push", "-u", "origin", branch as string]);
  if (push.code !== 0) {
    return { mode: "pr", applied: true, branch, commit, detail: `push failed: ${push.stderr.trim()}` };
  }
  const ghArgs = ["pr", "create", "--head", branch as string, "--title", message, "--body", "Created by Claudex."];
  const pr = await runCapture("gh", ghArgs, { cwd: repoRoot, timeoutMs: 60_000 }).catch(() => null);
  const prUrl = pr && pr.code === 0 ? pr.stdout.trim() : undefined;
  return { mode: "pr", applied: true, branch, commit, prUrl, detail: prUrl ? undefined : "gh pr create unavailable" };
}
