import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  CAPTURE_BUFFER_BUDGET_BYTES,
  CaptureOutputExceeded,
  WorkspaceError,
} from "@claudexor/core";
import type {
  CaptureChangeInventory,
  GitObjectResult,
  PatchViewUnavailable,
} from "@claudexor/schema";
import { changedFileInventory } from "./capture-inventory.js";
import { noteCleanupFault } from "./cleanup-fault.js";
import {
  estimatePatchViewBytes,
  objectDirectoryProgress,
  preflightCaptureSpace,
} from "./capture-objects.js";
import {
  nestedRepositoryExcludes,
  untrackedNestedRepositories,
} from "./git-nested-repositories.js";
import { gitObserved, GitOperationError, proofStallMs, treeBlobBytes } from "./git-observed.js";
import {
  makeGitObjectResult,
  repositoryObjectFormat,
  storeBoundaryCommit,
  treeOf,
} from "./git-result.js";
import { assertNoBinaryStubs, gitEnv, SCRATCH_INDEX_CONFIG } from "./git-run.js";
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from "./object-compose.js";
import {
  assertProjectObjectFormat,
  beginPendingRoots,
  endPendingRoots,
  objectStorePath,
  retainInObjectStore,
  type PendingRoots,
} from "./object-store.js";

/**
 * Capture the current worktree against an exact base as Git objects (#535
 * phase 2). The candidate tree is written through a scratch index into a
 * private scratch object directory (the user's object database and the
 * project store are read-only alternates), then everything it needs beyond its
 * boundary enters the project object store, where it is verified alone. The
 * store is an alternate only under a pending lease: Git writes no object it
 * finds there, so a prune must not delete one meanwhile. The object pair is
 * the canonical result; capture runs no rename detection.
 *
 * A patch is only a VIEW: a render is attempted when an estimate computed from its
 * blob sizes fits today's 256 MiB view limit, and it is absent with a typed reason
 * when that estimate does not fit or the render overflows or fails, while the
 * result stays exact, verifiable, deliverable and revertable.
 */
export interface TransientDiffCapture {
  captureIncomplete: boolean;
  captureFailure?: Error;
  /** The rendered patch view, "" when no view was rendered. */
  patch: string;
  /** Untracked directories holding their own Git repository. A patch cannot
   * carry another repository (Git would record a commit link, or refuse a
   * repository without a commit), so they are left out of the capture and
   * named here instead of failing the whole capture. */
  excludedNestedRepositories?: string[];
  /** The exact candidate as Git objects; absent only for a refused capture. */
  result?: GitObjectResult;
  /** Present when no patch view was rendered (the object result stays exact). */
  patchViewUnavailable?: PatchViewUnavailable;
  /** Bounded listing of the largest changed files of an unrendered result. */
  inventory?: CaptureChangeInventory;
  /** Every changed path of an unrendered result (no view to read them from),
   * and those whose old side existed, from the no-renames raw diff. */
  changedPaths?: string[];
  existingPaths?: string[];
}

export interface TransientCaptureOptions {
  /** Project root owning the object store (the user's repository root). */
  projectRoot?: string;
  /** Render limit of the patch view; today's capture buffer by default. */
  viewLimitBytes?: number;
  /** Path whose existence keeps the result's objects in the store (the run directory). */
  owner?: string;
}

function alternates(paths: string[]): string {
  // Git parses this as a path-list; C-style quoting keeps a legal `:` in a
  // macOS path from becoming a separator (and escapes quotes/backslashes).
  return paths.map((path) => JSON.stringify(path)).join(delimiter);
}

export async function captureWorkingTreeTransient(
  repo: string,
  baseSha: string,
  pathExcludes: string[] = [],
  options: TransientCaptureOptions = {},
): Promise<TransientDiffCapture> {
  const projectRoot = options.projectRoot ?? repo;
  const viewLimit = options.viewLimitBytes ?? CAPTURE_BUFFER_BUDGET_BYTES;
  const scratchDir = mkdtempSync(join(tmpdir(), "claudexor-transient-diff-"));
  const objectDir = join(scratchDir, "objects");
  const indexPath = join(scratchDir, "index");
  mkdirSync(objectDir, { recursive: true, mode: 0o700 });
  let primaryError: unknown;
  // The written candidate tree, for the refusal's own non-exact inventory pass.
  let candidate: { tree: string; env: Record<string, string> } | undefined;
  let lease: PendingRoots | null = null;
  try {
    // One project keeps one object format: refused before anything is written or mounted.
    await assertProjectObjectFormat(projectRoot, await repositoryObjectFormat(repo));
    const actualObjects = await gitObserved(
      repo,
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      { label: "rev-parse objects", allowFailure: true },
    );
    if (actualObjects.code !== 0 || !actualObjects.stdout.trim()) {
      throw new WorkspaceError(
        `transient diff could not resolve Git objects: ${actualObjects.stderr.trim()}`,
      );
    }
    await preflightCaptureSpace(repo, scratchDir, { GIT_OPTIONAL_LOCKS: "0" });
    // The lease comes first: a prune then either finished before or yields until
    // the capture's own custody is recorded. No store yet: nothing to mount.
    const store = objectStorePath(projectRoot);
    if (existsSync(join(store, "objects"))) lease = await beginPendingRoots(store, []);
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates([
        actualObjects.stdout.trim(),
        ...(lease ? [join(store, "objects")] : []),
      ]),
      GIT_OPTIONAL_LOCKS: "0",
    };
    const progress = objectDirectoryProgress(objectDir);
    const read = await gitObserved(repo, [...SCRATCH_INDEX_CONFIG, "read-tree", baseSha], {
      env,
      label: "read-tree (capture base)",
      allowFailure: true,
    });
    if (read.code !== 0) {
      throw new WorkspaceError(`transient diff read-tree failed: ${read.stderr.trim()}`);
    }
    const nested = await untrackedNestedRepositories(
      repo,
      env,
      [".", ...pathExcludes],
      "transient diff",
    );
    await gitObserved(
      repo,
      [
        ...SCRATCH_INDEX_CONFIG,
        "add",
        "-A",
        "--",
        ".",
        ...pathExcludes,
        ...nestedRepositoryExcludes(nested),
      ],
      // A tracked file whose blob the base already holds is re-hashed without a sign
      // (no output, no new object), so the silent read is bounded by the base's bytes.
      {
        env,
        label: "add -A (capture)",
        progress,
        stallMs: proofStallMs(await treeBlobBytes(repo, baseSha, env)),
      },
    );
    const tree = (
      await gitObserved(repo, [...SCRATCH_INDEX_CONFIG, "write-tree"], {
        env,
        label: "write-tree",
        progress,
      })
    ).stdout.trim();
    if (!tree) throw new WorkspaceError("transient diff write-tree returned no tree");
    candidate = { tree, env };
    const baseCommit = (
      await gitObserved(repo, ["rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`], {
        env,
        label: "rev-parse base commit",
        allowFailure: true,
      })
    ).stdout.trim();
    const baseTree = await treeOf(repo, baseSha, env);
    const objectFormat = await repositoryObjectFormat(repo, env);
    const commit = /^[0-9a-f]{40,64}$/.test(baseCommit) ? baseCommit : null;
    const boundaryCommit = await storeBoundaryCommit(repo, commit, env);
    const result = makeGitObjectResult({
      object_format: objectFormat,
      base_tree: baseTree,
      candidate_tree: tree,
      base_commit: commit,
      store_boundary_commit: boundaryCommit,
    });
    const nestedFacts = nested.length ? { excludedNestedRepositories: nested } : {};
    if (baseTree === tree) {
      return { patch: "", captureIncomplete: false, result, ...nestedFacts };
    }
    // Custody: the candidate tree, plus a dirty base snapshot's own closure.
    const roots = [tree, ...(commit && boundaryCommit !== commit ? [commit] : [])];
    await retainInObjectStore({
      projectRoot,
      source: { cwd: repo, env, objectsDir: objectDir },
      roots,
      boundary: boundaryCommit
        ? { commit: boundaryCommit, tree: await treeOf(repo, boundaryCommit, env) }
        : null,
      objectFormat,
      owner: options.owner ?? projectRoot,
    });
    const estimate = await estimatePatchViewBytes(repo, baseSha, tree, env);
    const view =
      estimate.bytes <= viewLimit
        ? await renderPatchView(repo, baseSha, tree, env)
        : ("exceeds_view_limit" as const);
    if (view === "exceeds_view_limit" || view === "render_failed") {
      const inventory = await changedFileInventory(repo, baseSha, tree, env);
      return {
        patch: "",
        captureIncomplete: false,
        result,
        patchViewUnavailable: {
          reason: view,
          limitBytes: viewLimit,
          // A render that overflowed proves more than an estimate that fit; one
          // that failed for another reason proves nothing about its size.
          estimatedBytes:
            view === "render_failed" ? estimate.bytes : Math.max(estimate.bytes, viewLimit + 1),
        },
        ...(inventory ? { inventory } : {}),
        changedPaths: estimate.paths,
        existingPaths: estimate.existingPaths,
        ...nestedFacts,
      };
    }
    return {
      patch: view,
      captureIncomplete: false,
      result,
      ...nestedFacts,
    };
  } catch (error) {
    primaryError = error;
    // Before the scratch goes, a separate bounded pass over the same candidate
    // tree names its largest changed files: diagnostic evidence only.
    if (candidate && error instanceof Error && !Object.isFrozen(error)) {
      const inventory = await changedFileInventory(repo, baseSha, candidate.tree, candidate.env);
      if (inventory) Object.defineProperty(error, "captureInventory", { value: inventory });
    }
    // Typed packaging failures (an overflow of a bounded read, no space, a
    // stalled or signalled Git, a read error, a missing object) are an honest
    // capture refusal; anything else stays a thrown workspace fault.
    if (error instanceof CaptureOutputExceeded || error instanceof GitOperationError)
      return { patch: "", captureIncomplete: true, captureFailure: error };
    throw error;
  } finally {
    // Never throws: a pending record that stays only delays a prune, and the
    // scratch below is still removed under its own terminal rule.
    const leaseFault = endPendingRoots(lease);
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
    // A failed capture's evidence also names a lease record that stayed, unless the
    // scratch fault was recorded first.
    noteCleanupFault(primaryError, leaseFault);
  }
}

/** Today's patch of B..C, rendered under the view limit, else why there is none. A
 * failed render costs only the view (the exact objects are already kept), never
 * the capture: a timeout, a Git failure or a binary stub is a typed absence. */
async function renderPatchView(
  repo: string,
  base: string,
  tree: string,
  env: Record<string, string>,
): Promise<string | "exceeds_view_limit" | "render_failed"> {
  try {
    const diff = await gitEnv(
      repo,
      [...PINNED_DIFF_CONFIG, "diff", "--binary", ...PINNED_DIFF_FLAGS, base, tree],
      env,
    );
    if (diff.code !== 0) return "render_failed";
    assertNoBinaryStubs(diff.stdout, `transient git diff ${base}`);
    return diff.stdout;
  } catch (error) {
    return error instanceof CaptureOutputExceeded ? "exceeds_view_limit" : "render_failed";
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

/** The capture's object-backed facts, carried unchanged to its consumers. */
export function captureObjectFacts(captured: TransientDiffCapture) {
  return {
    ...(captured.result ? { result: captured.result } : {}),
    ...(captured.patchViewUnavailable
      ? { patchViewUnavailable: captured.patchViewUnavailable }
      : {}),
    ...(captured.inventory ? { inventory: captured.inventory } : {}),
    ...(captured.changedPaths ? { changedPaths: captured.changedPaths } : {}),
    ...(captured.existingPaths ? { existingPaths: captured.existingPaths } : {}),
    ...(captured.excludedNestedRepositories
      ? { excludedNestedRepositories: captured.excludedNestedRepositories }
      : {}),
  };
}
