import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { GitObjectResult, PatchViewUnavailable } from "@claudexor/schema";
import { redactSecrets, writeJson } from "@claudexor/util";
import { materializeSavedFiles, type UnavailableSavedFile } from "@claudexor/workspace";

/** A copy of what an unrendered result saved, for as long as its reader needs it. */
export interface UnrenderedCandidateFiles {
  dir: string;
  /** Paths the result holds that could not be copied, each with the copy's typed
   * fault: named, never read as deleted. */
  unavailable: UnavailableSavedFile[];
  /** The copy failed and holds none of the result's files (each is named): `dir` may
   * be gone, unlistable, or hold what the failed copy could not remove, and no reader
   * reads it. */
  failed: boolean;
  /** Never throws: a copy that cannot be removed stays, with a best-effort record
   * beside it (see `removeCopy`). */
  dispose(): Promise<void>;
}

type UnrenderedRun = {
  result?: GitObjectResult;
  patchViewUnavailable?: PatchViewUnavailable;
  changedPaths?: string[];
  reviewCwd?: string;
};

/**
 * Remove a copy. One that cannot be removed (a busy file, a disk that fails, a
 * directory that cannot be listed) stays where it is, and a best-effort diagnostic,
 * `<dir>.cleanup-error.json`, says why. When that record cannot be written whole
 * either (a full disk), the leftover stays with its cleanup unconfirmed. Neither
 * replaces its reader's answer.
 */
async function removeCopy(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    try {
      writeJson(`${dir}.cleanup-error.json`, {
        saved_copy_cleanup: "failed",
        dir,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    } catch {
      // The record failed too: the copy stays, its cleanup unconfirmed; the answer stands.
    }
  }
}

/**
 * The changed files of a result with no patch view, copied from its saved candidate
 * tree. The workspace is no source: a configured gate has run there since the
 * capture and may have rewritten an output. Null without a saved result (nothing
 * to read); a copy that fails names every changed path it could not provide.
 */
export async function materializeUnrenderedCandidate(
  run: UnrenderedRun,
  dir: string,
  projectRoot: string,
  repo = run.reviewCwd,
): Promise<UnrenderedCandidateFiles | null> {
  if (!run.result || !repo) return null;
  const saved = await materializeSavedFiles({
    repo,
    projectRoot,
    result: run.result,
    changedPaths: run.changedPaths ?? [],
    into: dir,
  });
  return {
    dir,
    unavailable: saved.unavailable,
    // A copy is all or nothing (`SavedFiles`): one that names a file wrote none.
    failed: saved.written.length === 0 && saved.unavailable.length > 0,
    dispose: () => removeCopy(dir),
  };
}

/**
 * Synthesis reads each unrendered candidate from such a copy under the run directory,
 * kept until synthesis ends; other candidates are given as they are.
 */
export async function savedForSynthesis<Run extends UnrenderedRun & { attemptId: string }>(
  runs: readonly Run[],
  runDir: string,
  projectRoot: string,
): Promise<{
  candidates: (Run & { savedFiles?: UnrenderedCandidateFiles | null })[];
  dispose(): Promise<void>;
}> {
  const copies: UnrenderedCandidateFiles[] = [];
  const candidates: (Run & { savedFiles?: UnrenderedCandidateFiles | null })[] = [];
  const dispose = async () => {
    for (const copy of copies.splice(0)) await copy.dispose();
  };
  try {
    for (const run of runs) {
      if (!run.patchViewUnavailable) {
        candidates.push(run);
        continue;
      }
      const savedFiles = await materializeUnrenderedCandidate(
        run,
        join(runDir, "synthesis-saved-files", run.attemptId),
        projectRoot,
      );
      if (savedFiles) copies.push(savedFiles);
      candidates.push({ ...run, savedFiles });
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    candidates,
    dispose: async () => {
      await dispose();
      await removeCopy(join(runDir, "synthesis-saved-files"));
    },
  };
}
