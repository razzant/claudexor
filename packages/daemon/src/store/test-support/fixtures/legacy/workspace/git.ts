import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, runCaptureRaw, WorkspaceError } from "../core/index.js";
import { containsSecretLikeToken, isClaudexorOwnedRuntimePath } from "../util/index.js";
import {
  initializeGitRepository,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";
export {
  GitBoundaryRootRefusedError,
  GitInitializationError,
  type EnsureGitRepositoryDependencies,
  type EnsureGitRepositoryResult,
} from "./git-initialization.js";

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
 * Capture the current worktree against an exact base without writing its blobs
 * into the user's Git object database. In-place harness output is untrusted
 * until the secret fence has inspected the resulting patch; `snapshotTree`
 * would otherwise leave a dangling raw-secret blob even when artifact
 * persistence later refused the patch.
 *
 * Git still owns filename, mode, symlink, binary, ignored-file, and untracked
 * semantics. A scratch index plus an isolated temporary object directory holds
 * the candidate tree only for the duration of `git diff`; the real object
 * directory is read-only through Git's alternates mechanism.
 */
export interface TransientDiffCapture {
  patch: string;
  /** Changed binary files whose pre- or postimage holds secret-like bytes (or
   * could not be read for inspection). The exact patch still carries their
   * payload; a persisted COPY withholds it and discloses these paths (INV-062). */
  binarySecretPaths: string[];
}

export async function captureWorkingTreeTransient(
  repo: string,
  baseSha: string,
  pathExcludes: string[] = [],
): Promise<TransientDiffCapture> {
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-transient-diff-"));
  const objectDir = join(scratchDir, "objects");
  const indexPath = join(scratchDir, "index");
  mkdirSync(objectDir, { recursive: true, mode: 0o700 });
  let primaryError: unknown;
  try {
    const actualObjects = await git(repo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]);
    if (actualObjects.code !== 0 || !actualObjects.stdout.trim()) {
      throw new WorkspaceError(
        `transient diff could not resolve Git objects: ${actualObjects.stderr.trim()}`,
      );
    }
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDir,
      // Git parses this as a path-list. C-style quoting keeps a legal `:` in a
      // macOS path from becoming a separator (and escapes quotes/backslashes).
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(actualObjects.stdout.trim()),
      GIT_OPTIONAL_LOCKS: "0",
    };
    const read = await gitEnv(repo, ["read-tree", baseSha], env);
    if (read.code !== 0) {
      throw new WorkspaceError(`transient diff read-tree failed: ${read.stderr.trim()}`);
    }
    const add = await gitEnv(repo, ["add", "-A", "--", ".", ...pathExcludes], env);
    if (add.code !== 0) {
      throw new WorkspaceError(`transient diff add failed: ${add.stderr.trim()}`);
    }
    const writeTree = await gitEnv(repo, ["write-tree"], env);
    if (writeTree.code !== 0 || !writeTree.stdout.trim()) {
      throw new WorkspaceError(`transient diff write-tree failed: ${writeTree.stderr.trim()}`);
    }
    const diff = await gitEnv(repo, ["diff", "--binary", baseSha, writeTree.stdout.trim()], env);
    if (diff.code !== 0) {
      throw new WorkspaceError(`transient diff failed: ${diff.stderr.trim()}`);
    }
    assertNoBinaryStubs(diff.stdout, `transient git diff ${baseSha}`);
    const flagged = new Set<string>();
    for (const file of parseUnifiedDiff(diff.stdout).files.filter((entry) => entry.binary)) {
      const blobs = [
        ...(!file.added && file.oldPath ? [{ tree: baseSha, path: file.oldPath }] : []),
        ...(!file.deleted && file.newPath
          ? [{ tree: writeTree.stdout.trim(), path: file.newPath }]
          : []),
      ];
      for (const blob of blobs) {
        const content = await gitEnv(repo, ["show", `${blob.tree}:${blob.path}`], env);
        // An unreadable blob is unprovable, so its payload is withheld too.
        if (content.code !== 0 || containsSecretLikeToken(content.stdout)) {
          flagged.add(file.newPath ?? file.oldPath ?? blob.path);
          break;
        }
      }
    }
    return { patch: diff.stdout, binarySecretPaths: [...flagged] };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Unlike ordinary best-effort scratch cleanup, this directory may contain
    // a candidate token blob. A cleanup failure is therefore terminal and must
    // never be hidden behind the original capture result.
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // A cleanup failure is terminal on its own, but must not erase the typed
      // capture error that explains the primary failure.
      if (primaryError === undefined) {
        const terminal = new WorkspaceError("transient diff scratch cleanup failed", {
          cause: cleanupError,
        });
        Object.defineProperty(terminal, "cleanupError", {
          value: cleanupError,
          enumerable: false,
        });
        throw terminal;
      }
      if (primaryError instanceof Error) {
        try {
          Object.defineProperty(primaryError, "cleanupError", {
            value: cleanupError,
            enumerable: false,
          });
        } catch {
          // Even a frozen/non-extensible typed error remains the primary cause.
        }
      }
    }
  }
}

export async function diffWorkingTreeTransient(
  repo: string,
  baseSha: string,
  pathExcludes: string[] = [],
): Promise<string> {
  return (await captureWorkingTreeTransient(repo, baseSha, pathExcludes)).patch;
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

export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const r = await git(repo, ["worktree", "add", "-b", branch, path, baseSha]);
  if (r.code !== 0) throw new WorkspaceError(`git worktree add failed: ${r.stderr.trim()}`);
}

/** Disposable candidate checkout with private refs/index/objects. The source
 * repository is only an object alternate, so harness `git add`/`commit` cannot
 * write candidate blobs or refs into the user's repository. */
export async function isolatedCloneAdd(
  repo: string,
  path: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  const cloned = await runCaptureRaw(
    "git",
    ["clone", "--shared", "--no-checkout", "--", repo, path],
    { timeoutMs: 120_000 },
  );
  if (cloned.code !== 0) {
    throw new WorkspaceError(`isolated clone failed: ${cloned.stderr.trim()}`);
  }
  const checkout = await git(path, ["checkout", "-b", branch, baseSha]);
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

/** Registered worktree paths of `repo` (main tree first), from porcelain output. */
async function worktreeList(repo: string): Promise<string[]> {
  const r = await git(repo, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  return r.stdout
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
