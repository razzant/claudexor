import { z } from "zod";

/** Why one selected lane did or did not receive a requested capability. */
export const RequestRequirementReason = z.enum([
  "not_requested",
  "effective",
  "manifest_unsupported",
  "web_policy_off",
  "access_profile_incompatible",
  /** No selected lane can enforce the capability natively; the engine's
   * post-diff policy gate is the authoritative enforcement instead. */
  "postdiff_only",
]);
export type RequestRequirementReason = z.infer<typeof RequestRequirementReason>;

/**
 * Preflight truth for one requested capability on one selected harness lane.
 * A lane may remain eligible for the run while a mixed-pool capability is not
 * effective there; consumers must use `effective`, never infer from manifest.
 */
export const RequestRequirementResolution = z
  .object({
    capability: z.enum(["browser", "path_deny"]),
    harness_id: z.string().min(1),
    eligible: z.boolean(),
    requested: z.boolean(),
    effective: z.boolean(),
    reason: RequestRequirementReason,
    evidence_refs: z.array(z.string()).default([]),
  })
  .describe("Preflight resolution of one requested capability on one selected harness lane.");
export type RequestRequirementResolution = z.infer<typeof RequestRequirementResolution>;
