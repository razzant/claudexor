import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedDiff, runCaptureRaw, WorkspaceError } from "../core/index.js";
import { diffTrees, git, statusPorcelain } from "./git.js";

/** Why a revert was refused, decided by the producer rather than by parsing a
 * human message downstream. */
export type RevertRefusalReason = "postimage_diverged" | "reverse_apply_failed";

export interface RevertResult {
  reverted: boolean;
  /** Turn-added files removed to restore the pre-turn state (`.claudexor` preserved). */
  removed: string[];
  reason?: string;
  /** Typed refusal class set at the point of failure; absent on success. */
  reasonCode?: RevertRefusalReason;
  /** Scratch cleanup failed after the primary rollback result was known. */
  cleanupError?: string;
}

export interface RevertPatchOptions {
  /** Keep any object writes performed internally by `git apply` out of the
   * user's repository. Required when the patch itself failed the secret fence. */
  isolateObjectWrites?: boolean;
  /** Apply a git-style patch in a directory with no repository metadata. */
  noIndex?: boolean;
}

async function gitEnv(
  repo: string,
  args: string[],
  env: Record<string, string>,
  input?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await runCaptureRaw("git", ["-C", repo, ...args], {
    timeoutMs: 60_000,
    env,
    input,
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** Restore the live tree to a pre-turn snapshot only while the exact recorded
 * postimage still matches. */
export async function revertWorkingTreeTo(
  repo: string,
  preTurnSha: string,
  expectedPostSha: string,
): Promise<RevertResult> {
  const patch = await diffTrees(repo, preTurnSha, expectedPostSha);
  return revertWorkingTreePatch(repo, patch);
}

/** Reverse an immutable turn patch. Secret-refused callers isolate the object
 * directory because `git apply` may materialize postimage blobs internally. */
export async function revertWorkingTreePatch(
  repo: string,
  patch: string,
  options: RevertPatchOptions = {},
): Promise<RevertResult> {
  if (!patch.trim()) return { reverted: true, removed: [] };
  const removed = parseUnifiedDiff(patch)
    .files.filter((file) => file.added && file.newPath)
    .map((file) => file.newPath as string);
  let scratchDir: string | null = null;
  let isolatedEnv: Record<string, string> | null = null;
  let primaryError: unknown;
  let primaryResult: RevertResult | undefined;
  try {
    if (options.isolateObjectWrites) {
      scratchDir = mkdtempSync(join(tmpdir(), "claudexor-transient-revert-"));
      const objectDir = join(scratchDir, "objects");
      mkdirSync(objectDir, { recursive: true, mode: 0o700 });
      const actualObjects = await git(repo, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]);
      if (actualObjects.code !== 0 || !actualObjects.stdout.trim()) {
        throw new WorkspaceError(
          `transient revert could not resolve Git objects: ${actualObjects.stderr.trim()}`,
        );
      }
      isolatedEnv = {
        GIT_OBJECT_DIRECTORY: objectDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(actualObjects.stdout.trim()),
        GIT_OPTIONAL_LOCKS: "0",
      };
    }
    const runApply = (args: string[], input: string) =>
      isolatedEnv ? gitEnv(repo, args, isolatedEnv, input) : git(repo, args, input);
    const mode = options.noIndex ? ["--no-index"] : [];
    const check = await runApply(
      ["apply", ...mode, "--check", "--reverse", "--whitespace=nowarn", "-"],
      patch,
    );
    if (check.code !== 0) {
      primaryResult = {
        reverted: false,
        removed: [],
        reason: options.noIndex
          ? `exact no-index reverse check failed; candidate output could not be proven reversible: ${check.stderr.trim()}`
          : `turn-owned postimage no longer matches; refusing to overwrite later user edits: ${check.stderr.trim()}`,
        reasonCode: options.noIndex ? "reverse_apply_failed" : "postimage_diverged",
      };
      return primaryResult;
    }
    const before = options.noIndex ? null : await statusPorcelain(repo);
    const apply = await runApply(
      ["apply", ...mode, "--reverse", "--whitespace=nowarn", "-"],
      patch,
    );
    if (apply.code !== 0) {
      const after = options.noIndex ? null : await statusPorcelain(repo);
      primaryResult = {
        reverted: false,
        removed: [],
        reason:
          `reverse apply failed after preflight: ${apply.stderr.trim()}; ` +
          (before !== null && after === before
            ? "tree remains at the observed pre-revert state"
            : "target changed during revert; no destructive rollback was attempted"),
        reasonCode: "reverse_apply_failed",
      };
      return primaryResult;
    }
    primaryResult = { reverted: true, removed };
    return primaryResult;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (scratchDir) {
      try {
        rmSync(scratchDir, { recursive: true, force: true });
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (primaryResult?.reverted === false) {
          primaryResult.cleanupError = message;
        } else if (primaryResult?.reverted === true) {
          const terminal = new WorkspaceError("transient revert scratch cleanup failed", {
            cause: cleanupError,
          });
          Object.defineProperties(terminal, {
            cleanupError: { value: cleanupError, enumerable: false },
            rollbackReverted: { value: true, enumerable: false },
          });
          throw terminal;
        } else if (primaryError instanceof Error) {
          try {
            Object.defineProperty(primaryError, "cleanupError", {
              value: cleanupError,
              enumerable: false,
            });
          } catch {
            // A frozen typed error still remains the primary failure.
          }
        } else {
          throw cleanupError;
        }
      }
    }
  }
}
