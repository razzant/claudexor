import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  fsyncDirectory,
  projectRuntimeDir,
  sha256,
  writePatchObject,
  readFileUtf8BoundedSync,
} from "@claudexor/util";
import { WorkspaceError } from "@claudexor/core";
import { GIT_OBJECTS_V1, GitDeliveryPair } from "@claudexor/schema";
import { repositoryObjectFormat, storeBoundaryCommit, treeOf } from "./git-result.js";
import { repositoryEndpoint, retainInObjectStore } from "./object-store.js";

const ANCHOR_ID = /^sha256:[0-9a-f]{64}$/;

function objectPath(repo: string, id: string): string {
  if (!ANCHOR_ID.test(id)) throw new WorkspaceError("invalid revert anchor id");
  return join(projectRuntimeDir(repo), "anchors", "objects", `${id.slice(7)}.patch`);
}

/** An object revert anchor (#535): the actual pair a delivery or an in-place
 * turn produced. Same id space and directory as patch anchors, so one handle
 * (`revert_anchor_id`) and one retention owner serve both representations. */
function pairPath(repo: string, id: string): string {
  if (!ANCHOR_ID.test(id)) throw new WorkspaceError("invalid revert anchor id");
  return join(projectRuntimeDir(repo), "anchors", "objects", `${id.slice(7)}.pair`);
}

/**
 * Anchor the actual pair (T, M) for revert. Its objects enter the project store
 * owned by the anchor file itself, so they live exactly as long as the anchor
 * (retention prunes anchors by the runs that name them). `repo` is where Git
 * reads the pair; `projectRoot` is the project that keeps it, where retention
 * finds it (a delegated run's or an isolated thread's project).
 */
export async function createPairRevertAnchor(
  repo: string,
  pair: GitDeliveryPair,
  projectRoot = repo,
): Promise<string> {
  const parsed = GitDeliveryPair.parse(pair);
  const text = `${JSON.stringify(parsed)}\n`;
  const id = sha256(text);
  const target = pairPath(projectRoot, id);
  mkdirSync(dirname(target), { recursive: true });
  const created = !existsSync(target);
  if (created) {
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, target);
  }
  try {
    const boundary = await storeBoundaryCommit(repo, parsed.pre_commit);
    await retainInObjectStore({
      projectRoot,
      source: await repositoryEndpoint(repo),
      roots: [parsed.post_tree, parsed.pre_commit],
      boundary: boundary ? { commit: boundary, tree: await treeOf(repo, boundary) } : null,
      objectFormat: parsed.object_format,
      owner: target,
    });
  } catch (error) {
    // An anchor whose objects never entered the store is none: this call's own goes.
    if (created) rmSync(target, { force: true });
    throw error;
  }
  const now = new Date();
  utimesSync(target, now, now);
  return id;
}

export async function createPairRevertAnchorOrNull(
  repo: string,
  pair: GitDeliveryPair | null | undefined,
  projectRoot = repo,
): Promise<string | null> {
  if (!pair) return null;
  try {
    return await createPairRevertAnchor(repo, pair, projectRoot);
  } catch {
    return null;
  }
}

/** The recorded pair of an object anchor; null for a legacy patch anchor. */
export function readRevertPair(projectRoot: string, id: string): GitDeliveryPair | null {
  const path = pairPath(projectRoot, id);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (sha256(text) !== id) throw new WorkspaceError(`revert anchor ${id} is corrupt`);
  return GitDeliveryPair.parse(JSON.parse(text));
}

/** An in-place turn's pair from its pre/post snapshot commits (no patch is rendered). */
export async function createRevertAnchor(
  repo: string,
  preTurnSha: string,
  postTurnSha: string,
  projectRoot = repo,
): Promise<string> {
  return createPairRevertAnchor(
    repo,
    {
      schema: GIT_OBJECTS_V1,
      object_format: await repositoryObjectFormat(repo),
      pre_commit: preTurnSha,
      pre_tree: await treeOf(repo, preTurnSha),
      post_tree: await treeOf(repo, postTurnSha),
    },
    projectRoot,
  );
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
  if (existsSync(target)) {
    if (sha256(readFileSync(target, "utf8")) !== id) {
      throw new WorkspaceError(`revert anchor ${id} failed its content digest`);
    }
    fsyncDirectory(targetDir);
  } else {
    writePatchObject(projectRuntimeDir(repo), target, patch);
  }
  // Every publication renews the run-owned anchor, including a fresh hard link
  // to an old cache inode. Sibling unlink ctime does not extend this age window.
  const now = new Date();
  utimesSync(target, now, now);
  return id;
}

export function readRevertAnchor(repo: string, id: string, maxBytes?: number): string {
  const path = objectPath(repo, id);
  const patch =
    maxBytes === undefined ? readFileSync(path, "utf8") : readFileUtf8BoundedSync(path, maxBytes);
  if (sha256(patch) !== id) throw new WorkspaceError(`revert anchor ${id} is corrupt`);
  return patch;
}

/** The typed refusal every consumer of a saved patch shares when a historical
 * saved copy is display-only and its exact bytes cannot be produced. */
export const PATCH_EXACT_BYTES_UNAVAILABLE = "patch_exact_bytes_unavailable";

export type ExactPatchResolution =
  { ok: true; patch: string; fromExactObject: boolean } | { ok: false; detail: string };

/**
 * Resolve the EXACT patch bytes behind a run's saved `final/patch.diff`.
 *
 * A saved copy is byte-exact. Only historical runs whose work product says
 * `persisted_patch: redacted` saved a copy with secret-like strings hidden; it
 * is display-only. Apply, apply/check, the operator-decision binding and
 * eligibility must read the private exact patch object instead (same private
 * store and digest identity as a revert anchor: id === `patch_sha256`). A
 * missing, unrecorded or corrupt object is a typed refusal; the redacted copy
 * is never offered in its place.
 */
export function resolveExactPatch(input: {
  savedCopy: string;
  meta: Record<string, unknown> | null | undefined;
  roots: readonly (string | null | undefined)[];
  maxBytes?: number;
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
      return { ok: true, patch: readRevertAnchor(root, id, input.maxBytes), fromExactObject: true };
    } catch (error) {
      if ((error as { code?: string }).code?.startsWith("artifact_read_")) throw error;
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
  projectRoot = repo,
): Promise<string | null> {
  if (!preTurnSha || !postTurnSha) return null;
  try {
    return await createRevertAnchor(repo, preTurnSha, postTurnSha, projectRoot);
  } catch {
    return null;
  }
}
