/**
 * The ONE owner of "Claudexor's own artifact dirs are not user tree state"
 * (T3.2#6). Eight call sites used five different mechanisms — `:(exclude)`
 * pathspecs (which HARD-ERROR when the project gitignores `.claudexor`),
 * prefix filters (which over-match `.claudexorfoo`), skip-sets, and
 * hardcoded name pairs. They converge here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCaptureRaw } from "@claudexor/core";
import { WorkspaceError } from "@claudexor/core";

export const CLAUDEXOR_ARTIFACT_DIRS = [".claudexor", ".claudexor-review-evidence"] as const;

/** True when the RELATIVE path is inside one of Claudexor's artifact dirs. */
export function isClaudexorArtifactPath(rel: string): boolean {
  const clean = rel.replace(/^"|"$/g, "");
  return CLAUDEXOR_ARTIFACT_DIRS.some((dir) => clean === dir || clean.startsWith(`${dir}/`));
}

/**
 * TRACKED files under the artifact dirs are USER STATE, not artifacts: a
 * project may VERSION `.claudexor/config.yaml` / `review-panel.yaml` (this
 * repo does), and a candidate legitimately editing a tracked config must not
 * have that edit silently dropped from status/snapshots/patches (that would
 * be silent truncation of user work). Runtime artifacts are, by
 * construction, never tracked. Returns a predicate: true = artifact
 * (filterable), false = user state.
 */
export async function claudexorArtifactPredicate(repo: string): Promise<(rel: string) => boolean> {
  const tracked = await trackedArtifactDirPaths(repo);
  return (rel: string) => {
    const clean = rel.replace(/^"|"$/g, "");
    return isClaudexorArtifactPath(clean) && !tracked.has(clean);
  };
}

/**
 * User-state paths under the artifact dirs = INDEX ∪ HEAD. Index alone
 * misses a deletion the user already STAGED (`git rm .claudexor/config.yaml`
 * removes the index entry — the path must still count as user state so the
 * staged deletion survives dirty checks and snapshots); HEAD alone misses a
 * user-`git add`ed new config that is not yet committed.
 */
export async function trackedArtifactDirPaths(repo: string): Promise<Set<string>> {
  const tracked = new Set<string>();
  // -z output is EXACT (NUL-delimited, no quoting): never trim — a legal
  // filename may carry leading/trailing whitespace and a mangled key would
  // silently reclassify it as an artifact.
  const index = await git(repo, ["ls-files", "-z", "--", ...CLAUDEXOR_ARTIFACT_DIRS]);
  if (index.code === 0) {
    for (const p of index.stdout.split("\0")) {
      if (p) tracked.add(p);
    }
  }
  // HEAD may not exist yet (fresh repo) — tolerated: nothing can be
  // HEAD-tracked before the first commit, so the index alone IS complete.
  const head = await git(repo, ["ls-tree", "-r", "--name-only", "-z", "HEAD", "--", ...CLAUDEXOR_ARTIFACT_DIRS]);
  if (head.code === 0) {
    for (const p of head.stdout.split("\0")) {
      if (p) tracked.add(p);
    }
  }
  return tracked;
}

async function git(repo: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/**
 * `git status --porcelain` minus Claudexor artifact paths: the honest
 * "is the USER's tree dirty" check. Never uses `:(exclude)` pathspecs — a
 * pathspec that names a gitignored path makes git hard-error in exactly the
 * repos Claudexor itself initializes (it seeds `.claudexor/` into
 * .gitignore).
 */
export async function statusPorcelainMeaningful(repo: string): Promise<string[]> {
  const r = await git(repo, ["status", "--porcelain"]);
  if (r.code !== 0) throw new WorkspaceError(`git status failed: ${r.stderr.trim()}`);
  const isArtifact = await claudexorArtifactPredicate(repo);
  return r.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isArtifact(line.slice(3).trim()));
}

/**
 * Stage EVERYTHING except Claudexor artifacts, loudly. Bare `git add -A`
 * (honors .gitignore) followed by unstaging the artifact dirs from the
 * index — the same recipe the snapshot scratch-index uses, because it is
 * the only one that works whether or not `.claudexor` is gitignored.
 * THROWS on failure: a silent staging error turns into "nothing to commit"
 * AFTER the patch already mutated the tree (the audit's half-delivered
 * state).
 */
export async function stageAllExcludingArtifacts(repo: string): Promise<void> {
  // TRACKED files under the artifact dirs are user state (versioned config);
  // capture their paths BEFORE `git add -A` (afterwards freshly-staged
  // runtime artifacts would also read as index-tracked), then restore them
  // into the index after the bulk unstage — dropping a tracked-config edit
  // from the patch would be silent truncation of the candidate's work.
  const tracked = [...(await trackedArtifactDirPaths(repo))];
  const add = await git(repo, ["add", "-A"]);
  if (add.code !== 0) throw new WorkspaceError(`git add -A failed during staging: ${add.stderr.trim()}`);
  const unstage = await git(repo, [
    "rm",
    "-r",
    "--cached",
    "--quiet",
    "--ignore-unmatch",
    ...CLAUDEXOR_ARTIFACT_DIRS,
  ]);
  if (unstage.code !== 0) {
    throw new WorkspaceError(`unstaging Claudexor artifacts failed: ${unstage.stderr.trim()}`);
  }
  // Re-add only paths still PRESENT in the worktree: a tracked file the
  // user DELETED needs no re-add — the bulk unstage already leaves the
  // index without it, which IS the staged deletion (add on a path absent
  // from both worktree and index hard-errors). -f covers the seeded-
  // gitignore case where the whole dir is ignore-listed.
  const present = tracked.filter((p) => existsSync(join(repo, p)));
  if (present.length > 0) {
    const readd = await git(repo, ["add", "-f", "--", ...present]);
    if (readd.code !== 0) {
      throw new WorkspaceError(`re-staging tracked artifact-dir user files failed: ${readd.stderr.trim()}`);
    }
  }
}
