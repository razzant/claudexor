import type { GitResultRefusal } from "@claudexor/schema";
import { lstatPresent } from "./fs-presence.js";
import { classifyGitFailure, gitObserved, GitOperationError } from "./git-observed.js";

/** `git sparse-checkout check-rules` arrived in Git 2.41; an older Git answers its
 * usage error (exit 129: an unknown subcommand) instead. */
const CHECK_RULES_UNKNOWN = 129;

/**
 * The paths among `paths` that the worktree's sparse-checkout patterns leave out
 * (none when it is not a sparse checkout), from one `check-rules` call, or null when
 * this Git cannot evaluate the patterns (older than 2.41). A snapshot's `add -A`
 * skips such a path, a tracked one keeping HEAD's blob whether its file is absent,
 * as a sparse checkout usually leaves it, or present, so an operation that addresses
 * one could not tell what it holds before or after writing. With
 * `core.sparseCheckout` set but no patterns file, Git checks out everything, and so
 * nothing is left out here either. A worktree that is not sparse costs one
 * `git config` and never asks `check-rules`.
 */
export async function outsideSparseCheckout(
  worktree: string,
  paths: readonly string[],
  env: Record<string, string>,
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const sparse = await gitObserved(
    worktree,
    ["config", "--type=bool", "--get", "core.sparseCheckout"],
    { env, label: "config core.sparseCheckout", allowFailure: true },
  );
  if (sparse.stdout.trim() !== "true") return [];
  const patterns = await gitObserved(
    worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout"],
    { env, label: "rev-parse --git-path info/sparse-checkout" },
  );
  if (!lstatPresent(patterns.stdout.trim())) return [];
  const kept = await gitObserved(worktree, ["sparse-checkout", "check-rules", "-z"], {
    env,
    label: "sparse-checkout check-rules",
    input: paths.map((path) => `${path}\0`).join(""),
    allowFailure: true,
  });
  if (kept.code === CHECK_RULES_UNKNOWN) return null;
  if (kept.code !== 0)
    throw new GitOperationError(
      classifyGitFailure(kept.stderr),
      `git sparse-checkout check-rules failed: ${kept.stderr.trim().slice(0, 2_000)}`,
    );
  const inside = new Set(kept.stdout.split("\0"));
  return paths.filter((path) => !inside.has(path));
}

/**
 * The refusal of an operation that must write or remove a path outside the
 * sparse-checkout patterns, naming those paths, or of any operation in a sparse
 * checkout whose Git cannot evaluate its patterns; nothing is written. Widening the
 * sparse checkout (`git sparse-checkout add`) lets the same operation run. Paths it
 * does not address keep their files: the checkout runs with the patterns off.
 */
export async function sparseCheckoutRefusal(
  worktree: string,
  paths: readonly string[],
  operation: "delivery" | "revert",
  env: Record<string, string> = {},
): Promise<GitResultRefusal | null> {
  const found = await outsideSparseCheckout(worktree, paths, env);
  if (found === null) {
    const version = await gitObserved(worktree, ["version"], {
      env,
      label: "version",
      allowFailure: true,
    });
    return {
      code: "git_failed",
      message: `this checkout is sparse, and its Git (${version.stdout.trim() || "version unknown"}) cannot evaluate the sparse-checkout patterns: Claudexor asks \`git sparse-checkout check-rules\`, which Git 2.41 added, which of the paths this ${operation} changes are inside them; nothing was written. Use Git 2.41 or newer, or turn the sparse checkout off (git sparse-checkout disable), and try again`,
      paths: [],
      pathCount: 0,
    };
  }
  const outside = [...new Set(found)].sort();
  if (outside.length === 0) return null;
  const what = operation === "delivery" ? "this result changes" : "this revert must change";
  return {
    code: "delivery_outside_sparse_checkout",
    message:
      `${outside.length} path(s) ${what} are outside this checkout's sparse-checkout patterns, so nothing was written; widen the sparse checkout (git sparse-checkout add) to include them and try again: ${outside.slice(0, 20).join(", ")}`.slice(
        0,
        4_000,
      ),
    paths: outside.slice(0, 200),
    pathCount: outside.length,
  };
}
