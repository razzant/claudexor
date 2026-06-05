import { z } from "zod";
import { ContentHash } from "./primitives.js";

/** How a tracked path was accounted for in the Scope Atlas. No path is ever silently dropped. */
export const PathDisposition = z.enum([
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
]);
export type PathDisposition = z.infer<typeof PathDisposition>;

export const ScopeAtlasEntry = z.object({
  path: z.string(),
  disposition: PathDisposition,
  hash: ContentHash.optional(),
  bytes: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
export type ScopeAtlasEntry = z.infer<typeof ScopeAtlasEntry>;

export const OmissionEntry = z.object({
  path: z.string(),
  reason: z.string(),
  replacement: z.enum(["summary", "map", "index", "none"]).default("none"),
  hash: ContentHash.optional(),
});
export type OmissionEntry = z.infer<typeof OmissionEntry>;

export const ContextFileRef = z.object({
  path: z.string(),
  hash: ContentHash,
});
export type ContextFileRef = z.infer<typeof ContextFileRef>;

/**
 * The deterministic, hashable bundle every harness receives. Built from the
 * TaskContract + repo state. Omissions are explicit; nothing is silently cut.
 */
export const ContextPack = z.object({
  task_contract_hash: ContentHash,
  hash: ContentHash,
  files: z.object({
    mandatory: z.array(ContextFileRef).default([]),
    included: z.array(ContextFileRef).default([]),
    omitted: z.array(OmissionEntry).default([]),
  }),
  atlas: z.array(ScopeAtlasEntry).default([]),
  instructions: z.array(z.string()).default([]),
  token_budget: z
    .object({
      limit: z.number().int().positive(),
      estimated_used: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ContextPack = z.infer<typeof ContextPack>;
