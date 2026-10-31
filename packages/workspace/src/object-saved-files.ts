import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { GitObjectFormat, GitObjectResult } from "@claudexor/schema";
import { diskProgress, gitObserved, GitOperationError } from "./git-observed.js";
import { SCRATCH_INDEX_CONFIG } from "./git-run.js";
import { parseRawRecords } from "./object-compose.js";
import { gitFaultRefusalCode } from "./object-materialize.js";
import { assertSpaceFor } from "./object-transfer.js";
import {
  beginPendingRoots,
  endPendingRoots,
  objectStorePath,
  repositoryEndpoint,
  type PendingRoots,
} from "./object-store.js";

/** A path the result holds whose content the copy does not hold, and why. */
export interface UnavailableSavedFile {
  path: string;
  /** The copy's typed fault: `space_insufficient` for a full disk, `git_stalled`,
   * `git_signal`, or `git_failed` for any other Git fault. */
  reason: string;
}

/**
 * A copy holds every file the result holds, or, when it fails, none of them: then
 * `written` is empty and `unavailable` names each one. What the failed copy wrote or
 * found in `into` and could not remove may still be there (a partial file, an earlier
 * leftover); it is never the result's content, so no reader of a failed copy reads it.
 */
export interface SavedFiles {
  /** Paths the result holds (not those it deleted), written whole under `into`. */
  written: string[];
  /** Paths the result holds that the copy does not hold, each with the copy's fault. */
  unavailable: UnavailableSavedFile[];
}

/** Nothing outside the result decides a copy's bytes: no system or global configuration
 * or attributes file, and no configuration a caller's environment injects. */
const SAVED_COPY_ENV: Record<string, string | null> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_PARAMETERS: null,
  GIT_CONFIG_COUNT: null,
  GIT_ATTR_SOURCE: null,
  GIT_DIR: null,
  GIT_COMMON_DIR: null,
  GIT_WORK_TREE: null,
  GIT_OBJECT_DIRECTORY: null,
  GIT_INDEX_FILE: null,
};

/** The user's attributes file (`core.attributesFile`, else Git's XDG default) is no source. */
const NO_GLOBAL_ATTRIBUTES = ["-c", "core.attributesFile=/dev/null"];

/**
 * The Git context a copy runs in: a private Git directory under `scratch` with no
 * configuration but what `init` writes for this filesystem and no `info/attributes`,
 * reading the capture's objects (and the store's, while leased) as alternates. The
 * capture's own repository is read for the place of its objects only: its
 * configuration and `info/attributes` change after the capture as a gate pleases.
 */
async function privateCopyContext(
  repo: string,
  scratch: string,
  objectFormat: GitObjectFormat,
  storeObjects: string | null,
): Promise<Record<string, string | null>> {
  const gitDir = join(scratch, "git");
  await gitObserved(
    scratch,
    ["init", "--bare", "--quiet", "--template=", `--object-format=${objectFormat}`, gitDir],
    { env: SAVED_COPY_ENV, label: "init (saved files)" },
  );
  const { objectsDir } = await repositoryEndpoint(repo);
  return {
    ...SAVED_COPY_ENV,
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [objectsDir, ...(storeObjects ? [storeObjects] : [])]
      .map((path) => JSON.stringify(path))
      .join(delimiter),
  };
}

/**
 * Empty `dir` where it is, one entry at a time. The typed fault that ended the copy is
 * the answer, so a fault here (a disk that fails again, a busy file) never replaces
 * it. A directory that cannot be listed is removed whole instead. What still stays is
 * the failed copy's leftover, no file of the result: its readers never read a failed
 * copy, and its owner removes the directory again when done (see `SavedFiles`).
 */
function emptyCopy(dir: string): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* unlistable and unremovable: left for its owner */
    }
    return;
  }
  for (const entry of entries) {
    try {
      rmSync(join(dir, entry), { recursive: true, force: true });
    } catch {
      /* left for its owner */
    }
  }
}

/**
 * Copy the files a saved result changed out of its candidate tree into `into`: what
 * review and synthesis read of a result with no patch view, so they read the bytes
 * apply consumes, not whatever the workspace holds by then (a configured gate may
 * have rewritten an output since the capture). Checkout conversion applies as the
 * result itself defines it and nothing else: the attributes its candidate tree holds
 * (`--attr-source`) with Git's built-in defaults, in a private Git directory
 * ({@link privateCopyContext}), so neither the workspace's `.gitattributes`, its
 * `.git/info/attributes` or `.git/config`, nor the user's global or system
 * configuration and attributes reach the copy, whenever they changed. A filter driver
 * is configuration, which the result does not carry: a file whose attributes name
 * one is copied as its stored blob, as the rendered patch view shows it. Big blobs
 * stream. The store is mounted under a pending lease. A read that fails, a copy that
 * cannot fit (it is not started) and a disk that fills on the way, the copy's own
 * scratch included, are one answer: a failed copy (see {@link SavedFiles}), every file
 * unavailable with that cause, never a thrown run, even when the copy directory then
 * cannot be emptied.
 */
export async function materializeSavedFiles(input: {
  /** A worktree whose Git reads the result's objects (its capture's own). */
  repo: string;
  /** Project root owning the object store. */
  projectRoot: string;
  result: GitObjectResult;
  /** Every path it changed, as recorded at its capture: what stays unavailable when
   * not even its tree can be read. */
  changedPaths: readonly string[];
  into: string;
}): Promise<SavedFiles> {
  const store = objectStorePath(input.projectRoot);
  let scratch: string | null = null;
  let lease: PendingRoots | null = null;
  let written: string[] | null = null;
  try {
    scratch = mkdtempSync(join(tmpdir(), "claudexor-saved-files-"));
    // A copy starts empty: a checkout never overwrites, and an old file is no content.
    rmSync(input.into, { recursive: true, force: true });
    mkdirSync(input.into, { recursive: true, mode: 0o700 });
    if (existsSync(join(store, "objects"))) lease = await beginPendingRoots(store, []);
    const env = await privateCopyContext(
      input.repo,
      scratch,
      input.result.object_format,
      lease ? join(store, "objects") : null,
    );
    const records = parseRawRecords(
      (
        await gitObserved(
          scratch,
          [
            "diff-tree",
            "-r",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            input.result.base_tree,
            input.result.candidate_tree,
          ],
          { env, label: "diff-tree --raw (saved files)" },
        )
      ).stdout,
    ).filter((record) => !/^0+$/.test(record.newMode));
    written = records.map((record) => record.src);
    if (written.length === 0) return { written, unavailable: [] };
    const sizes = await gitObserved(scratch, ["cat-file", "--batch-check=%(objectsize)"], {
      env,
      label: "cat-file --batch-check (saved files)",
      input: `${records.map((record) => record.newOid).join("\n")}\n`,
    });
    assertSpaceFor(
      input.into,
      sizes.stdout
        .split("\n")
        .reduce((sum, line) => sum + (/^\d+$/.test(line) ? Number(line) : 0), 0),
      "the saved-file copy",
    );
    await gitObserved(
      scratch,
      [...SCRATCH_INDEX_CONFIG, "read-tree", input.result.candidate_tree],
      { env, label: "read-tree (saved files)" },
    );
    // Attributes come from the saved tree alone (`--attr-source`), in the private
    // context: whatever the workspace's Git holds since the capture is no source.
    await gitObserved(
      input.into,
      [
        `--work-tree=${input.into}`,
        `--attr-source=${input.result.candidate_tree}`,
        ...NO_GLOBAL_ATTRIBUTES,
        ...SCRATCH_INDEX_CONFIG,
        "checkout-index",
        "-z",
        "--stdin",
      ],
      {
        env,
        label: "checkout-index (saved files)",
        input: `${written.join("\0")}\0`,
        progress: diskProgress(input.into),
      },
    );
    return { written, unavailable: [] };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException | null)?.code;
    if (!(error instanceof GitOperationError) && errno !== "ENOSPC" && errno !== "EDQUOT")
      throw error;
    const reason =
      error instanceof GitOperationError ? gitFaultRefusalCode(error.code) : "space_insufficient";
    // Any of them may be partial: none is offered as the result's content, whatever
    // emptying the copy where it is (a full disk may not give a new directory) leaves.
    emptyCopy(input.into);
    return {
      written: [],
      unavailable: (written ?? [...input.changedPaths]).map((path) => ({ path, reason })),
    };
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
