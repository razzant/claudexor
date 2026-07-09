import { z } from "zod";
import { ContentHash } from "./primitives.js";

/** How a tracked path was accounted for in the Scope Atlas. No path is ever silently dropped. */
export const PathDisposition = z
  .enum([
    "full",
    "included",
    "manifest_only",
    "excluded",
    "sensitive",
    "binary",
    "vendored",
    "oversized",
    "read_error",
    "omitted",
  ])
  .describe(
    "How a tracked path was accounted for in the Scope Atlas (full/included content, manifest_only, or excluded/sensitive/binary/vendored/oversized/read_error/omitted); no path is ever silently dropped.",
  );
export type PathDisposition = z.infer<typeof PathDisposition>;

export const ScopeAtlasEntry = z
  .object({
    path: z.string().describe("Repo-relative path."),
    disposition: PathDisposition,
    hash: ContentHash.optional().describe("Content hash of the path, when read."),
    bytes: z.number().int().nonnegative().optional().describe("Size of the path in bytes, when known."),
    reason: z.string().optional().describe("Why the path got this disposition."),
  })
  .describe("Accounting entry for one tracked path in the Scope Atlas.");
export type ScopeAtlasEntry = z.infer<typeof ScopeAtlasEntry>;

export const OmissionEntry = z
  .object({
    path: z.string().describe("Repo-relative path that was omitted."),
    reason: z.string().describe("Why the path was omitted."),
    replacement: z
      .enum(["summary", "map", "index", "none"])
      .default("none")
      .describe("What stands in for the omitted content: a summary, a map, an index, or nothing."),
    hash: ContentHash.optional().describe("Content hash of the omitted file, when known."),
  })
  .describe("Explicit record of a file omitted from the context; nothing is silently cut.");
export type OmissionEntry = z.infer<typeof OmissionEntry>;

export const ContextFileRef = z
  .object({
    path: z.string().describe("Repo-relative path of the included file."),
    hash: ContentHash.describe("Content hash of the file as included."),
  })
  .describe("Reference to a file included in the context pack.");
export type ContextFileRef = z.infer<typeof ContextFileRef>;

/**
 * The deterministic, hashable bundle every harness receives. Built from the
 * TaskContract + repo state. Omissions are explicit; nothing is silently cut.
 */
export const ContextPack = z
  .object({
    task_contract_hash: ContentHash.describe("Hash of the TaskContract this pack was built from."),
    hash: ContentHash.describe("Content hash of the pack itself."),
    files: z
      .object({
        mandatory: z.array(ContextFileRef).default([]).describe("Files every harness must receive."),
        included: z.array(ContextFileRef).default([]).describe("Additional files included in the pack."),
        omitted: z.array(OmissionEntry).default([]).describe("Files explicitly omitted, with reasons."),
      })
      .describe("Files included in or explicitly omitted from the pack."),
    atlas: z.array(ScopeAtlasEntry).default([]).describe("Scope Atlas: per-path accounting of the whole tracked tree."),
    instructions: z.array(z.string()).default([]).describe("Instruction strings passed alongside the files."),
    token_budget: z
      .object({
        limit: z.number().int().positive().describe("Token budget limit for the pack."),
        estimated_used: z.number().int().nonnegative().describe("Estimated tokens consumed by the pack."),
      })
      .optional()
      .describe("Token budget accounting for the pack, when computed."),
  })
  .describe(
    "The deterministic, hashable context bundle every harness receives, built from the TaskContract plus repo state; omissions are explicit.",
  );
export type ContextPack = z.infer<typeof ContextPack>;
