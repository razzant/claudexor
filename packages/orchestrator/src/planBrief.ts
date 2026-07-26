import { join } from "node:path";
import type { ArtifactStore, RunPaths } from "@claudexor/artifact-store";
import { readTextSafe, sha256 } from "@claudexor/util";

interface PlanBriefInput {
  prompt: string;
  planRef?: { runId: string; sha256: string; path: string };
}

interface PlanBriefEventSink {
  emit(type: "plan.brief.materialized", payload: Record<string, unknown>): unknown;
}

/**
 * Freeze-on-implement delivery (D17/D27): verify the frozen plan's hash before
 * any run artifact/event exists. A missing or changed plan is a loud preflight
 * refusal, so retries can never silently proceed without their frozen plan.
 */
export function verifiedPlanBrief(input: PlanBriefInput): string | null {
  if (!input.planRef) return null;
  const text = readTextSafe(input.planRef.path);
  if (!text || !text.trim()) {
    throw new Error(
      `implement plan: the frozen plan at ${input.planRef.path} is missing or unreadable`,
    );
  }
  const digest = sha256(text).replace(/^sha256:/, "");
  if (digest !== input.planRef.sha256) {
    throw new Error(
      `implement plan: plan hash mismatch (expected ${input.planRef.sha256}, got ${digest}) — the plan was modified after freeze; re-run Implement from the plan turn`,
    );
  }
  return text;
}

/**
 * Materialize the already-verified plan outside every worktree, then point the
 * task prompt at that immutable run-context copy.
 */
export function withPlanBrief<T extends PlanBriefInput>(
  input: T,
  store: ArtifactStore,
  paths: RunPaths,
  log: PlanBriefEventSink,
  verifiedText: string | null = verifiedPlanBrief(input),
): T {
  if (!input.planRef || verifiedText === null) return input;
  const briefPath = join(paths.contextDir, "PLAN.md");
  store.writeText(briefPath, verifiedText);
  log.emit("plan.brief.materialized", {
    plan_run_id: input.planRef.runId,
    sha256: input.planRef.sha256,
    path: "context/PLAN.md",
  });
  return {
    ...input,
    prompt: `${input.prompt}\n\nThe approved plan is at: ${briefPath} — read it before starting and re-read it as needed.`,
  };
}
