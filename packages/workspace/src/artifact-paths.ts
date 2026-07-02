/**
 * The ONE owner of "Claudexor's own artifact dirs are not user tree state"
 * (T3.2#6). Eight call sites used five different mechanisms — `:(exclude)`
 * pathspecs (which HARD-ERROR when the project gitignores `.claudexor`),
 * prefix filters (which over-match `.claudexorfoo`), skip-sets, and
 * hardcoded name pairs. They converge here.
 */
import { runCaptureRaw } from "@claudexor/core";
import { WorkspaceError } from "@claudexor/core";

export const CLAUDEXOR_ARTIFACT_DIRS = [".claudexor", ".claudexor-review-evidence"] as const;

/** True when the RELATIVE path is inside one of Claudexor's artifact dirs. */
export function isClaudexorArtifactPath(rel: string): boolean {
  const clean = rel.replace(/^"|"$/g, "");
  return CLAUDEXOR_ARTIFACT_DIRS.some((dir) => clean === dir || clean.startsWith(`${dir}/`));
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
  return r.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isClaudexorArtifactPath(line.slice(3).trim()));
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
}
