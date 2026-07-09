import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Id, ModeKind } from "./primitives.js";

/**
 * The autonomous `orchestrate` planner. It is NOT a privileged harness: it is
 * an intent routed like reviewers (doctor-ok + capability + quota headroom),
 * sticky per thread, overridable. Its tool belt maps 1:1 onto existing engine
 * entry points; it never grows its own business logic.
 *
 * Detailed per-tool input/output schemas are introduced alongside their wiring
 * (staged-field discipline); this module fixes the tool vocabulary + contract.
 */

export const OrchestrateToolName = z
  .enum(["start_run", "race", "status", "answer_question", "apply", "review"])
  .describe(
    "Tool in the orchestrate planner's belt, mapping 1:1 onto engine entry points: start_run, race (best-of-N), status, answer_question, apply, and review.",
  );
export type OrchestrateToolName = z.infer<typeof OrchestrateToolName>;

/** How much the planner may act without confirmation. */
export const OrchestrateAutonomy = z
  .enum(["suggest", "auto_safe", "auto_full"])
  .describe(
    "How much the orchestrate planner may act without confirmation: suggest (user executes the plan), auto_safe (auto-runs only provably safe steps), auto_full (auto-runs everything).",
  );
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

export const OrchestrateContract = z
  .object({
    thread_id: Id.describe("Thread the orchestration belongs to."),
    goal: z.string().describe("The user goal the planner is orchestrating toward."),
    tool_belt: z
      .array(OrchestrateToolName)
      .default([...DEFAULT_ORCHESTRATE_TOOL_BELT])
      .describe("Tools the planner may use this run."),
    budget: z
      .object({
        max_usd: z.number().nonnegative().nullable().default(null).describe("USD cap for the whole orchestration; null = no cap."),
        max_tool_calls: z
          .number()
          .int()
          .positive()
          .nullable()
          .default(null)
          .describe("Maximum tool calls the executor will run; null = no cap."),
      })
      .default({})
      .describe("Budget limits for the orchestration."),
    autonomy: OrchestrateAutonomy.default("suggest"),
  })
  .describe("Contract for one orchestrate run: goal, allowed tool belt, budget, and autonomy level.");
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
 * One concrete tool invocation in a planner plan, with PER-TOOL TYPED args via a
 * discriminated union on `tool`. The executor (auto_safe/auto_full) runs these
 * in order; under `suggest` the user executes them. Args are validated by the
 * variant — never an open `z.record` bag — so a malformed plan fails loudly.
 */
export const OrchestratePlanCall = z
  .discriminatedUnion("tool", [
    z
      .object({
        tool: z.literal("start_run"),
        prompt: z.string().min(1).describe("Prompt for the sub-run."),
        mode: ModeKind.default("agent").describe("Mode for the sub-run."),
        harness: z.string().optional().describe("Harness to run on; omitted = engine routing."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Start one isolated sub-run."),
    z
      .object({
        tool: z.literal("race"),
        prompt: z.string().min(1).describe("Prompt raced across harnesses."),
        n: z.number().int().min(2).default(2).describe("Number of race candidates (one per harness)."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Race the prompt as a best-of-N run."),
    z
      .object({
        tool: z.literal("review"),
        run_id: z.string().min(1).describe("Run to review."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Review an existing run."),
    z
      .object({
        tool: z.literal("status"),
        run_id: z.string().min(1).describe("Run to inspect."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Read the status of an existing run."),
    z
      .object({
        tool: z.literal("answer_question"),
        interaction_id: z.string().min(1).describe("Pending interaction to answer."),
        answers: z
          .array(
            z.object({
              question_id: z.string().min(1).describe("Id of the question being answered."),
              selected_labels: z.array(z.string()).default([]).describe("Labels of the selected options."),
              free_text: z.string().nullable().default(null).describe("Free-text answer; null when only options were selected."),
            }),
          )
          .default([])
          .describe("Answers, one per question."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Answer a pending interactive question of a sub-run."),
    z
      .object({
        tool: z.literal("apply"),
        run_id: z.string().min(1).describe("Run whose work product to deliver."),
        mode: z
          .enum(["apply", "branch", "commit", "pr"])
          .default("apply")
          .describe("Delivery mode: apply to the tree, or as a branch, commit, or PR."),
        why: z.string().default("").describe("Planner's reason for this step."),
      })
      .describe("Deliver a run's work product to the project (the only live-tree-mutating tool)."),
  ])
  .describe("One concrete tool invocation in a planner plan, with per-tool typed args discriminated on `tool`.");
export type OrchestratePlanCall = z.infer<typeof OrchestratePlanCall>;

/**
 * The TYPED orchestration plan extracted from the planner's report (the fenced
 * JSON block the orchestrate prompt requires). Persisted as
 * `final/orchestration.yaml`; a missing/invalid block is disclosed in the
 * summary, never silently dropped.
 */
export const OrchestratePlan = z
  .object({
    tool_calls: z.array(OrchestratePlanCall).min(1).describe("Ordered tool invocations of the plan."),
  })
  .describe("The typed orchestration plan extracted from the planner's report; persisted as final/orchestration.yaml.");
export type OrchestratePlan = z.infer<typeof OrchestratePlan>;

/** Per-step executor status (auto_safe/auto_full). */
export const OrchestrateStepStatus = z
  .enum(["pending", "running", "done", "skipped", "blocked", "failed"])
  .describe("Executor status of one plan step: pending, running, done, skipped, blocked (risky step awaiting a human), or failed.");
export type OrchestrateStepStatus = z.infer<typeof OrchestrateStepStatus>;

/**
 * Typed executor progress over a plan's tool_calls. Persisted as
 * `final/orchestration_progress.yaml` and projected into the run detail so a
 * surface renders honest per-step outcomes (which safe steps ran, where a risky
 * step blocked, why it stopped). Producer: the orchestrator executor; consumer:
 * the control-api run-detail projection.
 */
export const OrchestratePlanProgress = z
  .object({
    steps: z
      .array(
        z.object({
          index: z.number().int().nonnegative().describe("Position of the step in the plan."),
          tool: OrchestrateToolName,
          risk: z.enum(["safe", "risky"]).describe("Risk class of the step: safe (no live-tree mutation) or risky."),
          status: OrchestrateStepStatus,
          /** Sub-run id this step started/targeted (start_run/race/review/status/apply), when known. */
          run_id: z.string().nullable().default(null).describe("Sub-run id this step started/targeted, when known."),
          detail: z.string().nullable().default(null).describe("Human-readable step detail."),
        }),
      )
      .default([])
      .describe("Per-step outcomes, in plan order."),
    autonomy: OrchestrateAutonomy,
    /** Set when the executor stopped early (first risky step under auto_safe, budget, abort). */
    stopped_reason: z
      .string()
      .nullable()
      .default(null)
      .describe("Set when the executor stopped early (first risky step under auto_safe, budget, abort)."),
  })
  .describe("Typed executor progress over a plan's tool calls, persisted as final/orchestration_progress.yaml and projected into run detail.");
export type OrchestratePlanProgress = z.infer<typeof OrchestratePlanProgress>;

/**
 * JSON Schema for the planner's typed plan, computed from the LIVE Zod shape
 * (the SSOT) — passed as HarnessRunSpec.output_schema so schema-capable CLIs
 * constrain their final message to a valid OrchestratePlan.
 */
let orchestratePlanJsonSchemaCache: Record<string, unknown> | null = null;
export function orchestratePlanJsonSchema(): Record<string, unknown> {
  // INLINE root (no name/$ref wrapper): claude materializes --json-schema as
  // a StructuredOutput TOOL whose input_schema must carry a top-level "type"
  // — a $ref-wrapped root 400s (LIVE-VERIFIED). Codex accepts both.
  orchestratePlanJsonSchemaCache ??= strictifyForStructuredOutput(
    zodToJsonSchema(OrchestratePlan, { $refStrategy: "none" }) as Record<string, unknown>,
  );
  return orchestratePlanJsonSchemaCache;
}

/**
 * Vendor STRICT structured-output mode (LIVE-VERIFIED against codex 0.137 /
 * the OpenAI Responses API): every object must list ALL property keys in
 * `required` and set `additionalProperties: false` — optional-with-default
 * fields become always-emitted (their Zod defaults make explicit values
 * equivalent). One owner for the transform; a schema that violates this is
 * rejected by the vendor with invalid_json_schema.
 */
function strictifyForStructuredOutput(node: unknown): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const obj = { ...(value as Record<string, unknown>) };
    for (const key of Object.keys(obj)) obj[key] = walk(obj[key]);
    if (obj["type"] === "object" && obj["properties"] && typeof obj["properties"] === "object") {
      const props = obj["properties"] as Record<string, unknown>;
      const originallyRequired = new Set(Array.isArray(obj["required"]) ? (obj["required"] as unknown[]) : []);
      // Vendor strict mode demands required = ALL keys; fields that were
      // OPTIONAL in the source schema stay expressible by becoming NULLABLE
      // (the OpenAI strict-mode recipe) — otherwise the model would be FORCED
      // to invent values for e.g. start_run.harness on every call.
      for (const key of Object.keys(props)) {
        if (originallyRequired.has(key)) continue;
        const prop = props[key];
        if (prop && typeof prop === "object" && !Array.isArray(prop)) {
          const p = prop as Record<string, unknown>;
          if (typeof p["type"] === "string" && p["type"] !== "null") {
            p["type"] = [p["type"], "null"];
          } else if (Array.isArray(p["type"]) && !(p["type"] as unknown[]).includes("null")) {
            (p["type"] as unknown[]).push("null");
          }
        }
      }
      obj["required"] = Object.keys(props);
      obj["additionalProperties"] = false;
    }
    return obj;
  };
  return walk(node) as Record<string, unknown>;
}
