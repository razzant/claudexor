import { z } from "zod";
import { ApplyEligibility } from "./apply-eligibility.js";
import { DecisionRecord } from "./decision.js";
import { WorkProduct } from "./workproduct.js";
import { ReviewFinding } from "./review.js";
import { OrchestratePlanProgress } from "./orchestrate.js";
import {
  ControlArtifactInfo,
  ControlBudgetSnapshot,
  ControlPendingInteraction,
  ControlPrimaryOutput,
  ControlRunSummary,
  ControlTimelineEvent,
  RunFailure,
} from "./control.js";

/** Per-candidate evidence card for a race run (projected from
 * attempts/<id>/attempt.yaml + reviews/<id>.yaml + the decision winner).
 * The macOS Candidates tab renders these; SSE freshness rides the client's
 * existing refresh-on-event. */
export const ControlCandidate = z.object({
  attemptId: z.string(),
  harnessId: z.string(),
  label: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  costEstimated: z.boolean().default(false),
  errored: z.boolean().default(false),
  gatesPassed: z.number().int().nonnegative().default(0),
  gatesTotal: z.number().int().nonnegative().default(0),
  /** Blocking review findings count (accepted blockers). */
  blockers: z.number().int().nonnegative().default(0),
  reviewVerified: z.boolean().default(false),
  finalReviewClean: z.boolean().nullable().default(null),
  winner: z.boolean().default(false),
  diffstat: z
    .object({
      files: z.number().int().nonnegative().default(0),
      additions: z.number().int().nonnegative().default(0),
      deletions: z.number().int().nonnegative().default(0),
    })
    .nullable()
    .default(null),
});
export type ControlCandidate = z.infer<typeof ControlCandidate>;

export const ControlRunDetail = z.object({
  summary: ControlRunSummary,
  /**
   * Highest event seq included in this snapshot. Clients subscribe to the
   * event stream from this cursor; events with seq <= lastSeq are already
   * reflected in the snapshot (snapshot-then-subscribe, no gaps, no dupes).
   */
  lastSeq: z.number().int().nonnegative().default(0),
  artifacts: z.array(ControlArtifactInfo).default([]),
  primaryOutput: ControlPrimaryOutput.nullable().default(null),
  timeline: z.array(ControlTimelineEvent).default([]),
  budget: ControlBudgetSnapshot.default({}),
  finalSummary: z.string().nullable().default(null),
  decision: DecisionRecord.nullable().default(null),
  /** Persisted operator unblock decision (accept_risk/override), hash-bound; server-owned apply affordance. */
  operatorDecision: z
    .object({ action: z.string(), decidedAt: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  workProduct: WorkProduct.nullable().default(null),
  /** Derived apply-gate verdict (single producer: the delivery gate); null when the run has no patch artifact. */
  applyEligibility: ApplyEligibility.nullable().default(null),
  reviewFindings: z.array(ReviewFinding).default([]),
  pendingInteractions: z.array(ControlPendingInteraction).default([]),
  /** Typed executor progress for an orchestrate run (auto_safe/auto_full);
   * null for non-orchestrate runs or suggest autonomy. Projected from
   * final/orchestration_progress.yaml. */
  orchestrate: OrchestratePlanProgress.nullable().default(null),
  /** Per-candidate evidence cards. Present for EVERY envelope-producing
   * mode (races show N lanes; single-candidate turns and convergence
   * refinements project their attempts too); empty only when no attempt
   * artifacts exist. */
  candidates: z.array(ControlCandidate).default([]),
  /** Live plan checklist: the LAST plan.progress event's items, or null
   * when the run never emitted one. */
  planProgress: z
    .object({
      items: z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .default([]),
    })
    .nullable()
    .default(null),
  failure: RunFailure.nullable().default(null),
});
export type ControlRunDetail = z.infer<typeof ControlRunDetail>;

