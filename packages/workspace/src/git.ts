import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCapture, WorkspaceError } from "@claudexor/core";

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

export interface EnsureGitRepositoryResult {
  /** True when `git init` ran (the folder was not a repository). */
  initialized: boolean;
  /** True when a baseline commit was created (fresh repo or unborn HEAD). */
  baselineCommitted: boolean;
  /** True when `.claudexor/` was added to (or created in) .gitignore. */
  gitignoreSeeded: boolean;
  /** HEAD sha after the call. */
  headSha: string;
}

const GITIGNORE_SEED = ".claudexor/";

/**
 * Make a project folder usable as a git boundary for write-mode runs.
 *
 * Comparator note: Codex CLI refuses to run outside a git repo (its official
 * quick start is `mkdir && git init && codex`); Claudexor goes one step
 * further and creates the boundary itself, announced via the
 * `project.git.initialized` run event. The baseline commit makes worktree
 * diffs honest from the very first run; `.claudexor/` is seeded into
 * .gitignore FIRST so run artifacts never enter the baseline.
 *
 * The baseline commit is authored as "Claudexor" deterministically — it is a
 * tool-created commit and must not depend on (or pollute) user git identity.
 */
export async function ensureGitRepository(repo: string): Promise<EnsureGitRepositoryResult> {
  const isRepo = await isGitRepo(repo);
  const hasHead = isRepo && (await git(repo, ["rev-parse", "--verify", "HEAD"])).code === 0;
  if (isRepo && hasHead) {
    return { initialized: false, baselineCommitted: false, gitignoreSeeded: false, headSha: await revParse(repo, "HEAD") };
  }

  let gitignoreSeeded = false;
  const gitignorePath = join(repo, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${GITIGNORE_SEED}\n`, "utf8");
    gitignoreSeeded = true;
  } else {
    const raw = readFileSync(gitignorePath, "utf8");
    const lines = raw.split("\n").map((l) => l.trim());
    if (!lines.includes(GITIGNORE_SEED) && !lines.includes(".claudexor")) {
      // A missing trailing newline would concatenate the seed onto the last
      // pattern (e.g. "node_modules.claudexor/"), silently un-ignoring run
      // artifacts right before the baseline `git add -A`.
      const separator = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
      appendFileSync(gitignorePath, `${separator}${GITIGNORE_SEED}\n`, "utf8");
      gitignoreSeeded = true;
    }
  }

  let initialized = false;
  if (!isRepo) {
    const init = await git(repo, ["init"]);
    if (init.code !== 0) throw new WorkspaceError(`git init failed: ${init.stderr.trim()}`);
    initialized = true;
  }

  const add = await git(repo, ["add", "-A"]);
  if (add.code !== 0) throw new WorkspaceError(`git add failed during repository initialization: ${add.stderr.trim()}`);
  const commit = await git(repo, [
    "-c",
    "user.name=Claudexor",
    "-c",
    "user.email=noreply@claudexor.local",
    "commit",
    "--allow-empty",
    "--no-verify",
    "-m",
    "claudexor: initialize repository baseline",
  ]);
  if (commit.code !== 0) throw new WorkspaceError(`baseline commit failed during repository initialization: ${commit.stderr.trim()}`);
  return { initialized, baselineCommitted: true, gitignoreSeeded, headSha: await revParse(repo, "HEAD") };
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
  await runCapture("rm", ["-rf", ".claudexor-review-evidence"], { cwd: worktreePath, timeoutMs: 10_000 }).catch(() => null);
  await git(worktreePath, ["add", "-A"]);
  return (await git(worktreePath, ["diff", "--cached"])).stdout;
}
