import { createHash } from "node:crypto";
import {
  GIT_OBJECTS_V1,
  GitObjectResult,
  type GitObjectFormat,
  type GitObjectResult as GitObjectResultValue,
} from "@claudexor/schema";
import { WorkspaceError } from "@claudexor/core";
import { gitObserved } from "./git-observed.js";

/**
 * The canonical descriptor of digest v1 (E). Keys are fixed and sorted, values
 * are lowercase object ids, so equal results always serialize to equal bytes.
 */
export function gitResultDescriptor(input: {
  object_format: GitObjectFormat;
  base_tree: string;
  candidate_tree: string;
}): string {
  return JSON.stringify({
    base_tree_oid: input.base_tree,
    candidate_tree_oid: input.candidate_tree,
    object_format: input.object_format,
    schema: GIT_OBJECTS_V1,
  });
}

export function gitResultDigest(input: {
  object_format: GitObjectFormat;
  base_tree: string;
  candidate_tree: string;
}): string {
  return `sha256:${createHash("sha256").update(gitResultDescriptor(input), "utf8").digest("hex")}`;
}

export function makeGitObjectResult(input: {
  object_format: GitObjectFormat;
  base_tree: string;
  candidate_tree: string;
  base_commit: string | null;
  store_boundary_commit: string | null;
}): GitObjectResultValue {
  return GitObjectResult.parse({
    schema: GIT_OBJECTS_V1,
    ...input,
    digest: gitResultDigest(input),
  });
}

/** A recorded result whose digest does not match its own descriptor is never trusted. */
export function verifiedGitObjectResult(value: unknown): GitObjectResultValue | null {
  const parsed = GitObjectResult.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.digest === gitResultDigest(parsed.data) ? parsed.data : null;
}

export async function repositoryObjectFormat(
  repo: string,
  env?: Record<string, string>,
): Promise<GitObjectFormat> {
  const result = await gitObserved(repo, ["rev-parse", "--show-object-format"], {
    env,
    label: "rev-parse --show-object-format",
    allowFailure: true,
  });
  const format = result.stdout.trim();
  // Git before 2.29 has no --show-object-format and only knows SHA-1.
  if (result.code !== 0 || format === "" || format === "--show-object-format") return "sha1";
  if (format === "sha1" || format === "sha256") return format;
  throw new WorkspaceError(`unsupported Git object format: ${format}`);
}

/** The object format of the repository holding `dir`; null when `dir` is in none. */
export async function repositoryObjectFormatOrNull(dir: string): Promise<GitObjectFormat | null> {
  const inside = await gitObserved(dir, ["rev-parse", "--git-dir"], {
    label: "rev-parse --git-dir",
    allowFailure: true,
  });
  return inside.code === 0 ? repositoryObjectFormat(dir) : null;
}

/** The tree of a commit-ish (or a tree itself), resolved without reading blobs. */
export async function treeOf(
  repo: string,
  rev: string,
  env?: Record<string, string>,
): Promise<string> {
  const result = await gitObserved(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], {
    env,
    label: "rev-parse tree",
    allowFailure: true,
  });
  const tree = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    throw new WorkspaceError(`not a tree-ish: ${rev}`);
  return tree;
}

const SNAPSHOT_SUBJECT = "claudexor: dirty worktree snapshot (incl. untracked)";
const SNAPSHOT_AUTHOR = "Claudexor <noreply@claudexor.local>";

/**
 * The user commit a captured base relies on: a Claudexor dirty snapshot is not
 * referenced by any user ref, so its own closure must enter the project store
 * and its single parent is the boundary; any other commit is its own boundary.
 */
export async function storeBoundaryCommit(
  repo: string,
  commit: string | null,
  env?: Record<string, string>,
): Promise<string | null> {
  if (!commit) return null;
  const shown = await gitObserved(repo, ["cat-file", "commit", commit], {
    env,
    label: "cat-file commit",
    allowFailure: true,
  });
  if (shown.code !== 0) return null;
  const [header = "", ...body] = shown.stdout.split("\n\n");
  const parents = header
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice("parent ".length).trim());
  const author = header.split("\n").find((line) => line.startsWith("author "));
  const snapshot =
    parents.length === 1 &&
    author?.startsWith(`author ${SNAPSHOT_AUTHOR} `) === true &&
    body.join("\n\n").trim() === SNAPSHOT_SUBJECT;
  return snapshot ? parents[0]! : commit;
}
