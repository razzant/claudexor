/**
 * D-16d one-shot automatic continuation controller.
 *
 * When an attempt terminalizes on a typed context `capacity_exhausted` signal
 * with an ELIGIBLE cause and produced no completed WorkReport, the engine may
 * launch ONE fresh-session continuation (design §5). This module is the PURE
 * decision + request-synthesis core; the orchestrator owns the re-run I/O.
 *
 * Eligibility (all must hold):
 *   - a terminal capacity_exhausted was observed;
 *   - its cause is in the eligible set (initially claude `repeated_refill` —
 *     the rapid-refill breaker; `prompt_too_long` is EXCLUDED because the
 *     packet may be irreducible, so a fresh session would exhaust again);
 *   - no completed WorkReport was produced;
 *   - continuation_count == 0 (strictly one-shot);
 *   - the run is read-only or enveloped (an in-place run is excluded — a fresh
 *     session cannot safely resume mutation of the live tree).
 *
 * The continuation always runs a FRESH native session
 * (`nativeResumeAvailable:false`, grounding §10): the prior session is the one
 * that ran out of room, so resuming it would re-load the same context. A
 * mechanical-first checkpoint packet (via the existing continuity module)
 * re-grounds the fresh session in what the prior turn did.
 */
import { buildContinuation, type ContinuityRequest, type ContinuityResult } from "./continuity.js";
import type { HarnessEvent } from "@claudexor/schema";

type ContextCause = NonNullable<HarnessEvent["context"]>["cause"];

/** Context-exhaustion causes a one-shot continuation is allowed to retry. Only
 * `repeated_refill` for now; `prompt_too_long` is deliberately excluded. */
export const CONTINUATION_ELIGIBLE_CAUSES: ReadonlySet<ContextCause> = new Set<ContextCause>([
  "repeated_refill",
]);

/** The kind of run, for the in-place exclusion. */
export type ContinuationRunKind = "read_only" | "enveloped" | "in_place";

export interface ContinuationDecision {
  eligible: boolean;
  /** Machine-stable reason (why eligible, or why not) — for the disclosure. */
  reason: string;
}

/** Decide whether a terminal context exhaustion qualifies for a one-shot
 * continuation. Pure; the caller supplies the observed facts. */
export function decideContinuation(input: {
  contextExhausted: boolean;
  contextExhaustedCause: ContextCause | null;
  workStateCompleted: boolean;
  continuationCount: number;
  runKind: ContinuationRunKind;
}): ContinuationDecision {
  if (!input.contextExhausted) {
    return { eligible: false, reason: "no terminal context exhaustion" };
  }
  if (input.workStateCompleted) {
    return { eligible: false, reason: "a completed WorkReport was produced" };
  }
  if (input.continuationCount > 0) {
    return { eligible: false, reason: "continuation already attempted (one-shot)" };
  }
  if (input.runKind === "in_place") {
    return { eligible: false, reason: "in-place runs are excluded from continuation" };
  }
  if (
    input.contextExhaustedCause === null ||
    !CONTINUATION_ELIGIBLE_CAUSES.has(input.contextExhaustedCause)
  ) {
    return {
      eligible: false,
      reason: `cause ${input.contextExhaustedCause ?? "unknown"} is not continuation-eligible`,
    };
  }
  return { eligible: true, reason: "eligible" };
}

/**
 * A stable sentinel embedded in the continuation packet pointer so a downstream
 * consumer (e.g. a deterministic fake harness in a canary) can recognize that
 * THIS turn is a one-shot continuation. Not load-bearing for production routes;
 * real harnesses read the packet body itself.
 */
export const CONTINUATION_PACKET_SENTINEL = "one-shot continuation after context exhaustion";

/**
 * Synthesize the ContinuityRequest for the continuation turn — a sibling of the
 * orchestrator's `resolveContinuity` but always with `nativeResumeAvailable:
 * false` (fresh session). The single prior turn is the exhausted attempt; its
 * partial output re-grounds the fresh session.
 */
export function synthesizeContinuationRequest(input: {
  harness: string;
  profileId: string | null;
  priorPrompt: string;
  priorOutput: string;
}): ContinuityRequest {
  return {
    lane: { harness: input.harness, profileId: input.profileId },
    priorTurns: [
      { id: "t-context-exhausted", prompt: input.priorPrompt, outputText: input.priorOutput },
    ],
    laneCheckpointTurnId: null,
    // The prior session ran out of room — a fresh session, re-grounded by the
    // mechanical packet, is the whole point (grounding §10).
    nativeResumeAvailable: false,
    priorHeadLane: null,
    activePlan: null,
    anchor: null,
  };
}

export interface ContinuationPacket {
  /** The pointer line to append to the fresh-session prompt (carries the
   * sentinel so canary fakes can detect the continuation), or null. */
  pointerLine: string | null;
  /** The full continuity result (packet markdown + disclosure). */
  continuity: ContinuityResult;
}

/** Build the mechanical-first checkpoint packet for a continuation request via
 * the existing continuity module. */
export function buildContinuationPacket(req: ContinuityRequest): ContinuationPacket {
  const continuity = buildContinuation(req);
  const pointerLine = continuity.packetMarkdown
    ? `Earlier context (${CONTINUATION_PACKET_SENTINEL}) is summarized below; continue the task from there.\n\n${continuity.packetMarkdown}`
    : `Earlier context (${CONTINUATION_PACKET_SENTINEL}): the prior attempt ran out of room. Continue the task.`;
  return { pointerLine, continuity };
}
