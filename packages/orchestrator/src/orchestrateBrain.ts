/**
 * Prompt framing for the orchestrate BRAIN (plan-only). The tool belt comes
 * from the typed OrchestrateContract — the prompt never invents actions the
 * executor will not honor.
 */
import type { OrchestrateContract as OrchestrateContractT, OrchestratePlan as OrchestratePlanT } from "@claudexor/schema";
import { OrchestratePlan as OrchestratePlanSchema } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";

function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

export function buildOrchestrateBrainPrompt(
  goal: string,
  pool: string[],
  crossFamily: boolean,
  contract: OrchestrateContractT,
): string {
  return [
    `You are the Claudexor orchestration brain. Plan — do not implement.`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Available harness pool (doctor-verified)`,
    pool.length > 0
      ? pool.map((id) => `- ${id}`).join("\n")
      : "- (none verified; plan must say what setup is needed)",
    crossFamily
      ? `Cross-family race and cross-family review ARE available (2+ harnesses).`
      : `Only single-route execution is available (fewer than 2 verified harnesses).`,
    ``,
    `## Tool belt (the ONLY actions your plan may use)`,
    ...contract.tool_belt.map((t) => `- ${t}`),
    ``,
    `## Required output`,
    `1. A concise markdown orchestration plan (numbered steps; each step names ONE tool and its arguments).`,
    '2. A fenced ```json block: {"tool_calls": [ … ]}. Each call puts the tool name AND its arguments at the TOP LEVEL — there is NO nested "args" object. Per-tool shapes (use only belt tools):',
    '   - start_run: {"tool":"start_run","prompt":"…","mode":"agent","harness":"<optional id>","why":"…"}',
    '   - race:      {"tool":"race","prompt":"…","n":2,"why":"…"}',
    '   - review:    {"tool":"review","run_id":"<id>","why":"…"}',
    '   - status:    {"tool":"status","run_id":"<id>","why":"…"}',
    '   - apply:     {"tool":"apply","run_id":"<id>","mode":"apply","why":"…"}',
    `Keep the plan minimal and budget-aware. Do not propose tools outside the belt.`,
  ].join("\n");
}

/**
 * Extract + validate the brain's typed plan from its markdown report (the
 * fenced ```json block the orchestrate prompt requires). Structured-output
 * parsing, not governance: validity is decided by the OrchestratePlan schema.
 */
export function extractOrchestratePlan(report: string): { plan: OrchestratePlanT | null; error: string } {
  const fence = /```json\s*\n([\s\S]*?)\n```/g;
  let lastBlock: string | null = null;
  for (const match of report.matchAll(fence)) lastBlock = match[1] ?? null;
  if (!lastBlock) return { plan: null, error: "no fenced json block found in the brain report" };
  try {
    const parsed = OrchestratePlanSchema.safeParse(JSON.parse(lastBlock));
    if (!parsed.success)
      return {
        plan: null,
        error: `plan block failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      };
    return { plan: parsed.data, error: "" };
  } catch (err) {
    return { plan: null, error: `plan block is not valid JSON: ${safeErrorMessage(err)}` };
  }
}
