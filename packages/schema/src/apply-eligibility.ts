import { z } from "zod";
import { RunOutcomeFacts } from "./decision.js";
import { PlanReadiness, CouncilProjection } from "./plan.js";
import { ControlBudgetSnapshot } from "./control.js";

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

/**
 * The structured result shape MCP run tools return (structuredContent).
 * Text content mirrors it for hosts without structured-output support.
 */
export const McpRunToolResult = z
  .object({
    summary: z
      .string()
      .describe("Human-readable outcome summary (same text as the tool's text content)."),
    runId: z
      .string()
      .nullable()
      .describe(
        "Daemon run id (recovery handle for inspect/follow/apply/decision); null for in-process read-only runs.",
      ),
    runDir: z
      .string()
      .nullable()
      .describe("Artifact directory of the run; null when not persisted."),
    status: z
      .string()
      .nullable()
      .describe("Terminal run LIFECYCLE (succeeded | failed | cancelled | interrupted)."),
    outcomeFacts: RunOutcomeFacts.nullable()
      .default(null)
      .describe(
        "The D8 terminal outcome axes (checks/review/reason/noChanges); null for non-terminal or read-only routes.",
      ),
    applyEligibility: ApplyEligibility.nullable().describe(
      "Apply-gate verdict for mutating runs; null for read-only routes or when no patch exists.",
    ),
    outcomeBanner: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Server-owned outcome headline (D18); the single honest one-line verdict, null while non-terminal or unavailable.",
      ),
    planReadiness: PlanReadiness.nullable()
      .default(null)
      .describe("Derived plan readiness for plan tools (D17); null for non-plan tools."),
    /** Council membership + merge disclosure (QA-023b) so an MCP host can
     * machine-verify a `--council` plan was really N/N and who merged, without
     * reading local artifacts; null for solo/non-plan tools and deferred handles. */
    council: CouncilProjection.nullable()
      .default(null)
      .describe(
        "Council membership + merge disclosure (QA-023b); null for solo/non-plan tools or deferred handles.",
      ),
  })
  .describe("Structured MCP tool result for Claudexor run tools.");
export type McpRunToolResult = z.infer<typeof McpRunToolResult>;

/**
 * The structured result shape the MCP READ tools (claudexor_inspect /
 * claudexor_run_status / claudexor_run_result) return: a durable run handle
 * projected from GET /runs/:id through the SAME axes every surface reads.
 * Strict — the read tools emit exactly these keys so hosts can branch on a
 * declared shape instead of a free-text blob (v3: no legacy extra fields).
 */
export const McpRunHandleResult = z
  .object({
    summary: z
      .string()
      .describe("Human-readable outcome/status text (same as the tool's text content)."),
    runId: z.string().nullable().default(null).describe("The daemon run id, when known."),
    runDir: z.string().nullable().default(null).describe("Artifact directory; null when absent."),
    status: z
      .string()
      .nullable()
      .default(null)
      .describe("The run's terminal or in-flight lifecycle state, when known."),
    decisionStatus: z
      .string()
      .nullable()
      .default(null)
      .describe("The arbitration decision status, when the run reached arbitration."),
    pendingInteractions: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null)
      .describe("Count of questions still awaiting answers, when known."),
    outcomeFacts: RunOutcomeFacts.nullable()
      .default(null)
      .describe("The D8 terminal outcome axes (checks/review/reason/noChanges), when terminal."),
    outcomeBanner: z
      .string()
      .nullable()
      .default(null)
      .describe("Server-owned outcome headline (D18); null while non-terminal."),
    applyEligibility: ApplyEligibility.nullable()
      .default(null)
      .describe("Derived apply-gate verdict; null for read-only runs or when no patch exists."),
    planReadiness: PlanReadiness.nullable()
      .default(null)
      .describe("Derived plan readiness (plan runs only, D17); null otherwise."),
    /** Council membership + merge disclosure (QA-023b), projected from the same
     * GET /runs/:id detail every read surface shares; null for solo/non-plan runs. */
    council: CouncilProjection.nullable()
      .default(null)
      .describe("Council membership + merge disclosure (QA-023b); null for solo/non-plan runs."),
    /** Run budget snapshot (QA-023c) carrying BOTH exact billed cash and the
     * separate subscription valuation, so an MCP host learns a native-subscription
     * run's real resource cost (cash $0 + non-null valuation) without reading
     * local artifacts; null when no budget snapshot is available. */
    budget: ControlBudgetSnapshot.nullable()
      .default(null)
      .describe(
        "Run budget snapshot (cash + subscription valuation, QA-023c); null when unavailable.",
      ),
  })
  .strict()
  .describe("Structured MCP result for Claudexor durable-run read tools (inspect/status/result).");
export type McpRunHandleResult = z.infer<typeof McpRunHandleResult>;
