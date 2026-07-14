import { runCaptureRaw, WorkspaceError } from "@claudexor/core";

async function git(
  repo: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await runCaptureRaw("git", ["-C", repo, ...args], { timeoutMs: 60_000 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Honest user-tree status. Claudexor v2 has no repo-local runtime carve-out:
 * `.claudexor/`, `.claudexor-review-evidence/`, and similarly named paths are
 * ordinary user state and must participate in dirty/preimage checks.
 *
 * Entries are NUL-delimited raw porcelain records so unusual legal filenames
 * cannot disappear through quote/trim parsing. Callers currently need only the
 * empty/non-empty property; preserving each record keeps future diagnostics
 * lossless.
 */
export async function statusPorcelainMeaningful(repo: string): Promise<string[]> {
  const r = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.code !== 0) throw new WorkspaceError(`git status failed: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter((entry) => entry.length > 0);
}
