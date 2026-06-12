import { z } from "zod";
import { Id } from "./primitives.js";

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
  "answer_question",
  "apply",
  "review",
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
  stop_conditions: z.array(z.string()).default([]),
  autonomy: OrchestrateAutonomy.default("suggest"),
});
export type OrchestrateContract = z.infer<typeof OrchestrateContract>;
