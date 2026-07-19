/**
 * Continuity FACTS (INV-137): the I/O-bearing helpers that feed the pure packet
 * builder (`continuity.ts`) — the active-plan pointer, the git workspace anchor,
 * and the cached-or-fresh LLM summary resolution. Split out of the orchestrator
 * so the engine's chat surface stays under the readability ratchet; each is a
 * free function taking explicit, already-resolved inputs (no orchestrator
 * `this`), so they are directly unit-testable.
 */
import { join } from "node:path";
import {
  PlanQuestionsArtifact,
  derivePlanReadiness,
  type CredentialProfile,
} from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter } from "@claudexor/core";
import {
  readThreadSummary,
  revParse,
  statusPorcelain,
  writeThreadSummary,
} from "@claudexor/workspace";
import {
  planContinuation,
  type ContinuityAnchor,
  type ContinuityPlanPointer,
  type ContinuityRequest,
  type ResolvedSummary,
} from "./continuity.js";
import { summarizeThreadPrefix } from "./continuity-summary.js";

/** The thread's most recent readable plan pointer (INV-137 packet section). */
export function activePlanPointer(
  priorTurns: ReadonlyArray<{ runId: string | null }>,
  store: ArtifactStore,
): ContinuityPlanPointer | null {
  for (let i = priorTurns.length - 1; i >= 0; i -= 1) {
    const runId = priorTurns[i].runId;
    if (!runId) continue;
    const finalDir = store.runPaths(runId).finalDir;
    const planText = readTextSafe(join(finalDir, "plan.md"));
    if (!planText || !planText.trim()) continue;
    const questions = readTextSafe(join(finalDir, "questions.json"));
    let readiness = "unverified";
    if (questions) {
      try {
        readiness = derivePlanReadiness(PlanQuestionsArtifact.parse(JSON.parse(questions))).state;
      } catch {
        readiness = "unverified";
      }
    }
    return { path: join(finalDir, "plan.md"), readiness, planRunId: runId };
  }
  return null;
}

/** HEAD sha + dirty file count for the packet's workspace anchor. Best-effort:
 * a non-git or unborn tree yields a null sha / zero dirty count, never a throw. */
export async function workspaceAnchor(repoRoot: string): Promise<ContinuityAnchor> {
  let headSha: string | null = null;
  try {
    headSha = await revParse(repoRoot, "HEAD");
  } catch {
    headSha = null;
  }
  let dirtyCount = 0;
  try {
    dirtyCount = (await statusPorcelain(repoRoot)).split("\n").filter((l) => l.trim()).length;
  } catch {
    dirtyCount = 0;
  }
  return { headSha, dirtyCount };
}

export interface ContinuitySummaryInputs {
  req: ContinuityRequest;
  /** Present only for a thread turn; a non-thread run gets no summary. */
  threadId: string | undefined;
  /** Project root that keys the summary cache (matches the lane-home keying). */
  projectRoot: string;
  /** Read-only working directory for the bounded pass (the execution root). */
  cwd: string;
  /** The lane's harness adapter, or undefined when unavailable (→ fallback). */
  adapter: HarnessAdapter | undefined;
  credentialProfile: CredentialProfile | null;
  authPreference: "subscription" | "api_key" | "auto";
  /** Scoped lane-home env so the pass authenticates on the lane's own account. */
  laneEnv: Record<string, string>;
  envInheritance: "mirror_native" | "clean";
  signal?: AbortSignal;
}

/**
 * Resolve the cached-or-fresh LLM summary for a packet's collapsed prefix
 * (INV-137, V9c). Returns the summary to inject, or null when the packet does
 * not collapse, no adapter is available, or summarization fails/times out — in
 * every null case the caller keeps the mechanical one-liner collapse. Owns its
 * OWN try/catch: a summary failure must never drop the whole packet.
 */
export async function resolveContinuitySummary(
  inputs: ContinuitySummaryInputs,
): Promise<ResolvedSummary | null> {
  if (!inputs.threadId) return null;
  try {
    const plan = planContinuation(inputs.req);
    // Only a budget-forced collapse needs a summary; nothing to collapse → skip.
    if (plan.kind !== "packet" || !plan.summaryUpToTurnId) return null;
    const { threadId, projectRoot } = inputs;
    const upToTurnId = plan.summaryUpToTurnId;
    // Cache hit: reuse until the collapse boundary (upToTurnId) advances.
    const cached = readThreadSummary(projectRoot, threadId, upToTurnId);
    if (cached) return { upToTurnId, text: cached };
    if (!inputs.adapter) return null;
    const text = await summarizeThreadPrefix({
      adapter: inputs.adapter,
      turns: plan.collapsedPrefix,
      cwd: inputs.cwd,
      env: inputs.laneEnv,
      credentialProfile: inputs.credentialProfile,
      authPreference: inputs.authPreference,
      envInheritance: inputs.envInheritance,
      signal: inputs.signal,
    });
    if (!text) return null;
    writeThreadSummary(projectRoot, threadId, upToTurnId, text);
    return { upToTurnId, text };
  } catch {
    return null;
  }
}
