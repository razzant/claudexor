import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { assertCaptureComplete, runCaptureRaw, WorkspaceError } from "@claudexor/core";
import { isClaudexorOwnedRuntimePath } from "@claudexor/util";
import {
  initializeGitRepository,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";
import { assertNoBinaryStubs, git, gitEnv, SCRATCH_INDEX_CONFIG } from "./git-run.js";
import { diskProgress, gitObserved } from "./git-observed.js";
export { git, revParse } from "./git-run.js";
export { captureWorkingTreeTransient, diffWorkingTreeTransient } from "./git-transient-capture.js";
export {
  GitBoundaryRootRefusedError,
  GitInitializationError,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";

export async function isGitRepo(repo: string): Promise<boolean> {
  const r = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
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
export async function ensureGitRepository(
  repo: string,
  dependencies: EnsureGitRepositoryDependencies = {},
): Promise<EnsureGitRepositoryResult> {
  return initializeGitRepository(
    repo,
    dependencies.runGit ?? git,
    dependencies.probeCapability,
    dependencies.rootPolicy,
  );
}

export async function statusPorcelain(repo: string): Promise<string> {
  return (await git(repo, ["status", "--porcelain"])).stdout;
}

export { snapshotTree, stashCreate } from "./git-snapshot.js";

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
    const read = await gitEnv(repo, [...SCRATCH_INDEX_CONFIG, "read-tree", baseSha], env);
    if (read.code !== 0) {
      throw new WorkspaceError(
        `git read-tree ${baseSha} failed during patch materialization: ${read.stderr.trim()}`,
      );
    }
    if (diff.trim()) {
      const applied = await gitEnv(
        repo,
        [...SCRATCH_INDEX_CONFIG, "apply", "--cached", "--whitespace=nowarn", "-"],
        env,
        diff,
      );
      if (applied.code !== 0) {
        throw new WorkspaceError(
          `scratch git apply failed during patch materialization: ${applied.stderr.trim()}`,
        );
      }
    }
    const written = await gitEnv(repo, [...SCRATCH_INDEX_CONFIG, "write-tree"], env);
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

export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const r = await gitObserved(repo, ["worktree", "add", "-b", branch, path, baseSha], {
    label: "worktree add",
    progress: diskProgress(repo),
    allowFailure: true,
  });
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

/** Disposable candidate checkout with private refs/index/objects. The source
 * repository is only an object alternate, so harness `git add`/`commit` cannot
 * write candidate blobs or refs into the user's repository. Claudexor's own
 * clone lists the project object store as a SECOND alternate (#535 D2): a
 * dirty base resolves after the user's prune; the user repo never gets it. */
export async function isolatedCloneAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
  storeObjects?: string,
): Promise<void> {
  const cloned = await runCaptureRaw(
    "git",
    ["clone", "--shared", "--no-checkout", "--", repo, path],
    { timeoutMs: 120_000, windowsConsole: "none" },
  );
  assertCaptureComplete(cloned);
  if (cloned.code !== 0) {
    throw new WorkspaceError(`isolated clone failed: ${cloned.stderr.trim()}`);
  }
  if (storeObjects && existsSync(storeObjects)) {
    const alternates = join(path, ".git", "objects", "info", "alternates");
    appendFileSync(alternates, `${storeObjects}\n`);
  }
  // A large checkout may take long: only a stall (no disk progress) stops it.
  const checkout = await gitObserved(path, ["checkout", "-q", "-b", branch, baseSha], {
    label: "checkout (isolated clone)",
    progress: diskProgress(path),
    allowFailure: true,
  });
  if (checkout.code !== 0) {
    throw new WorkspaceError(`isolated clone checkout failed: ${checkout.stderr.trim()}`);
  }
  const detachedRemote = await git(path, ["remote", "remove", "origin"]);
  if (detachedRemote.code !== 0) {
    throw new WorkspaceError(
      `isolated clone remote removal failed: ${detachedRemote.stderr.trim()}`,
    );
  }
}

/** Recreate a worktree for an EXISTING branch (recovery: dir lost, branch survived). */
export async function worktreeAddExisting(
  repo: string,
  path: string,
  branch: string,
): Promise<void> {
  // A stale registration for the lost directory would fail the add, so it has
  // to go — but ONLY it. `git worktree prune` is repo-wide (see worktreePrune)
  // and would take a co-writer's momentarily-absent tree of the same git dir
  // with it; this recovery runs against the USER'S project root, so that is
  // exactly the shared git dir. Deregistering the one path we are about to
  // recreate is the whole need.
  await worktreeRemove(repo, path);
  const r = await git(repo, ["worktree", "add", path, branch]);
  if (r.code !== 0)
    throw new WorkspaceError(`git worktree add (existing branch) failed: ${r.stderr.trim()}`);
}

/** Best-effort: Git's exit status is ignored. An owner that must not report a
 * refused removal as done uses `worktreeRemoveRegistered`. */
export async function worktreeRemove(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path]);
}

/**
 * Deregister the linked worktree Git records at `path`; Git deletes its
 * directory too. A path Git does not register is already removed. A refusal
 * (a locked worktree, an unreadable registration) throws and leaves the
 * registration and the directory as they were. A directory Git cannot delete
 * (a permission error) throws after Git deleted the registration: the
 * directory stays, its `.git` file naming what is gone. The registration is
 * found by `samePlace` and removed in Git's own spelling, so a stale one whose
 * directory is gone still goes. Git prints porcelain paths unquoted, one per
 * line, so a path holding a line break cannot be read back and is refused
 * rather than reported absent. `beforeRemove` runs once Git is known to
 * register the path, right before the removal.
 */
export async function worktreeRemoveRegistered(
  repo: string,
  path: string,
  beforeRemove: () => Promise<void> = async () => {},
): Promise<void> {
  if (path.includes("\n")) {
    throw new WorkspaceError(
      `worktree path has a line break that git worktree list cannot report: ${JSON.stringify(path)}`,
    );
  }
  const listed = await git(repo, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) {
    throw new WorkspaceError(`git worktree list failed: ${listed.stderr.trim()}`);
  }
  const registered = worktreePaths(listed.stdout).find((entry) => samePlace(entry, path));
  if (registered === undefined) return;
  await beforeRemove();
  const r = await git(repo, ["worktree", "remove", "--force", registered]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree remove failed: ${r.stderr.trim()}`);
}

/**
 * The common Git directory of the repository that registered the linked
 * worktree at `path`, from Git's own records: the worktree's `.git` file names
 * its registration, which must still exist and name this worktree back. Null
 * when `path` holds no such file. A registration that is gone or names another
 * worktree is what a moved or deleted repository leaves, and also a removal
 * that deleted the registration but not the directory
 * (`worktreeRemoveRegistered`; a later worktree can take the freed name).
 * `recorded`, called only then, tells them apart: the common Git directory a
 * caller kept from before its removal is returned when the registration was
 * in it. Otherwise this throws, since whatever a moved repository still
 * records cannot be proven gone.
 */
export function worktreeRepository(
  path: string,
  recorded: () => string | null = () => null,
): string | null {
  const gitfile = join(path, ".git");
  const pointer = /^gitdir: (.+)$/m.exec(plainText(gitfile) ?? "")?.[1]?.trimEnd();
  if (!pointer) return null;
  const registration = resolve(path, pointer);
  const named = plainText(join(registration, "gitdir"))?.trimEnd();
  if (named && samePlace(resolve(registration, named), gitfile))
    return resolve(registration, readFileSync(join(registration, "commondir"), "utf8").trimEnd());
  const gitDir = recorded();
  if (gitDir !== null && samePlace(dirname(registration), join(gitDir, "worktrees"))) return gitDir;
  throw new WorkspaceError(
    `Git no longer registers worktree ${path} at ${registration}: its repository moved or was deleted; if it moved, run "git worktree repair" in it so the next attempt can finish this cleanup`,
  );
}

/** The common Git directory of the repository `dir` is in; throws when Git cannot tell. */
export async function gitCommonDir(dir: string): Promise<string> {
  const r = await git(dir, ["rev-parse", "--git-common-dir"]);
  if (r.code !== 0) {
    throw new WorkspaceError(`git rev-parse --git-common-dir failed: ${r.stderr.trim()}`);
  }
  return resolve(dir, r.stdout.trim());
}

/** A regular file's text, or null when nothing (or no regular file) is there. */
function plainText(file: string): string | null {
  try {
    return lstatSync(file).isFile() ? readFileSync(file, "utf8") : null;
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

/**
 * Whether two spellings name the same place: the deepest existing part of
 * each is one file by identity, so the filesystem itself decides about letter
 * case, links and Unicode normalization, and the names below it are equal.
 * Without a usable identity the spellings must match exactly.
 */
function samePlace(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const [x, y] = [existingPart(a), existingPart(b)];
  if (x.rest !== y.rest) return false;
  if (!x.stat || !y.stat || x.stat.ino === 0n || y.stat.ino === 0n) return x.path === y.path;
  return x.stat.dev === y.stat.dev && x.stat.ino === y.stat.ino;
}

function existingPart(path: string): { path: string; stat: BigIntStats | null; rest: string } {
  const rest: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    let stat: BigIntStats | null = null;
    try {
      stat = statSync(current, { bigint: true });
    } catch (error) {
      if (!absent(error)) throw error;
    }
    if (stat || dirname(current) === current) return { path: current, stat, rest: rest.join(sep) };
    rest.unshift(basename(current));
  }
}

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
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

/** Registered worktree paths of `repo` (main tree first), from porcelain output. */
async function worktreeList(repo: string): Promise<string[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  return worktreePaths(r.stdout);
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((path) => path.length > 0);
}

/**
 * Prune stale worktree registrations — but ONLY when every stale one is ours.
 *
 * `git worktree prune` is REPO-WIDE: it deregisters every worktree whose
 * directory is missing at that instant, across the whole shared git dir. When
 * another writer drives Claudexor from its own worktrees of the same
 * repository, a tree of theirs that is momentarily absent (being recreated, on
 * an unmounted volume) is indistinguishable from dead debris — and pruning it
 * silently unregisters someone else's live workspace. Claudexor's own envelope
 * trees live under the Claudexor runtime root, so that is the whole test.
 *
 * Leaving OUR stale admin entry behind is cheap (it costs a directory under
 * `.git/worktrees` until a prune is safe again, and a caller that must reuse
 * one exact name deregisters that one path with `worktreeRemove`).
 * Deregistering a worktree we do not own is not recoverable by us at all.
 * Refusing is the honest trade.
 *
 * This is the ONLY place in the tree that runs the repo-wide `worktree prune`;
 * a second ungated caller re-opens the whole harm, so keep it that way.
 */
export async function worktreePrune(repo: string): Promise<void> {
  for (const path of await worktreeList(repo)) {
    if (existsSync(path) || isClaudexorOwnedRuntimePath(path)) continue;
    return;
  }
  await git(repo, ["worktree", "prune"]);
}

/** Delete a local branch (best-effort GC of per-attempt claudexor/* branches). */
export async function branchDelete(repo: string, branch: string): Promise<void> {
  await git(repo, ["branch", "-D", branch]);
}

/**
 * Delete a local branch, or throw when Git refuses (a held ref lock, a
 * worktree that still uses it). An absent branch is already deleted. Presence
 * is read first because `branch -D` reports "not found" and a refusal with the
 * same exit code. `beforeDelete` runs only for a present branch, right before
 * the deletion.
 */
export async function branchDeleteIfPresent(
  repo: string,
  branch: string,
  beforeDelete: () => Promise<void> = async () => {},
): Promise<void> {
  const present = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (present.code === 1) return;
  if (present.code !== 0) {
    throw new WorkspaceError(`git show-ref ${branch} failed: ${present.stderr.trim()}`);
  }
  await beforeDelete();
  const r = await git(repo, ["branch", "-D", branch]);
  if (r.code !== 0) throw new WorkspaceError(`git branch -D ${branch} failed: ${r.stderr.trim()}`);
}
