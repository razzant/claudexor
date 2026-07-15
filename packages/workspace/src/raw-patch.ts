import { isAbsolute, resolve } from "node:path";
import { parseUnifiedDiff } from "@claudexor/core";
import type {
  HarnessEvent,
  RawContextPacket,
  RawGitPatchEnvelope,
  RawPatchRefusalCode,
} from "@claudexor/schema";
import { sensitiveResourcePolicy, sha256 } from "@claudexor/util";
import { applyPatchProtected, materializePatchTree, revParse } from "./git.js";

export class RawPatchRefusalError extends Error {
  constructor(
    public readonly code: RawPatchRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "RawPatchRefusalError";
  }
}

function refuse(code: RawPatchRefusalCode, detail: string): never {
  throw new RawPatchRefusalError(code, `${code}: ${detail}`);
}

function validatePath(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "" || part === ".")
  ) {
    refuse("raw_patch_path_traversal", `invalid repo-relative path ${JSON.stringify(path)}`);
  }
}

function rootAllows(path: string, root: string): boolean {
  if (root === ".") return true;
  validatePath(root);
  return path === root || path.startsWith(`${root}/`);
}

export function captureRawPatchEnvelope(
  enabled: boolean,
  previous: RawGitPatchEnvelope | null,
  event: HarnessEvent,
): RawGitPatchEnvelope | null {
  if (event.type !== "patch_produced") return previous;
  if (!enabled || !event.patch_envelope || previous)
    refuse("raw_patch_missing_evidence", "expected exactly one enabled patch envelope");
  return event.patch_envelope;
}

/** Validate and materialize a raw patch only inside its isolated candidate tree. */
export async function consumeRawPatchEnvelope(input: {
  repoRoot: string;
  worktreePath: string;
  baseCommitSha: string;
  context: RawContextPacket | null;
  envelope: RawGitPatchEnvelope | null;
}): Promise<{ materializedTreeSha: string }> {
  const { repoRoot, worktreePath, baseCommitSha, context, envelope } = input;
  if (!context || !envelope)
    refuse("raw_patch_missing_evidence", "raw producer returned no patch envelope");
  if (resolve(repoRoot) === resolve(worktreePath)) {
    refuse("raw_patch_requires_isolation", "raw patches cannot materialize in the live tree");
  }
  if (envelope.context_packet_hash !== context.packet_hash) {
    refuse("raw_patch_missing_evidence", "response does not bind the supplied context packet");
  }
  const actualBaseTree = await revParse(repoRoot, `${baseCommitSha}^{tree}`);
  if (
    context.base_commit_sha !== baseCommitSha ||
    context.base_tree_sha !== actualBaseTree ||
    envelope.base_tree_sha !== actualBaseTree
  ) {
    refuse("raw_patch_base_mismatch", "patch and context do not bind the candidate base tree");
  }
  if (sha256(envelope.patch) !== envelope.patch_hash) {
    refuse("raw_patch_digest_mismatch", "patch_hash does not match the exact patch bytes");
  }

  const parsed = parseUnifiedDiff(envelope.patch);
  if (parsed.files.length === 0) refuse("raw_patch_truncated", "patch has no complete file record");
  if (parsed.files.some((file) => file.binary)) {
    refuse("raw_patch_binary_unsupported", "binary patch payloads are not accepted by raw API");
  }
  const actualPaths = new Set<string>();
  const expectedPresence = new Map<string, "present" | "absent">();
  for (const file of parsed.files) {
    if (file.oldPath) {
      validatePath(file.oldPath);
      actualPaths.add(file.oldPath);
      expectedPresence.set(file.oldPath, "present");
    }
    if (file.newPath) {
      validatePath(file.newPath);
      actualPaths.add(file.newPath);
      const expected = file.oldPath === file.newPath ? "present" : "absent";
      const prior = expectedPresence.get(file.newPath);
      if (prior && prior !== expected) {
        refuse(
          "raw_patch_missing_evidence",
          `conflicting base-tree operations for ${file.newPath}`,
        );
      }
      expectedPresence.set(file.newPath, expected);
    }
  }

  const editable = new Map(context.readable_files.map((file) => [file.path, file]));
  const declared = new Map<string, string | null>();
  for (const item of envelope.touched_paths) {
    validatePath(item.path);
    if (declared.has(item.path)) {
      refuse("raw_patch_missing_evidence", `duplicate evidence for ${item.path}`);
    }
    declared.set(item.path, item.expected_blob_oid);
  }
  for (const path of actualPaths) {
    if (sensitiveResourcePolicy.classifyPath(path).sensitive) {
      refuse("raw_patch_outside_scope", `${path} is outside the packet's exact editable scope`);
    }
    const presence = expectedPresence.get(path);
    const file = editable.get(path);
    const expected = declared.get(path);
    if (expected === undefined || !presence) {
      refuse("raw_patch_missing_evidence", `missing preimage evidence for ${path}`);
    }
    if (presence === "present") {
      if (!context.editable_paths.includes(path) || !file) {
        refuse("raw_patch_outside_scope", `${path} is outside the packet's exact editable scope`);
      }
      if (file.blob_oid !== expected) {
        refuse("raw_patch_stale_preimage", `preimage oid for ${path} does not match the packet`);
      }
      continue;
    }
    if (!context.creatable_roots.some((root) => rootAllows(path, root))) {
      refuse("raw_patch_outside_scope", `${path} is outside the packet's exact create scope`);
    }
    if (file || expected !== null) {
      refuse("raw_patch_stale_preimage", `preimage oid for ${path} does not match the packet`);
    }
  }
  if (
    declared.size !== actualPaths.size ||
    [...declared].some(([path]) => !actualPaths.has(path))
  ) {
    refuse("raw_patch_missing_evidence", "declared touched paths differ from the Git patch");
  }

  let materializedTreeSha: string;
  try {
    materializedTreeSha = await materializePatchTree(repoRoot, baseCommitSha, envelope.patch);
  } catch (error) {
    refuse("raw_patch_apply_failed", error instanceof Error ? error.message : String(error));
  }
  const applied = await applyPatchProtected(worktreePath, envelope.patch);
  if (!applied.ok) refuse("raw_patch_apply_failed", applied.detail ?? "git apply refused");
  return { materializedTreeSha };
}
