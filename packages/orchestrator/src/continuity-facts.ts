/**
 * Continuity FACTS (INV-137): the I/O-bearing helpers that feed the pure packet
 * builder (`continuity.ts`) — a thread turn's packet request, each earlier
 * turn's recorded output, the active-plan pointer, the git workspace anchor,
 * and the cached-or-fresh LLM summary resolution. Split out of the orchestrator
 * so the engine's chat surface stays under the readability ratchet; each is a
 * free function taking explicit, already-resolved inputs (no orchestrator
 * `this`), so they are directly unit-testable.
 */
import { join } from "node:path";
import {
  PlanQuestionsArtifact,
  RunOutcomeFacts,
  derivePlanReadiness,
  type CredentialProfile,
} from "@claudexor/schema";
import { readTextSafe } from "@claudexor/util";
import type { ArtifactStore } from "@claudexor/artifact-store";
import type { HarnessAdapter, ProcessingAdmission } from "@claudexor/core";
import {
  readThreadSummary,
  recordedOutput,
  revParse,
  statusPorcelain,
  writeThreadSummary,
} from "@claudexor/workspace";
import {
  deltaTurns,
  planContinuation,
  type ContinuityAnchor,
  type ContinuityLane,
  type ContinuityPlanPointer,
  type ContinuityRequest,
  type ContinuityTurn,
  type ResolvedSummary,
} from "./continuity.js";
import { summarizeThreadPrefix } from "./continuity-summary.js";
import type { ThreadContinuityContext } from "./orchestrator.js";

/**
 * An earlier turn's recorded output for the packet (#405): its final answer
 * when the run wrote one. Otherwise the run's recorded output by the rule a
 * `continueFrom` successor reads it by (`recordedOutput`): its
 * `final/retained-output.md` exactly as stored, else the same projection of
 * its event log when its terminal never wrote the file. It is flagged so it is
 * never shown as an answer: `ended` when the run's terminal facts say it did
 * not succeed, `unknown` when they cannot be read (missing or unparsable),
 * which claims nothing about how it ended. A successful run without
 * `answer.md` (a plan or report turn) keeps its previous rendering. The file
 * the text came from is named wherever the packet cuts it.
 */
export function priorTurnOutput(
  runId: string | null,
  store: ArtifactStore,
): Pick<ContinuityTurn, "outputText" | "noFinalAnswer" | "outputSource"> {
  if (!runId) return { outputText: "" };
  const { root, finalDir } = store.runPaths(runId);
  const answerPath = join(finalDir, "answer.md");
  const answer = readTextSafe(answerPath) ?? "";
  if (answer.trim()) return { outputText: answer, outputSource: answerPath };
  const raw = store.readYaml<{ outcome?: { lifecycle?: unknown } }>(
    join(finalDir, "run_facts.yaml"),
  );
  const lifecycle = RunOutcomeFacts.shape.lifecycle.safeParse(raw?.outcome?.lifecycle).data;
  if (lifecycle === "succeeded") return { outputText: answer };
  const recorded = recordedOutput(root);
  return {
    outputText: recorded?.text ?? "",
    ...(recorded ? { outputSource: recorded.source } : {}),
    noFinalAnswer: lifecycle ? "ended" : "unknown",
  };
}

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

/**
 * The packet request of a thread turn on its resolved lane (INV-137): that
 * lane's checkpoint, the lane that ran the prior head, the active plan and the
 * workspace anchor. A prior turn's recorded output is read only for the turns
 * the lane is told about (`deltaTurns`); reading it can parse a whole event log,
 * and a turn the lane's native session already holds is never rendered (#405).
 */
export async function threadContinuityRequest(
  ctx: Pick<ThreadContinuityContext, "priorTurns" | "laneCheckpoints">,
  lane: ContinuityLane,
  nativeResumeAvailable: boolean,
  store: ArtifactStore,
  repoRoot: string,
): Promise<ContinuityRequest> {
  const checkpoint = ctx.laneCheckpoints.find(
    (c) => c.harness === lane.harness && (c.profileId ?? null) === lane.profileId,
  );
  const laneCheckpointTurnId = checkpoint?.turnId ?? null;
  const headTurnId = ctx.priorTurns.at(-1)?.id;
  const headOwner = ctx.laneCheckpoints.find((c) => c.turnId === headTurnId);
  const delta = deltaTurns({
    priorTurns: ctx.priorTurns,
    laneCheckpointTurnId,
    nativeResumeAvailable,
  });
  const told = new Set(delta.map((t) => t.id));
  return {
    lane,
    priorTurns: ctx.priorTurns.map((t) => ({
      id: t.id,
      prompt: t.prompt,
      ...(told.has(t.id) ? priorTurnOutput(t.runId, store) : { outputText: "" }),
    })),
    laneCheckpointTurnId,
    nativeResumeAvailable,
    priorHeadLane: headOwner
      ? { harness: headOwner.harness, profileId: headOwner.profileId ?? null }
      : null,
    activePlan: activePlanPointer(ctx.priorTurns, store),
    anchor: await workspaceAnchor(repoRoot),
  };
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
  /** The lane's own model, on a route whose request must name one (#395). */
  model?: string | undefined;
  /** Present only for a thread turn; a non-thread run gets no summary. */
  threadId: string | undefined;
  /** Project root that keys the summary cache (matches the lane-home keying). */
  projectRoot: string;
  /** Read-only working directory for the bounded pass (the execution root). */
  cwd: string;
  /** The enclosing run's own `context/`, for a transcript a lane's stdin cannot carry. */
  inputFileDir?: string | null;
  /** The lane's harness adapter, or undefined when unavailable (→ fallback). */
  adapter: HarnessAdapter | undefined;
  credentialProfile: CredentialProfile | null;
  authPreference: "subscription" | "api_key" | "auto";
  /** Scoped lane-home env so the pass authenticates on the lane's own account. */
  laneEnv: Record<string, string>;
  envInheritance: "mirror_native" | "clean";
  signal?: AbortSignal;
  processing?: Pick<
    import("@claudexor/schema").HarnessRunSpec,
    | "processing_preference"
    | "processing"
    | "processing_cost_basis"
    | "processing_allow_paid"
    | "prompt_cache_ttl"
  >;
  processingAdmission?: ProcessingAdmission;
  physicalDispatchStarted?: () => void;
  credentialObserverFactory?: import("@claudexor/core").CredentialExecutionObserverFactory;
  billingVerificationForProfile?: import("./modelGovernance.js").ModelGovernedRoute["billingVerificationForProfile"];
  paidFallback?: import("./modelGovernance.js").ModelGovernedRoute["paidFallback"];
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
      ...(inputs.model ? { model: inputs.model } : {}),
      turns: plan.collapsedPrefix,
      cwd: inputs.cwd,
      inputFileDir: inputs.inputFileDir ?? null,
      env: inputs.laneEnv,
      credentialProfile: inputs.credentialProfile,
      authPreference: inputs.authPreference,
      envInheritance: inputs.envInheritance,
      signal: inputs.signal,
      processing: inputs.processing,
      processingAdmission: inputs.processingAdmission,
      physicalDispatchStarted: inputs.physicalDispatchStarted,
      credentialObserverFactory: inputs.credentialObserverFactory,
      billingVerificationForProfile: inputs.billingVerificationForProfile,
      paidFallback: inputs.paidFallback,
    });
    if (!text) return null;
    writeThreadSummary(projectRoot, threadId, upToTurnId, text);
    return { upToTurnId, text };
  } catch {
    return null;
  }
}
