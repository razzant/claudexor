import { runCapture, WorkspaceError } from "@claudex/core";

export async function git(repo: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCapture("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export async function isGitRepo(repo: string): Promise<boolean> {
  const r = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function revParse(repo: string, ref: string): Promise<string> {
  const r = await git(repo, ["rev-parse", ref]);
  if (r.code !== 0) throw new WorkspaceError(`git rev-parse ${ref} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export async function statusPorcelain(repo: string): Promise<string> {
  return (await git(repo, ["status", "--porcelain"])).stdout;
}

/** Create a dangling commit capturing tracked working-tree changes; null if clean. */
export async function stashCreate(repo: string): Promise<string | null> {
  const r = await git(repo, ["stash", "create"]);
  const sha = r.stdout.trim();
  return sha.length > 0 ? sha : null;
}

export async function worktreeAdd(repo: string, path: string, branch: string, baseSha: string): Promise<void> {
  const r = await git(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** Stage everything (so untracked files appear) and return the diff vs the base commit. */
export async function diffStaged(worktreePath: string): Promise<string> {
  await git(worktreePath, ["add", "-A"]);
  return (await git(worktreePath, ["diff", "--cached"])).stdout;
}
