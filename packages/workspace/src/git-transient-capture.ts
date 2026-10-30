import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureOutputExceeded, WorkspaceError } from "@claudexor/core";
import {
  nestedRepositoryExcludes,
  untrackedNestedRepositories,
} from "./git-nested-repositories.js";
import { assertNoBinaryStubs, git, gitEnv } from "./git-run.js";

/**
 * Capture the current worktree against an exact base without writing its blobs
 * into the user's Git object database. In-place harness output is not yet
 * accepted work; `snapshotTree` would otherwise leave dangling blobs of output
 * the user never adopted.
 *
 * Git still owns filename, mode, symlink, binary, ignored-file, and untracked
 * semantics. A scratch index plus an isolated temporary object directory holds
 * the candidate tree only for the duration of `git diff`; the real object
 * directory is read-only through Git's alternates mechanism.
 */
export interface TransientDiffCapture {
  captureIncomplete: boolean;
  captureFailure?: CaptureOutputExceeded;
  patch: string;
  /** Untracked directories holding their own Git repository. A patch cannot
   * carry another repository (Git would record a commit link, or refuse a
   * repository without a commit), so they are left out of the capture and
   * named here instead of failing the whole capture. */
  excludedNestedRepositories?: string[];
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
    const nested = await untrackedNestedRepositories(
      repo,
      env,
      [".", ...pathExcludes],
      "transient diff",
    );
    const add = await gitEnv(
      repo,
      ["add", "-A", "--", ".", ...pathExcludes, ...nestedRepositoryExcludes(nested)],
      env,
    );
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
    return {
      patch: diff.stdout,
      captureIncomplete: false,
      ...(nested.length ? { excludedNestedRepositories: nested } : {}),
    };
  } catch (error) {
    primaryError = error;
    if (error instanceof CaptureOutputExceeded)
      return { patch: "", captureIncomplete: true, captureFailure: error };
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
          // A frozen typed error cannot accept cleanup evidence. Preserve both
          // through a wrapper, keeping its machine facts and original cause.
          throw Object.assign(
            new WorkspaceError(primaryError.message, { cause: primaryError }),
            primaryError,
            { cleanupError },
          );
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
  const captured = await captureWorkingTreeTransient(repo, baseSha, pathExcludes);
  if (captured.captureIncomplete) throw captured.captureFailure;
  return captured.patch;
}
