import { z } from "zod/v3";

/**
 * ApplyEligibility — the derived "can this run's WorkProduct be applied RIGHT
 * NOW, and if not, what unblocks it" verdict. ONE producer (the delivery
 * gate's deriveApplyEligibility over validateApplyGate + the apply hint);
 * projected on GET /runs/:id, MCP structured results, and CLI --json output
 * so every surface answers identically instead of re-implying eligibility
 * from raw state fields.
 */
export const ApplyEligibility = z
  .object({
    eligible: z
      .boolean()
      .describe("True when the apply gate would accept this run's patch right now."),
    state: z
      .string()
      .nullable()
      .describe(
        "The gate's apply-eligibility classification (e.g. needs_review | not_verified | no_changes | ok) when known.",
      ),
    reason: z
      .string()
      .nullable()
      .describe("The gate's refusal text when not eligible (null when eligible)."),
    requiredAction: z
      .string()
      .nullable()
      .describe(
        "Honest guidance for what actually unblocks apply (typed operator decision, add gates, re-run, or nothing to apply).",
      ),
  })
  .describe(
    "Derived apply-gate verdict for a run's WorkProduct (single producer in the delivery gate).",
  );
export type ApplyEligibility = z.infer<typeof ApplyEligibility>;
