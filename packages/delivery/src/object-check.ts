import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { GitObjectResult, GitResultRefusal } from "@claudexor/schema";
import {
  beginPendingRoots,
  composeOnTarget,
  endPendingRoots,
  objectStorePath,
  occupiedByWrite,
  pairPaths,
  repositoryEndpoint,
  repositoryObjectFormat,
  revParse,
  stashCreate,
  treeOf,
  unreachableObjects,
  worktreeTopLevel,
  type PendingRoots,
} from "@claudexor/workspace";
import { WorkspaceError } from "@claudexor/core";
import { EMPTY_RESULT_REFUSAL, objectsMissing, storeFaultRefusal } from "./object-custody.js";

/**
 * Dry run of an object delivery (`apply --check` for a result): compose B..C onto
 * the current target in a scratch object directory that reads the user's
 * objects and the project store (under its pending lease), so a check writes
 * nothing into the user's repository and leaves no alternate behind.
 */
export async function checkResultOnTarget(
  repoRoot: string,
  result: GitObjectResult,
  projectRoot = repoRoot,
): Promise<{
  ok: boolean;
  code: number;
  stderr: string;
  alreadyApplied?: boolean;
  refusal?: GitResultRefusal;
}> {
  if (result.base_tree === result.candidate_tree)
    return { ok: false, code: 1, stderr: EMPTY_RESULT_REFUSAL };
  const top = await worktreeTopLevel(repoRoot);
  // Objects of the other format can never enter this repository; its store is not mounted.
  const format = await repositoryObjectFormat(top);
  if (result.object_format !== format) {
    const refusal = objectsMissing([result.base_tree, result.candidate_tree], {
      kept: result.object_format,
      repository: format,
    });
    return { ok: false, code: 1, stderr: refusal.message, refusal };
  }
  const user = await repositoryEndpoint(top);
  // The lease comes first: Git writes no object it finds in a mounted store, so a
  // prune must not delete one meanwhile. No store yet: nothing to mount.
  let lease: PendingRoots | null = null;
  // Made inside the boundary below: a disk too full for the scratch itself is the
  // same typed answer as one that fills later, never a raw throw.
  let scratch: string | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), "claudexor-result-check-"));
    mkdirSync(join(scratch, "objects"), { recursive: true });
    const store = objectStorePath(projectRoot);
    if (existsSync(join(store, "objects"))) lease = await beginPendingRoots(store, []);
    const env = {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_OBJECT_DIRECTORY: join(scratch, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        user.objectsDir,
        ...(lease ? [join(store, "objects")] : []),
      ]
        .map((path) => JSON.stringify(path))
        .join(delimiter),
    };
    const unreachable = await unreachableObjects(
      { cwd: top, env, objectsDir: env.GIT_OBJECT_DIRECTORY },
      [result.base_tree, result.candidate_tree],
    );
    if (unreachable.length > 0) {
      const refusal = objectsMissing(unreachable);
      return { ok: false, code: 1, stderr: refusal.message, refusal };
    }
    // A dirty target's snapshot goes into the scratch, never the user's objects. The
    // paths the result changes are read by content, as the write reads them.
    const exact = await pairPaths(top, result.base_tree, result.candidate_tree, env);
    const snapshot = (await stashCreate(repoRoot, env, exact)) ?? (await revParse(top, "HEAD"));
    const target = await treeOf(top, snapshot, env);
    const composed = await composeOnTarget({
      repo: top,
      base: result.base_tree,
      target,
      candidate: result.candidate_tree,
      env,
    });
    if (!composed.ok)
      return { ok: false, code: 1, stderr: composed.refusal.message, refusal: composed.refusal };
    // What the write itself would refuse, this answers too: the file stays, nothing moves.
    const occupied = await occupiedByWrite(top, target, composed.tree, env);
    if (occupied) return { ok: false, code: 1, stderr: occupied.message, refusal: occupied };
    const already = composed.tree === target;
    return {
      ok: true,
      code: 0,
      stderr: already ? "already applied; idempotent no-op (no files would change)" : "",
      ...(already ? { alreadyApplied: true } : {}),
    };
  } catch (error) {
    // A store, Git or filesystem fault answers the typed refusal the write would
    // (a directory it cannot search, no space, a stalled Git child), not bare text.
    const errno = (error as NodeJS.ErrnoException | null)?.code;
    if (!(error instanceof WorkspaceError) && typeof errno !== "string")
      return { ok: false, code: 1, stderr: error instanceof Error ? error.message : String(error) };
    const refusal = storeFaultRefusal(error, "the check could not run, so nothing was checked");
    return { ok: false, code: 1, stderr: refusal.message, refusal };
  } finally {
    endPendingRoots(lease);
    // Best effort: a scratch that cannot be removed never replaces the answer.
    try {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* left in the OS temp dir */
    }
  }
}
