import { oneShotRuntimeDir, projectRuntimeDir } from "@claudexor/util";

/**
 * The engine-owned namespace a run's state lives in (#503), never derived from
 * the tree that executes it. A real project keeps its own namespace whatever
 * executes (an isolated thread worktree, a delegated caller workspace): run
 * tree, saved patches and envelope scratch stay with the project's identity,
 * history and trust. An explicitly ephemeral root (`scope.ephemeral`) uses the
 * one enumerable one-shot namespace keyed by run id, so a temporary cwd leaves
 * no persistent `projects/<sha256>` namespace of its own for its runs. Lane
 * homes, thread worktrees and root-keyed Git object stores/anchors keep their
 * own owners.
 */
export function runRuntimeRoot(input: { repoRoot: string; ephemeral?: boolean }): string {
  return input.ephemeral === true ? oneShotRuntimeDir() : projectRuntimeDir(input.repoRoot);
}
