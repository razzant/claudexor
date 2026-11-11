import { z } from "zod/v3";
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
  mode: z.string().describe("Git object mode in the packet's exact tree."),
  blob_oid: z.string().min(1).describe("Git blob oid in the packet's exact tree."),
  content_hash: ContentHash,
  content: z.string().describe("Complete text content; never truncated."),
});
export type RawContextFile = z.infer<typeof RawContextFile>;

/**
 * How a packet's optional files were sized (#147). Estimates are ceil(UTF-16
 * characters / 4) over the text the model receives: approximate, never a
 * tokenizer count. `model_context_window` sized the whole rendered request
 * (framing + packet + output allowance) to the selected model's known window;
 * `assumed_ceiling` means no window was known, so the fixed selection ceiling
 * bounded the optional file contents and is not a fact about the model.
 */
export const RawContextBudget = z
  .object({
    estimator: z.literal("chars_div_4"),
    basis: z.enum(["model_context_window", "assumed_ceiling"]),
    model: z
      .string()
      .min(1)
      .nullable()
      .describe("Model whose catalog row was consulted; null when the producer reported none."),
    context_window: z.number().int().positive().nullable(),
    output_allowance_tokens: z.number().int().nonnegative().nullable(),
    framing_tokens: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("Estimated tokens of the request outside this packet; null when unmeasured."),
    selection_limit_tokens: z
      .number()
      .int()
      .positive()
      .describe(
        "Limit the optional selection honoured: the packet's share of the window, or the assumed ceiling on file contents.",
      ),
    estimated_packet_tokens: z.number().int().nonnegative(),
    omitted_for_budget: z
      .number()
      .int()
      .nonnegative()
      .describe("Optional files left out to honour selection_limit_tokens (listed in omissions)."),
    mandatory_paths: z
      .array(z.string().min(1))
      .describe("Project mandatory files, each delivered complete in readable_files."),
  })
  .strict()
  .describe("Sizing evidence for a raw context packet; disclosed, never a tokenizer count.");
export type RawContextBudget = z.infer<typeof RawContextBudget>;

const EstimatedTokens = z.number().int().nonnegative();

/**
 * What one raw-api request carried as prepared (#147): the adapter's estimate
 * of the request exactly as rendered, beside the budget its packet was sized
 * under. Stamped on the status event that discloses the sizing just before the
 * POST, so it is no proof the provider received the request; kept per attempt
 * (the last try wins) and projected for the run's final attempt.
 */
export const RawContextReceipt = z
  .object({
    model: z.string().min(1).describe("Model the request named."),
    estimated_request_tokens: EstimatedTokens.describe(
      "Estimated tokens of the whole rendered request (chars/4, plus a fixed figure per image); never a tokenizer count.",
    ),
    budget: RawContextBudget,
  })
  .strict()
  .describe(
    "Estimated size of one raw-api request as prepared just before its POST, and the budget its packet honoured; not proof the provider received it.",
  );
export type RawContextReceipt = z.infer<typeof RawContextReceipt>;

/**
 * Why a raw-api request was not sent: its mandatory content cannot fit the
 * selected model's KNOWN window (`raw_context_exceeds_window`, #147). The
 * figures add up: window < packet + framing + output allowance, where the
 * packet already omits every optional file and the mandatory files are part of
 * it. Every figure is a chars/4 estimate.
 */
export const RawContextShortfall = z
  .object({
    model: z.string().min(1).describe("Model whose window was checked."),
    context_window: z.number().int().positive(),
    packet_tokens: EstimatedTokens.describe(
      "The packet with every optional file omitted: mandatory files, file manifest and metadata.",
    ),
    framing_tokens: EstimatedTokens.describe(
      "The request outside the packet: instructions, user text, patch protocol and attachments.",
    ),
    output_allowance_tokens: EstimatedTokens.describe("Tokens kept free for the answer."),
    mandatory_files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            estimated_tokens: EstimatedTokens.describe(
              "This file's share of packet_tokens: its packet entry with content and evidence.",
            ),
          })
          .strict(),
      )
      .describe("Every mandatory file, largest first."),
  })
  .strict()
  .describe(
    "Typed sizes of a raw-api request refused before sending because its mandatory content exceeds the model's known window.",
  );
export type RawContextShortfall = z.infer<typeof RawContextShortfall>;

export const RawContextPacket = z.object({
  schema_version: z.literal(1),
  packet_hash: ContentHash,
  budget: RawContextBudget.optional(),
  base_commit_sha: z
    .string()
    .min(1)
    .describe("The run's delivery base commit; every round of a run names the same one."),
  base_tree_sha: z
    .string()
    .min(1)
    .describe(
      "The exact tree this request describes and its patch applies to: the delivery base's tree on a first round, afterwards the candidate an earlier round left.",
    ),
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
    .describe("Blob oid in the packet's exact tree, or null only when that tree lacks the path."),
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
  "raw_patch_truncated",
  "raw_patch_apply_failed",
  /* The final request outgrew the KNOWN window its packet was sized for (#147). */
  "raw_context_exceeds_window",
]);
export type RawPatchRefusalCode = z.infer<typeof RawPatchRefusalCode>;
