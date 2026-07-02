import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, runCaptureRaw, WorkspaceError } from "@claudexor/core";

/** BYTE-FAITHFUL git capture (T3.2#1): raw buffers, never readline — CR
 * bytes in CRLF diff content survive, and no trailing newline is fabricated
 * (trim-based consumers like revParse are unaffected: git ends its own
 * output with \n). */
export async function git(repo: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** `git` with extra environment (e.g. a scratch GIT_INDEX_FILE for snapshots). */
async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000, env });
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

/**
 * Capture the full dirty working tree (tracked AND untracked) as a dangling
 * commit; null if clean. Plain `git stash create` captures only TRACKED
 * changes, silently dropping the user's new-but-unstaged files from the run's
 * base. We instead seed a scratch index from HEAD, `add -A` into it (which
 * respects .gitignore, so run artifacts stay out), and commit-tree the result.
 */
export async function stashCreate(repo: string): Promise<string | null> {
  const status = await statusPorcelain(repo);
  // Claudexor's own run/workspace artifacts are never part of the user's dirty
  // state (concurrent envelope creation materializes `.claudexor/workspaces/...`
  // inside the repo); snapshotting them would bake run artifacts into the base.
  const meaningful = status
    .split("\n")
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
    .filter((p) => p.length > 0 && !p.startsWith(".claudexor"));
  if (meaningful.length === 0) return null;
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new WorkspaceError(`snapshot rev-parse HEAD failed: ${head.stderr.trim()}`);
  const headSha = head.stdout.trim();
  // Unique per call: concurrent envelope creates (a best_of_n wave) must never
  // collide on the scratch index (same pid + same millisecond is real). It lives
  // in the OS temp dir, NOT under `<repo>/.git` — in a linked worktree `.git` is
  // a FILE (gitdir pointer), so a scratch path there fails (review #8).
  const tmpIndex = join(tmpdir(), `claudexor-snapshot-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const env: Record<string, string> = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Claudexor",
    GIT_AUTHOR_EMAIL: "noreply@claudexor.local",
    GIT_COMMITTER_NAME: "Claudexor",
    GIT_COMMITTER_EMAIL: "noreply@claudexor.local",
  };
  try {
    const read = await gitEnv(repo, ["read-tree", "HEAD"], env);
    if (read.code !== 0) throw new WorkspaceError(`snapshot read-tree failed: ${read.stderr.trim()}`);
    // Bare `git add -A` with NO pathspec. A pathspec — positive OR `:(exclude)` —
    // that *names* an ignored path makes git hard-error ("paths are ignored ...
    // use -f") when the project's own .gitignore lists `.claudexor` (the in-place
    // bug the user hit). Bare `add -A` honors .gitignore and silently skips ignored
    // paths instead. We then unstage `.claudexor` from the SCRATCH index so run
    // artifacts never enter the snapshot even when `.claudexor` is NOT gitignored
    // (concurrent envelope materialization); `--ignore-unmatch` makes the already-
    // ignored case a clean no-op rather than an error.
    const add = await gitEnv(repo, ["add", "-A"], env);
    if (add.code !== 0) throw new WorkspaceError(`snapshot add -A failed: ${add.stderr.trim()}`);
    const unstage = await gitEnv(repo, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", ".claudexor", ".claudexor-review-evidence"], env);
    if (unstage.code !== 0) throw new WorkspaceError(`snapshot exclude .claudexor failed: ${unstage.stderr.trim()}`);
    const writeTree = await gitEnv(repo, ["write-tree"], env);
    if (writeTree.code !== 0) throw new WorkspaceError(`snapshot write-tree failed: ${writeTree.stderr.trim()}`);
    const tree = writeTree.stdout.trim();
    const commit = await gitEnv(
      repo,
      ["commit-tree", tree, "-p", headSha, "-m", "claudexor: dirty worktree snapshot (incl. untracked)"],
      env,
    );
    if (commit.code !== 0) throw new WorkspaceError(`snapshot commit-tree failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    return sha.length > 0 ? sha : null;
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      /* scratch index cleanup is best-effort */
    }
  }
}

/**
 * Capture the CURRENT working-tree state (tracked + untracked, minus `.claudexor`)
 * as a commit sha — always returns one. Dirty trees become a dangling snapshot
 * commit (via `stashCreate`); a clean tree resolves to HEAD. This is the per-turn
 * diff base for in-place threads: snapshot at turn start, snapshot at turn end,
 * `diffTrees(base, end)` yields exactly that turn's net change (pre-existing dirty
 * state is folded into `base`, so the reviewer never sees prior turns' edits).
 */
export async function snapshotTree(repo: string): Promise<string> {
  const snap = await stashCreate(repo);
  return snap ?? (await revParse(repo, "HEAD"));
}

/** Net diff between two tree-ish shas (used for in-place per-turn diffs).
 * `--binary` (T3.2#2): binary changes carry an APPLYABLE payload instead of
 * degrading to a "Binary files differ" stub that silently loses the work. */
export async function diffTrees(repo: string, baseSha: string, endSha: string): Promise<string> {
  const r = await git(repo, ["diff", "--binary", baseSha, endSha]);
  if (r.code !== 0) {
    throw new WorkspaceError(`git diff ${baseSha} ${endSha} failed: ${r.stderr.trim()}`);
  }
  assertNoBinaryStubs(r.stdout, `git diff ${baseSha} ${endSha}`);
  return r.stdout;
}

/** Capture-time honesty: with --binary a payload-less "Binary files differ"
 * stub should be impossible; if one appears anyway, fail AT CAPTURE with a
 * typed error instead of shipping a patch that cannot apply. */
function assertNoBinaryStubs(diff: string, label: string): void {
  const stubs = parseUnifiedDiff(diff).files.filter((f) => f.binaryStub);
  if (stubs.length > 0) {
    const names = stubs.map((f) => f.newPath ?? f.oldPath ?? "(unknown)").join(", ");
    throw new WorkspaceError(
      `${label} produced undeliverable binary stub(s) for: ${names}; the work product cannot be applied`,
    );
  }
}

/** Resolve the TREE object sha for a commit-ish. snapshotTree returns COMMIT
 * shas whose ids vary by timestamp even for identical content; comparing the
 * underlying tree shas is the content-stable equality test. */
async function treeOf(repo: string, sha: string): Promise<string> {
  const r = await git(repo, ["rev-parse", `${sha}^{tree}`]);
  if (r.code !== 0) throw new WorkspaceError(`rev-parse ${sha}^{tree} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export interface RevertResult {
  reverted: boolean;
  /** Turn-added files removed to restore the pre-turn state (`.claudexor` preserved). */
  removed: string[];
  reason?: string;
}

/**
 * Server-owned in-place revert: restore the live working tree to a recorded
 * pre-turn snapshot, but ONLY when the tree still matches the recorded post-turn
 * snapshot (i.e. the user hasn't edited since) — otherwise it fails loudly and
 * touches nothing. Reverts tracked modifications/deletions AND removes files the
 * turn added; `.claudexor` (run artifacts) is always preserved.
 */
export async function revertWorkingTreeTo(
  repo: string,
  preTurnSha: string,
  expectedPostSha: string,
): Promise<RevertResult> {
  // Divergence fence (compare content-stable tree shas, never commit shas).
  const current = await snapshotTree(repo);
  const [currentTree, expectedTree] = await Promise.all([treeOf(repo, current), treeOf(repo, expectedPostSha)]);
  if (currentTree !== expectedTree) {
    return { reverted: false, removed: [], reason: "working tree diverged from the recorded post-turn state; refusing to revert" };
  }
  // Files the turn ADDED (in post, absent in pre) must be removed; restore alone
  // only reverts tracked modifications/deletions, never deletes extra files.
  // `--no-renames` forces a turn rename to surface as delete-old + ADD-new so the
  // new path is caught here (rename detection would hide it under an R status).
  const added = await git(repo, ["diff", "--no-renames", "--name-only", "--diff-filter=A", preTurnSha, expectedPostSha]);
  if (added.code !== 0) throw new WorkspaceError(`revert diff failed: ${added.stderr.trim()}`);
  const toRemove = added.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((p) => p.length > 0 && !p.startsWith(".claudexor"));
  // Restore every path present in the pre-turn snapshot (mods + deletions).
  const restore = await git(repo, ["checkout", preTurnSha, "--", "."]);
  if (restore.code !== 0) throw new WorkspaceError(`revert checkout failed: ${restore.stderr.trim()}`);
  const removed: string[] = [];
  for (const rel of toRemove) {
    try {
      rmSync(join(repo, rel), { force: true });
      removed.push(rel);
    } catch {
      /* best-effort: a file already gone is fine */
    }
  }
  // Re-sync the index so `git status` reflects the restored tree (checkout left
  // turn-added paths staged-for-delete handling to us).
  await git(repo, ["add", "-A", "--", "."]);
  await git(repo, ["reset", "--quiet"]);
  return { reverted: true, removed };
}

export async function worktreeAdd(repo: string, path: string, branch: string, baseSha: string): Promise<void> {
  const r = await git(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Apply a unified diff to a tree with a 3-way merge (race-winner adoption into
 * the live in-place tree). Throws loudly on conflict so the caller can disclose
 * `adopted:false` and offer a manual apply — the work is never silently lost.
 */
export async function applyPatch(repo: string, diff: string): Promise<void> {
  if (!diff.trim()) return;
  // OS temp dir, not `<repo>/.git` (a worktree's `.git` is a file — review #9).
  const patchFile = join(tmpdir(), `claudexor-adopt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.patch`);
  try {
    writeFileSync(patchFile, diff, "utf8");
    const r = await git(repo, ["apply", "--3way", "--whitespace=nowarn", patchFile]);
    if (r.code !== 0) throw new WorkspaceError(`git apply --3way failed: ${r.stderr.trim()}`);
  } finally {
    try {
      rmSync(patchFile, { force: true });
    } catch {
      /* best-effort patch-file cleanup */
    }
  }
}

export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ["worktree", "prune"]);
}

/** Delete a local branch (best-effort GC of per-attempt claudexor/* branches). */
export async function branchDelete(repo: string, branch: string): Promise<void> {
  await git(repo, ["branch", "-D", branch]);
}

/**
 * Stage everything (so untracked files appear) and return the diff vs the
 * recorded BASE sha — NOT the worktree HEAD. A harness that commits inside the
 * worktree (Claude Code does this routinely) advances HEAD; diffing vs HEAD
 * would then hide the committed work and report an empty no-op diff, silently
 * losing the candidate's real output. Diffing the staged tree vs base_sha
 * captures all net change since the run started regardless of intermediate
 * commits. Git op failures throw loudly instead of masquerading as "no changes".
 */
export async function diffStaged(worktreePath: string, baseSha?: string): Promise<string> {
  await runCaptureRaw("rm", ["-rf", ".claudexor-review-evidence"], { cwd: worktreePath, timeoutMs: 10_000 }).catch(() => null);
  const add = await git(worktreePath, ["add", "-A"]);
  if (add.code !== 0) {
    throw new WorkspaceError(`git add -A failed during diff capture: ${add.stderr.trim()}`);
  }
  const target = baseSha && baseSha.length > 0 ? baseSha : "HEAD";
  const diff = await git(worktreePath, ["diff", "--binary", "--cached", target]);
  if (diff.code !== 0) {
    throw new WorkspaceError(`git diff --cached ${target} failed during diff capture: ${diff.stderr.trim()}`);
  }
  assertNoBinaryStubs(diff.stdout, `git diff --cached ${target}`);
  return diff.stdout;
}
