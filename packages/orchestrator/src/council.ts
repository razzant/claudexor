import type { CouncilMember, CouncilProjection } from "@claudexor/schema";

/**
 * Council plan strategy (INV-031 / D31): N harnesses draft plans in parallel,
 * the primary merges them into ONE unified plan whose open questions reach the
 * user as one set. This module holds the PURE decisions — member selection,
 * the merge prompt, artifact naming, and the membership projection — so the
 * orchestrator keeps only the spawn/stream machinery it already owns (which
 * the round-1 drafts and the merge iteration REUSE unchanged). No new state
 * machine: a council is round-1 attempts + one merge attempt, disclosed.
 */

/** Default council width when `n` is unset: distinct available harnesses, up
 * to 3. Kept beside member selection so the CLI/MCP default and the engine
 * default can never drift. */
export const DEFAULT_COUNCIL_MEMBERS = 3;

/** Resolve how many members draft, given the requested `n` (already validated
 * to 2..4 by runStartStrategyViolations when present) and the distinct pool
 * size. Council NEVER duplicates a harness into two members — a member is one
 * distinct lane — so the effective count is capped by availability. A count
 * below the request is `degraded` (disclosed), not silent. */
export function resolveCouncilWidth(
  requestedN: number | undefined,
  availableDistinct: number,
): { requested: number; members: number; degraded: boolean } {
  const requested = requestedN ?? Math.min(availableDistinct, DEFAULT_COUNCIL_MEMBERS);
  const members = Math.min(requested, availableDistinct);
  return { requested, members, degraded: members < requested };
}

/** Relative artifact path for a member's round-1 draft. File-backed — a draft
 * is NEVER concatenated into a prompt bubble; the merge references it by
 * absolute path (pointer line), like withPlanBrief materializes the frozen
 * plan. Harness ids are `[a-z0-9_-]`, safe as a path segment. */
export function councilDraftRelPath(harnessId: string): string {
  return `council/draft-${harnessId}.md`;
}

/** The merge prompt for the PRIMARY's synthesize iteration. It POINTS at the
 * surviving draft FILES by absolute path (never embeds their full text) and
 * demands one unified plan ending with the SAME tagged `## Open Questions`
 * block the solo planPrompt uses — so the engine parser runs on the merge
 * output only and produces the shape-identical final/questions.json. */
export function councilMergePrompt(
  goal: string,
  drafts: { harnessId: string; absPath: string }[],
): string {
  const pointerLines = drafts.map((d) => `- ${d.harnessId}: ${d.absPath}`);
  return [
    `You are MERGING ${drafts.length} independent draft plan(s) into ONE unified plan. You are planning, NOT implementing. Work read-only; do not write files or output full implementations.`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Draft plans to merge (read each file before merging)`,
    ...pointerLines,
    ``,
    `Read every draft above. Reconcile their approaches: keep what is strongest, resolve contradictions explicitly, and drop redundancy. Produce a SINGLE coherent plan — not a list of the drafts.`,
    ``,
    `## Required output (markdown)`,
    `1. Approach — 2-3 sentences on the merged approach.`,
    `2. Steps — a numbered list; each step names the file(s) it touches and what changes.`,
    `3. Risks & edge cases.`,
    `4. End your response with a section titled exactly:`,
    ``,
    `## Open Questions`,
    ``,
    `Consolidate every decision the user must make — across ALL drafts — into ONE list, deduplicated, one per bullet, in EXACTLY this format:`,
    ``,
    `- [single] <question> :: <option A> :: <option B>`,
    `- [multi] <question> :: <option A> :: <option B>`,
    `- [text] <question that has no good fixed options>`,
    ``,
    `Rules: [single] = pick exactly one; [multi] = pick one or more; [text] = free-form (no "::" options). Ground every option in THIS repository. If nothing is ambiguous, write a single bullet: - (none)`,
    ``,
    `Keep it concise. Reference real paths. Do NOT paste large code blocks; describe the change instead.`,
  ].join("\n");
}

/** Assemble the council membership projection written to
 * `council/membership.yaml` and served on ControlRunDetail.council. Draft
 * order is member order; the primary is the merger. `mergedBy` is null when
 * the merge itself failed (all-fail is a typed run failure, so this is the
 * "merge attempt errored despite surviving drafts" edge). */
export function buildCouncilProjection(args: {
  requested: number;
  members: {
    harnessId: string;
    role: "primary" | "member";
    drafted: boolean;
    error: string | null;
  }[];
  mergedBy: string | null;
}): CouncilProjection {
  const drafted = args.members.filter((m) => m.drafted).length;
  const memberCards: CouncilMember[] = args.members.map((m) => ({
    harnessId: m.harnessId,
    role: m.role,
    status: m.drafted ? (m.harnessId === args.mergedBy ? "merged" : "drafted") : "failed",
    error: m.error,
  }));
  return {
    requested: args.requested,
    drafted,
    degraded: drafted < args.requested,
    mergedBy: args.mergedBy,
    members: memberCards,
  };
}

/** One-line human disclosure of council degradation for summary.md. Empty
 * string when the council ran at full requested width. */
export function councilDegradationNote(projection: CouncilProjection): string {
  if (!projection.degraded) return "";
  const failed = projection.members.filter((m) => m.status === "failed");
  const failedNote =
    failed.length > 0 ? ` (failed: ${failed.map((m) => m.harnessId).join(", ")})` : "";
  return `council degraded to ${projection.drafted} of ${projection.requested} member(s)${failedNote}`;
}
