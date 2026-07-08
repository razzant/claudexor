import { z } from "zod";

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
    eligible: z.boolean().describe("True when the apply gate would accept this run's patch right now."),
    state: z
      .string()
      .nullable()
      .describe("The gate's state classification (e.g. blocked | ungated | review_not_run | no_op | ok) when known."),
    reason: z.string().nullable().describe("The gate's refusal text when not eligible (null when eligible)."),
    requiredAction: z
      .string()
      .nullable()
      .describe("Honest guidance for what actually unblocks apply (typed operator decision, add gates, re-run, or nothing to apply)."),
  })
  .describe("Derived apply-gate verdict for a run's WorkProduct (single producer in the delivery gate).");
export type ApplyEligibility = z.infer<typeof ApplyEligibility>;

/**
 * The structured result shape MCP run tools return (structuredContent).
 * Text content mirrors it for hosts without structured-output support.
 */
export const McpRunToolResult = z
  .object({
    summary: z.string().describe("Human-readable outcome summary (same text as the tool's text content)."),
    runId: z.string().nullable().describe("Daemon run id (recovery handle for inspect/follow/apply/decision); null for in-process read-only runs."),
    runDir: z.string().nullable().describe("Artifact directory of the run; null when not persisted."),
    status: z.string().nullable().describe("Terminal run status (success | blocked | failed | cancelled | ...)."),
    applyEligibility: ApplyEligibility.nullable().describe("Apply-gate verdict for mutating runs; null for read-only routes or when no patch exists."),
  })
  .describe("Structured MCP tool result for Claudexor run tools.");
export type McpRunToolResult = z.infer<typeof McpRunToolResult>;
