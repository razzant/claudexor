/**
 * Prompt framing for the orchestrate BRAIN (plan-only). The tool belt comes
 * from the typed OrchestrateContract — the prompt never invents actions the
 * executor will not honor.
 */
import type { OrchestrateContract as OrchestrateContractT } from "@claudexor/schema";

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
