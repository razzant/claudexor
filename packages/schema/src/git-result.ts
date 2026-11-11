import { z } from "zod/v3";

/** The one schema id of an object-backed Git result (canonical identity v1). */
export const GIT_OBJECTS_V1 = "git_objects/v1";

const ObjectId = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .describe("Full lowercase Git object id in the repository's object format.");

export const GitObjectFormat = z
  .enum(["sha1", "sha256"])
  .describe("Object format of the repository whose objects the result names.");
export type GitObjectFormat = z.infer<typeof GitObjectFormat>;

/**
 * The canonical result of a Git capture: Git objects, never a patch string.
 * `digest` is sha256 over the canonical descriptor {schema, object_format,
 * base_tree_oid, candidate_tree_oid}; decisions, accept_risk and gates bind to
 * it. Its strength equals the repository's object format (disclosed). A patch is
 * only a derived view of this pair.
 */
export const GitObjectResult = z
  .object({
    schema: z.literal(GIT_OBJECTS_V1),
    object_format: GitObjectFormat,
    base_tree: ObjectId.describe("Tree the result is relative to (the capture base B)."),
    candidate_tree: ObjectId.describe("Tree the executor produced (the candidate C)."),
    base_commit: ObjectId.nullable().describe(
      "Commit the capture base came from (a Claudexor dirty snapshot or a user commit); null when unknown.",
    ),
    store_boundary_commit: ObjectId.nullable().describe(
      "User commit whose objects the result relies on the user repository for; the project store keeps everything beyond it.",
    ),
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .describe("Typed result digest v1 (sha256 of the canonical descriptor)."),
  })
  .describe("Object-backed Git result: the exact candidate as Git objects.");
export type GitObjectResult = z.infer<typeof GitObjectResult>;

/**
 * The actual pair one object delivery produced: the target snapshot it started
 * from (T) and the tree it delivered (M). Revert runs on this pair, never on a
 * re-derived patch, so later target changes outside it survive.
 */
export const GitDeliveryPair = z
  .object({
    schema: z.literal(GIT_OBJECTS_V1),
    object_format: GitObjectFormat,
    pre_commit: ObjectId.describe("Target snapshot commit (T) the delivery started from."),
    pre_tree: ObjectId.describe("Tree of T."),
    post_tree: ObjectId.describe("Tree the delivery wrote (M)."),
  })
  .describe("Pre/post trees of one object delivery, used for revert.");
export type GitDeliveryPair = z.infer<typeof GitDeliveryPair>;

/** Typed reasons an object delivery, revert or ref write refuses before writing. */
export const GitResultRefusalCode = z.enum([
  "result_objects_missing",
  "delivery_conflict",
  "delivery_pairing_mismatch",
  "delivery_target_changed",
  "delivery_path_occupied",
  "delivery_outside_sparse_checkout",
  "delivery_content_mismatch",
  "revert_conflict",
  "revert_target_changed",
  "pr_unrendered_result",
  "result_path_encoding",
  "space_insufficient",
  "git_stalled",
  "git_signal",
  "git_failed",
]);
export type GitResultRefusalCode = z.infer<typeof GitResultRefusalCode>;

export const GitResultRefusal = z
  .object({
    code: GitResultRefusalCode,
    message: z.string(),
    paths: z.array(z.string()).max(200).default([]),
    pathCount: z.number().int().nonnegative().default(0),
  })
  .describe("Typed refusal of an object delivery/revert, with the paths it concerns (bounded).");
export type GitResultRefusal = z.infer<typeof GitResultRefusal>;

/** Why a rendered patch view is absent for an object result (F). */
export const PatchViewUnavailable = z
  .object({
    reason: z.enum(["exceeds_view_limit", "render_failed"]),
    limitBytes: z.number().int().nonnegative(),
    estimatedBytes: z.number().int().nonnegative().nullable(),
  })
  .describe(
    "Typed absence of the rendered patch view; the object result stays exact and applyable.",
  );
export type PatchViewUnavailable = z.infer<typeof PatchViewUnavailable>;
