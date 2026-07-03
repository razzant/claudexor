import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Id, ModeKind } from "./primitives.js";

/**
 * The autonomous `orchestrate` brain (A3). It is NOT a privileged harness: it is
 * an intent routed like reviewers (doctor-ok + capability + quota headroom),
 * sticky per thread, overridable. Its tool belt maps 1:1 onto existing engine
 * entry points; it never grows its own business logic.
 *
 * Detailed per-tool input/output schemas are introduced alongside their wiring
 * (staged-field discipline); this module fixes the tool vocabulary + contract.
 */

export const OrchestrateToolName = z.enum([
  "start_run",
  "race",
  "status",
  "answer_question",
  "apply",
  "review",
]);
export type OrchestrateToolName = z.infer<typeof OrchestrateToolName>;

/** How much the brain may act without confirmation. */
export const OrchestrateAutonomy = z.enum(["suggest", "auto_safe", "auto_full"]);
export type OrchestrateAutonomy = z.infer<typeof OrchestrateAutonomy>;

export const DEFAULT_ORCHESTRATE_TOOL_BELT: OrchestrateToolName[] = [
  "start_run",
  "race",
  "status",
  "apply",
  "review",
  // `answer_question` is intentionally NOT offered by default: safe sub-runs are
  // non-interactive, so an autonomously-executed plan has no pending sub-run
  // interaction to answer. It stays in the vocabulary + executor (honest skip) for
  // future interactive sub-runs; a caller can add it to a custom tool_belt.
];

export const OrchestrateContract = z.object({
  thread_id: Id,
  goal: z.string(),
  tool_belt: z.array(OrchestrateToolName).default([...DEFAULT_ORCHESTRATE_TOOL_BELT]),
  budget: z
    .object({
      max_usd: z.number().nonnegative().nullable().default(null),
      max_tool_calls: z.number().int().positive().nullable().default(null),
    })
    .default({}),
  autonomy: OrchestrateAutonomy.default("suggest"),
});
export type OrchestrateContract = z.infer<typeof OrchestrateContract>;

/**
 * Data-driven tool-risk classification. SAFE = provably no live-tree mutation
 * (isolated envelope sub-runs or pure reads); RISKY = mutates the live tree.
 * This is the SSOT the executor classifies against — never a hardcoded
 * enum-in-logic switch. `apply` is the only mutating tool.
 */
export const TOOL_RISK: Record<OrchestrateToolName, "safe" | "risky"> = {
  start_run: "safe",
  race: "safe",
  status: "safe",
  answer_question: "safe",
  review: "safe",
  apply: "risky",
};

/**
 * Classify a tool's risk, FAIL-CLOSED: any unknown/undeclared tool is risky.
 * The executor must never auto-run a tool it cannot prove is safe.
 */
export function toolRisk(tool: string): "safe" | "risky" {
  return (TOOL_RISK as Record<string, "safe" | "risky">)[tool] ?? "risky";
}

/**
 * One concrete tool invocation in a brain plan, with PER-TOOL TYPED args via a
 * discriminated union on `tool`. The executor (auto_safe/auto_full) runs these
 * in order; under `suggest` the user executes them. Args are validated by the
 * variant — never an open `z.record` bag — so a malformed plan fails loudly.
 */
export const OrchestratePlanCall = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("start_run"),
    prompt: z.string().min(1),
    mode: ModeKind.default("agent"),
    harness: z.string().optional(),
    why: z.string().default(""),
  }),
  z.object({
    tool: z.literal("race"),
    prompt: z.string().min(1),
    n: z.number().int().min(2).default(2),
    why: z.string().default(""),
  }),
  z.object({
    tool: z.literal("review"),
    run_id: z.string().min(1),
    why: z.string().default(""),
  }),
  z.object({
    tool: z.literal("status"),
    run_id: z.string().min(1),
    why: z.string().default(""),
  }),
  z.object({
    tool: z.literal("answer_question"),
    interaction_id: z.string().min(1),
    answers: z
      .array(
        z.object({
          question_id: z.string().min(1),
          selected_labels: z.array(z.string()).default([]),
          free_text: z.string().nullable().default(null),
        }),
      )
      .default([]),
    why: z.string().default(""),
  }),
  z.object({
    tool: z.literal("apply"),
    run_id: z.string().min(1),
    mode: z.enum(["apply", "branch", "commit", "pr"]).default("apply"),
    why: z.string().default(""),
  }),
]);
export type OrchestratePlanCall = z.infer<typeof OrchestratePlanCall>;

/**
 * The TYPED orchestration plan extracted from the brain's report (the fenced
 * JSON block the orchestrate prompt requires). Persisted as
 * `final/orchestration.yaml`; a missing/invalid block is disclosed in the
 * summary, never silently dropped.
 */
export const OrchestratePlan = z.object({
  tool_calls: z.array(OrchestratePlanCall).min(1),
});
export type OrchestratePlan = z.infer<typeof OrchestratePlan>;

/** Per-step executor status (auto_safe/auto_full). */
export const OrchestrateStepStatus = z.enum([
  "pending",
  "running",
  "done",
  "skipped",
  "blocked",
  "failed",
]);
export type OrchestrateStepStatus = z.infer<typeof OrchestrateStepStatus>;

/**
 * Typed executor progress over a plan's tool_calls. Persisted as
 * `final/orchestration_progress.yaml` and projected into the run detail so a
 * surface renders honest per-step outcomes (which safe steps ran, where a risky
 * step blocked, why it stopped). Producer: the orchestrator executor; consumer:
 * the control-api run-detail projection.
 */
export const OrchestratePlanProgress = z.object({
  steps: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        tool: OrchestrateToolName,
        risk: z.enum(["safe", "risky"]),
        status: OrchestrateStepStatus,
        /** Sub-run id this step started/targeted (start_run/race/review/status/apply), when known. */
        run_id: z.string().nullable().default(null),
        detail: z.string().nullable().default(null),
      }),
    )
    .default([]),
  autonomy: OrchestrateAutonomy,
  /** Set when the executor stopped early (first risky step under auto_safe, budget, abort). */
  stopped_reason: z.string().nullable().default(null),
});
export type OrchestratePlanProgress = z.infer<typeof OrchestratePlanProgress>;

/**
 * JSON Schema for the brain's typed plan, computed from the LIVE Zod shape
 * (the SSOT) — passed as HarnessRunSpec.output_schema so schema-capable CLIs
 * constrain their final message to a valid OrchestratePlan (D10).
 */
let orchestratePlanJsonSchemaCache: Record<string, unknown> | null = null;
export function orchestratePlanJsonSchema(): Record<string, unknown> {
  orchestratePlanJsonSchemaCache ??= zodToJsonSchema(OrchestratePlan, {
    name: "OrchestratePlan",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  return orchestratePlanJsonSchemaCache;
}
