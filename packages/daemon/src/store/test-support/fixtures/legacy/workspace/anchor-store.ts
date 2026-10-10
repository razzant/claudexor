import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, fsyncDirectory, projectRuntimeDir, sha256 } from "../util/index.js";
import { WorkspaceError } from "../core/index.js";
import { diffTrees } from "./git.js";

const ANCHOR_ID = /^sha256:[0-9a-f]{64}$/;

function objectPath(repo: string, id: string): string {
  if (!ANCHOR_ID.test(id)) throw new WorkspaceError("invalid revert anchor id");
  return join(projectRuntimeDir(repo), "anchors", "objects", `${id.slice(7)}.patch`);
}

/** Persist a binary/mode-aware turn patch outside Git before its dangling
 * snapshot commits can be collected. The patch digest is the immutable ID. */
export async function createRevertAnchor(
  repo: string,
  preTurnSha: string,
  postTurnSha: string,
): Promise<string> {
  const patch = await diffTrees(repo, preTurnSha, postTurnSha);
  return persistRevertAnchor(repo, patch);
}

/** Persist the exact canonical patch written by a protected delivery. */
function createRevertAnchorFromPatch(repo: string, patch: string): string {
  return persistRevertAnchor(repo, patch);
}

export function createRevertAnchorFromPatchOrNull(repo: string, patch: string): string | null {
  try {
    return createRevertAnchorFromPatch(repo, patch);
  } catch {
    return null;
  }
}

function persistRevertAnchor(repo: string, patch: string): string {
  const id = sha256(patch);
  const target = objectPath(repo, id);
  const targetDir = dirname(target);
  ensureDir(targetDir);
  if (existsSync(target)) {
    if (sha256(readFileSync(target, "utf8")) !== id) {
      throw new WorkspaceError(`revert anchor ${id} failed its content digest`);
    }
    fsyncDirectory(targetDir);
    return id;
  }
  const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, patch, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, target);
    fsyncDirectory(targetDir);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The original rename error is authoritative.
    }
    throw error;
  }
  return id;
}

export function readRevertAnchor(repo: string, id: string): string {
  const patch = readFileSync(objectPath(repo, id), "utf8");
  if (sha256(patch) !== id) throw new WorkspaceError(`revert anchor ${id} is corrupt`);
  return patch;
}

/** The typed refusal every consumer of a saved patch shares when the saved
 * copy is display-only and its exact bytes cannot be produced (INV-062). */
export const PATCH_EXACT_BYTES_UNAVAILABLE = "patch_exact_bytes_unavailable";

export type ExactPatchResolution =
  { ok: true; patch: string; fromExactObject: boolean } | { ok: false; detail: string };

/**
 * Resolve the EXACT patch bytes behind a run's saved `final/patch.diff`.
 *
 * A saved copy is byte-exact unless the work product says
 * `persisted_patch: redacted` — then secret-like strings were hidden in it and
 * it is display-only. Apply, apply/check, the operator-decision binding and
 * eligibility must read the private exact patch object instead (same private
 * store and digest identity as a revert anchor: id === `patch_sha256`). A
 * missing, unrecorded or corrupt object is a typed refusal; the redacted copy
 * is never offered in its place.
 */
export function resolveExactPatch(input: {
  savedCopy: string;
  meta: Record<string, unknown> | null | undefined;
  roots: readonly (string | null | undefined)[];
}): ExactPatchResolution {
  if (input.meta?.["persisted_patch"] !== "redacted")
    return { ok: true, patch: input.savedCopy, fromExactObject: false };
  const id = input.meta["exact_patch_object"];
  if (typeof id !== "string" || id !== input.meta["patch_sha256"])
    return {
      ok: false,
      detail:
        "the saved patch copy hides secret-like strings and no exact patch object was recorded for this run",
    };
  for (const root of input.roots) {
    if (!root) continue;
    try {
      return { ok: true, patch: readRevertAnchor(root, id), fromExactObject: true };
    } catch {
      // Try the next recorded root; absence everywhere is the typed refusal below.
    }
  }
  return {
    ok: false,
    detail:
      "the saved patch copy hides secret-like strings and its exact patch object is missing or corrupt",
  };
}

/** Revert is an optional recovery affordance; never advertise it until the
 * immutable anchor has finalized successfully. */
export async function createRevertAnchorOrNull(
  repo: string,
  preTurnSha: string | null,
  postTurnSha: string | null,
): Promise<string | null> {
  if (!preTurnSha || !postTurnSha) return null;
  try {
    return await createRevertAnchor(repo, preTurnSha, postTurnSha);
  } catch {
    return null;
  }
}
