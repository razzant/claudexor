import { z } from "zod";
import { ContentHash } from "./primitives.js";
import { OmissionEntry, ScopeAtlasEntry } from "./context.js";

export const ImplementationTransport = z
  .enum(["workspace", "git_patch_envelope"])
  .describe(
    "How an implementing harness returns changes: direct isolated-workspace edits or a typed Git patch envelope.",
  );
export type ImplementationTransport = z.infer<typeof ImplementationTransport>;

export const RawContextFile = z.object({
  path: z.string().min(1).describe("Exact repo-relative readable/editable path."),
  mode: z.string().describe("Git object mode at the bound base tree."),
  blob_oid: z.string().min(1).describe("Git blob oid at the bound base tree."),
  content_hash: ContentHash,
  content: z.string().describe("Complete text content; never truncated."),
});
export type RawContextFile = z.infer<typeof RawContextFile>;

export const RawContextPacket = z.object({
  schema_version: z.literal(1),
  packet_hash: ContentHash,
  base_commit_sha: z.string().min(1),
  base_tree_sha: z.string().min(1),
  readable_files: z.array(RawContextFile),
  editable_paths: z.array(z.string().min(1)),
  creatable_roots: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Exact repo-relative roots where a patch may add a new path; '.' means the project root.",
    ),
  file_manifest: z.array(ScopeAtlasEntry),
  omissions: z.array(OmissionEntry),
  evidence_refs: z.array(z.string().min(1)),
});
export type RawContextPacket = z.infer<typeof RawContextPacket>;

export const RawPatchPathEvidence = z.object({
  path: z.string().min(1),
  expected_blob_oid: z
    .string()
    .min(1)
    .nullable()
    .describe("Base-tree blob oid, or null only when the path is absent in the base tree."),
});
export type RawPatchPathEvidence = z.infer<typeof RawPatchPathEvidence>;

export const RawGitPatchEnvelope = z.object({
  schema_version: z.literal(1),
  context_packet_hash: ContentHash,
  base_tree_sha: z.string().min(1),
  patch: z.string().min(1),
  patch_hash: ContentHash,
  touched_paths: z.array(RawPatchPathEvidence).min(1),
});
export type RawGitPatchEnvelope = z.infer<typeof RawGitPatchEnvelope>;

export const RawPatchRefusalCode = z.enum([
  "raw_patch_requires_isolation",
  "raw_patch_missing_evidence",
  "raw_patch_digest_mismatch",
  "raw_patch_base_mismatch",
  "raw_patch_path_traversal",
  "raw_patch_outside_scope",
  "raw_patch_stale_preimage",
  "raw_patch_binary_unsupported",
  "raw_patch_sensitive_content",
  "raw_patch_truncated",
  "raw_patch_apply_failed",
]);
export type RawPatchRefusalCode = z.infer<typeof RawPatchRefusalCode>;
