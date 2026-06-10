import { runCapture } from "@claudexor/core";
import { newId } from "@claudexor/util";

export * from "./gate.js";

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
}

/**
 * Deliver a WorkProduct patch according to a mutation mode. `pr` requires `gh`
 * and a configured remote. Commit identity is set per-command (no global config
 * mutation).
 */
export async function deliver(repoRoot: string, patch: string, opts: DeliverOptions): Promise<DeliverResult> {
  if (!DELIVER_MODES.has(opts.mode)) return { mode: "artifact_only", applied: false, detail: `unsupported delivery mode: ${opts.mode}` };
  if (opts.mode === "artifact_only") {
    return { mode: "artifact_only", applied: false, detail: "patch emitted; working tree untouched" };
  }
  const before = await git(repoRoot, ["status", "--porcelain"]);
  if (before.stdout.trim()) return { mode: opts.mode, applied: false, detail: "working tree is dirty; refusing delivery mutation" };

  let branch = opts.branch;
  let previousRef: string | null = null;
  if (opts.mode === "branch" || opts.mode === "pr") {
    previousRef = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || null;
    branch = branch ?? `claudexor/${newId("wp")}`;
    const cb = await git(repoRoot, ["checkout", "-b", branch]);
    if (cb.code !== 0) return { mode: opts.mode, applied: false, detail: `branch failed: ${cb.stderr.trim()}` };
  }

  const ap = await applyPatch(repoRoot, patch);
  if (!ap.ok) {
    // Do not strand the repo on a fresh branch after a failed apply.
    if (previousRef) await git(repoRoot, ["checkout", previousRef]);
    if (previousRef && branch) await git(repoRoot, ["branch", "-D", branch]);
    return { mode: opts.mode, applied: false, branch, detail: `apply failed: ${ap.stderr.trim()}` };
  }
  if (opts.mode === "apply") return { mode: "apply", applied: true };

  await stagePatchPaths(repoRoot, patch);
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
    return { mode: opts.mode, applied: false, branch, detail: `commit failed: ${commitRes.stderr.trim()}` };
  }
  const commit = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  if (opts.mode === "commit" || opts.mode === "branch") {
    return { mode: opts.mode, applied: true, branch, commit };
  }

  // pr
  const push = await git(repoRoot, ["push", "-u", "origin", branch as string]);
  if (push.code !== 0) {
    return { mode: "pr", applied: false, branch, commit, detail: `push failed: ${push.stderr.trim()}` };
  }
  const ghArgs = ["pr", "create", "--head", branch as string, "--title", message];
  if (opts.prBodyFile) ghArgs.push("--body-file", opts.prBodyFile);
  else ghArgs.push("--body", "Created by Claudexor.");
  const pr = await runCapture("gh", ghArgs, { cwd: repoRoot, timeoutMs: 60_000 }).catch(() => null);
  const prUrl = pr && pr.code === 0 ? pr.stdout.trim() : undefined;
  return { mode: "pr", applied: Boolean(prUrl), branch, commit, prUrl, detail: prUrl ? undefined : "gh pr create unavailable" };
}

async function stagePatchPaths(repoRoot: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  // The worktree was required to be clean before apply, so all post-apply
  // changes belong to this patch. `git add -A` is the only simple staging path
  // that handles additions, edits, renames, and deletions consistently.
  await git(repoRoot, ["add", "-A"]);
}
