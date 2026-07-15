import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, projectRuntimeDir, sha256 } from "@claudexor/util";
import { WorkspaceError } from "@claudexor/core";
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

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readRevertAnchor(repo: string, id: string): string {
  const patch = readFileSync(objectPath(repo, id), "utf8");
  if (sha256(patch) !== id) throw new WorkspaceError(`revert anchor ${id} is corrupt`);
  return patch;
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
