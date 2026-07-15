import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, runCaptureRaw, WorkspaceError } from "@claudexor/core";

/** BYTE-FAITHFUL git capture: raw buffers, never readline — CR
 * bytes in CRLF diff content survive, and no trailing newline is fabricated
 * (trim-based consumers like revParse are unaffected: git ends its own
 * output with \n). */
export async function git(
  repo: string,
  args: string[],
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000, input });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/** `git` with extra environment (e.g. a scratch GIT_INDEX_FILE for snapshots). */
async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    env,
    input,
  });
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
  /** Always false in v2: Claudexor never changes a project's `.gitignore`. */
  gitignoreSeeded: boolean;
  /** HEAD sha after the call. */
  headSha: string;
}

/**
 * Make a project folder usable as a git boundary for write-mode runs.
 *
 * Comparator note: Codex CLI refuses to run outside a git repo (its official
 * quick start is `mkdir && git init && codex`); Claudexor goes one step
 * further and creates the boundary itself, announced via the
 * `project.git.initialized` run event. The baseline commit makes worktree
 * diffs honest from the first run. Runtime is external, so project ignore
 * files are never created or edited as a side effect.
 *
 * The baseline commit is authored as "Claudexor" deterministically — it is a
 * tool-created commit and must not depend on (or pollute) user git identity.
 */
export async function ensureGitRepository(repo: string): Promise<EnsureGitRepositoryResult> {
  const isRepo = await isGitRepo(repo);
  const hasHead = isRepo && (await git(repo, ["rev-parse", "--verify", "HEAD"])).code === 0;
  if (isRepo && hasHead) {
    return {
      initialized: false,
      baselineCommitted: false,
      gitignoreSeeded: false,
      headSha: await revParse(repo, "HEAD"),
    };
  }

  let initialized = false;
  if (!isRepo) {
    const init = await git(repo, ["init"]);
    if (init.code !== 0) throw new WorkspaceError(`git init failed: ${init.stderr.trim()}`);
    initialized = true;
  }

  const add = await git(repo, ["add", "-A"]);
  if (add.code !== 0)
    throw new WorkspaceError(
      `git add failed during repository initialization: ${add.stderr.trim()}`,
    );
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
  if (commit.code !== 0)
    throw new WorkspaceError(
      `baseline commit failed during repository initialization: ${commit.stderr.trim()}`,
    );
  return {
    initialized,
    baselineCommitted: true,
    gitignoreSeeded: false,
    headSha: await revParse(repo, "HEAD"),
  };
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
  // NUL form is filename-faithful (newlines, quotes and whitespace are legal
  // path bytes). Runtime is external, so every reported path is user state.
  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0)
    throw new WorkspaceError(`snapshot status failed: ${status.stderr.trim()}`);
  if (status.stdout.length === 0) return null;
  const head = await git(repo, ["rev-parse", "HEAD"]);
  if (head.code !== 0)
    throw new WorkspaceError(`snapshot rev-parse HEAD failed: ${head.stderr.trim()}`);
  const headSha = head.stdout.trim();
  // Unique per call: concurrent envelope creates (a best_of_n wave) must never
  // collide on the scratch index (same pid + same millisecond is real). It lives
  // in the OS temp dir, NOT under `<repo>/.git` — in a linked worktree `.git` is
  // a FILE (gitdir pointer), so a scratch path there fails (review #8).
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-snapshot-index-"));
  const tmpIndex = join(scratchDir, "index");
  const env: Record<string, string> = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "Claudexor",
    GIT_AUTHOR_EMAIL: "noreply@claudexor.local",
    GIT_COMMITTER_NAME: "Claudexor",
    GIT_COMMITTER_EMAIL: "noreply@claudexor.local",
  };
  try {
    const read = await gitEnv(repo, ["read-tree", "HEAD"], env);
    if (read.code !== 0)
      throw new WorkspaceError(`snapshot read-tree failed: ${read.stderr.trim()}`);
    // Bare add runs only against the scratch index. It respects the project's
    // own ignore policy without changing the live index. `.claudexor/` is not a
    // runtime exception in v2: tracked or untracked project config is user state.
    const add = await gitEnv(repo, ["add", "-A"], env);
    if (add.code !== 0) throw new WorkspaceError(`snapshot add -A failed: ${add.stderr.trim()}`);
    const writeTree = await gitEnv(repo, ["write-tree"], env);
    if (writeTree.code !== 0)
      throw new WorkspaceError(`snapshot write-tree failed: ${writeTree.stderr.trim()}`);
    const tree = writeTree.stdout.trim();
    const commit = await gitEnv(
      repo,
      [
        "commit-tree",
        tree,
        "-p",
        headSha,
        "-m",
        "claudexor: dirty worktree snapshot (incl. untracked)",
      ],
      env,
    );
    if (commit.code !== 0)
      throw new WorkspaceError(`snapshot commit-tree failed: ${commit.stderr.trim()}`);
    const sha = commit.stdout.trim();
    return sha.length > 0 ? sha : null;
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
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
 * `--binary`: binary changes carry an APPLYABLE payload instead of
 * degrading to a "Binary files differ" stub that silently loses the work. */
export async function diffTrees(repo: string, baseSha: string, endSha: string): Promise<string> {
  const r = await git(repo, ["diff", "--binary", baseSha, endSha]);
  if (r.code !== 0) {
    throw new WorkspaceError(`git diff ${baseSha} ${endSha} failed: ${r.stderr.trim()}`);
  }
  assertNoBinaryStubs(r.stdout, `git diff ${baseSha} ${endSha}`);
  return r.stdout;
}

/**
 * Materialize a patch against an exact base in a scratch index and return the
 * resulting tree id. The live index and worktree are never consulted or
 * changed. Commit-class delivery uses this as its expected candidate tree so a
 * concurrently staged user path can never be swept into a Claudexor commit.
 */
export async function materializePatchTree(
  repo: string,
  baseSha: string,
  diff: string,
): Promise<string> {
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-patch-index-"));
  const indexPath = join(scratchDir, "index");
  const env = { GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const read = await gitEnv(repo, ["read-tree", baseSha], env);
    if (read.code !== 0) {
      throw new WorkspaceError(
        `git read-tree ${baseSha} failed during patch materialization: ${read.stderr.trim()}`,
      );
    }
    if (diff.trim()) {
      const applied = await gitEnv(
        repo,
        ["apply", "--cached", "--whitespace=nowarn", "-"],
        env,
        diff,
      );
      if (applied.code !== 0) {
        throw new WorkspaceError(
          `scratch git apply failed during patch materialization: ${applied.stderr.trim()}`,
        );
      }
    }
    const written = await gitEnv(repo, ["write-tree"], env);
    if (written.code !== 0) {
      throw new WorkspaceError(`scratch git write-tree failed: ${written.stderr.trim()}`);
    }
    return written.stdout.trim();
  } finally {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* scratch index cleanup is best-effort */
    }
  }
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
  // Git itself produces the exact binary/mode/symlink-aware forward patch.
  // Reverse-applying it touches only turn-owned hunks. A later edit that
  // overlaps those hunks makes --check fail; unrelated user edits, staged state,
  // and untracked files remain outside the mutation surface.
  const patch = await diffTrees(repo, preTurnSha, expectedPostSha);
  return revertWorkingTreePatch(repo, patch);
}

/** Reverse an immutable turn patch. This is the GC-independent production
 * path used by external revert anchors; the SHA-based wrapper remains useful
 * while capturing and testing snapshots. */
export async function revertWorkingTreePatch(repo: string, patch: string): Promise<RevertResult> {
  if (!patch.trim()) return { reverted: true, removed: [] };
  const removed = parseUnifiedDiff(patch)
    .files.filter((file) => file.added && file.newPath)
    .map((file) => file.newPath as string);
  const check = await git(
    repo,
    ["apply", "--check", "--reverse", "--whitespace=nowarn", "-"],
    patch,
  );
  if (check.code !== 0) {
    return {
      reverted: false,
      removed: [],
      reason: `turn-owned postimage no longer matches; refusing to overwrite later user edits: ${check.stderr.trim()}`,
    };
  }
  const before = await statusPorcelain(repo);
  const apply = await git(repo, ["apply", "--reverse", "--whitespace=nowarn", "-"], patch);
  if (apply.code !== 0) {
    const after = await statusPorcelain(repo);
    return {
      reverted: false,
      removed: [],
      reason:
        `reverse apply failed after preflight: ${apply.stderr.trim()}; ` +
        (after === before
          ? "tree remains at the observed pre-revert state"
          : "target changed during revert; no destructive rollback was attempted"),
    };
  }
  return { reverted: true, removed };
}

export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const r = await git(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

/** Recreate a worktree for an EXISTING branch (recovery: dir lost, branch survived). */
export async function worktreeAddExisting(
  repo: string,
  path: string,
  branch: string,
): Promise<void> {
  // A stale registration for the lost directory would fail the add; prune first.
  await git(repo, ["worktree", "prune"]);
  const r = await git(repo, ["worktree", "add", path, branch]);
  if (r.code !== 0)
    throw new WorkspaceError(`git worktree add (existing branch) failed: ${r.stderr.trim()}`);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Apply a unified diff to a tree with a 3-way merge (race-winner adoption into
 * the live in-place tree). Throws loudly on conflict so the caller can disclose
 * `adopted:false` and offer a manual apply — the work is never silently lost.
 */

export interface ProtectedApplyResult {
  ok: boolean;
  /** True when the tree does NOT match its pre-apply state (restore failed). */
  treeMutated: boolean;
  detail?: string;
}

async function runProtectedApply(
  repo: string,
  diff: string,
  options: { index: boolean; reverse: boolean },
): Promise<ProtectedApplyResult> {
  if (!diff.trim()) return { ok: true, treeMutated: false, detail: "empty patch; no-op" };
  const flags = [
    "apply",
    ...(options.index ? ["--index"] : []),
    ...(options.reverse ? ["--reverse"] : []),
    "--whitespace=nowarn",
  ];
  const check = await git(repo, [...flags, "--check", "-"], diff);
  if (check.code !== 0) {
    return {
      ok: false,
      // A refused forward apply has not touched the tree. A refused reverse
      // means the Claudexor-written postimage could not be removed exactly and
      // therefore remains a mutation that must be surfaced to the operator.
      treeMutated: options.reverse,
      detail: `${options.reverse ? "reverse " : ""}apply --check refused: ${check.stderr.trim()}`,
    };
  }
  const before = await statusPorcelain(repo);
  const applied = await git(repo, [...flags, "-"], diff);
  if (applied.code === 0) {
    return {
      ok: true,
      // Forward apply introduces the patch; reverse apply removes it.
      treeMutated: !options.reverse,
    };
  }
  const after = await statusPorcelain(repo);
  const unchanged = after === before;
  return {
    ok: false,
    treeMutated: options.reverse ? true : !unchanged,
    detail:
      `${options.reverse ? "reverse " : ""}apply failed after preflight: ${applied.stderr.trim()}` +
      (unchanged
        ? "; tree and index remain at the observed pre-operation state"
        : "; target changed during apply; no destructive rollback was attempted"),
  };
}

/**
 * The protected apply path deliberately does not use `--3way`: 3-way failures
 * may leave conflict stages and historically triggered a destructive
 * `checkout -- .` rollback. Plain `git apply` is all-or-nothing unless
 * `--reject` is requested (we never request it). A stale/concurrent target is
 * refused; no automatic rollback ever overwrites user state.
 */
export async function applyPatchProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: false, reverse: false });
}

/**
 * Commit-class delivery updates the worktree and index as one Git operation.
 * `git apply --index` refuses when either preimage diverged and does not sweep
 * unrelated paths into the index.
 */
export async function applyPatchAndIndexProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: true, reverse: false });
}

/**
 * Remove only an exact Claudexor-written patch postimage from worktree+index.
 * This is the sole post-apply compensation path: no reset, checkout, or
 * path-blind deletion is permitted. Concurrent overlapping edits make the
 * reverse check fail and are preserved for an explicit recovery decision.
 */
export async function reversePatchAndIndexProtected(
  repo: string,
  diff: string,
): Promise<ProtectedApplyResult> {
  return runProtectedApply(repo, diff, { index: true, reverse: true });
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
  const target = baseSha && baseSha.length > 0 ? baseSha : "HEAD";
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-diff-index-"));
  const indexPath = join(scratchDir, "index");
  const env = { GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
  try {
    const read = await gitEnv(worktreePath, ["read-tree", target], env);
    if (read.code !== 0) {
      throw new WorkspaceError(
        `git read-tree ${target} failed during diff capture: ${read.stderr.trim()}`,
      );
    }
    const add = await gitEnv(worktreePath, ["add", "-A"], env);
    if (add.code !== 0) {
      throw new WorkspaceError(
        `scratch git add -A failed during diff capture: ${add.stderr.trim()}`,
      );
    }
    const diff = await gitEnv(worktreePath, ["diff", "--binary", "--cached", target], env);
    if (diff.code !== 0) {
      throw new WorkspaceError(
        `git diff --cached ${target} failed during diff capture: ${diff.stderr.trim()}`,
      );
    }
    assertNoBinaryStubs(diff.stdout, `git diff --cached ${target}`);
    return diff.stdout;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
