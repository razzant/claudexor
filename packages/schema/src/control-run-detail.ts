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
export const ControlCandidate = z
  .object({
    attemptId: z.string().describe("Attempt id of the candidate."),
    harnessId: z.string().describe("Harness that produced the candidate."),
    label: z
      .string()
      .nullable()
      .default(null)
      .describe("Human-readable candidate label, when set."),
    costUsd: z.number().default(0).describe("Spend attributed to the candidate, in USD."),
    costEstimated: z
      .boolean()
      .default(false)
      .describe("True when the cost is token-derived rather than natively reported."),
    errored: z.boolean().default(false).describe("True when the candidate's attempt errored."),
    gatesPassed: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Number of deterministic gates that passed."),
    gatesTotal: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Total deterministic gates run for the candidate."),
    /** Blocking review findings count (accepted blockers). */
    blockers: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Count of accepted blocking review findings."),
    reviewVerified: z
      .boolean()
      .default(false)
      .describe("Whether the candidate's review route was verified."),
    finalReviewClean: z
      .boolean()
      .nullable()
      .default(null)
      .describe("Whether the final review was clean; null when no final review ran."),
    winner: z.boolean().default(false).describe("True for the adopted/winning candidate."),
    diffstat: z
      .object({
        files: z.number().int().nonnegative().default(0).describe("Files changed."),
        additions: z.number().int().nonnegative().default(0).describe("Lines added."),
        deletions: z.number().int().nonnegative().default(0).describe("Lines deleted."),
      })
      .nullable()
      .default(null)
      .describe("Diff statistics of the candidate's patch; null when there is no patch."),
  })
  .describe(
    "Per-candidate evidence card for a race run, projected from attempt, review, and decision artifacts.",
  );
export type ControlCandidate = z.infer<typeof ControlCandidate>;

export const ControlRunDetail = z
  .object({
    summary: ControlRunSummary,
    /**
     * Highest event seq included in this snapshot. Clients subscribe to the
     * event stream from this cursor; events with seq <= lastSeq are already
     * reflected in the snapshot (snapshot-then-subscribe, no gaps, no dupes).
     */
    lastSeq: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Highest event seq included in this snapshot; clients subscribe to the event stream from this cursor (snapshot-then-subscribe, no gaps, no dupes).",
      ),
    artifacts: z
      .array(ControlArtifactInfo)
      .default([])
      .describe("Artifacts recorded in the run tree."),
    primaryOutput: ControlPrimaryOutput.nullable()
      .default(null)
      .describe("The run's primary user-facing output; null while pending."),
    timeline: z
      .array(ControlTimelineEvent)
      .default([])
      .describe("Projected timeline of run events."),
    budget: ControlBudgetSnapshot.default({}),
    finalSummary: z
      .string()
      .nullable()
      .default(null)
      .describe("Final summary text; null when the run has none."),
    decision: DecisionRecord.nullable()
      .default(null)
      .describe("The arbitration decision; null before arbitration."),
    /** Persisted operator unblock decision (accept_risk/override), hash-bound; server-owned apply affordance. */
    operatorDecision: z
      .object({
        action: z.string().describe("Operator decision action (e.g. accept_risk, override)."),
        decidedAt: z.string().nullable().default(null).describe("When the decision was made."),
      })
      .nullable()
      .default(null)
      .describe(
        "Persisted operator unblock decision (accept_risk/override), hash-bound; null when none was made.",
      ),
    workProduct: WorkProduct.nullable()
      .default(null)
      .describe("The run's work product; null when none was produced."),
    /** Derived apply-gate verdict (single producer: the delivery gate); null when the run has no patch artifact. */
    applyEligibility: ApplyEligibility.nullable()
      .default(null)
      .describe(
        "Derived apply-gate verdict (single producer: the delivery gate); null when the run has no patch artifact.",
      ),
    reviewFindings: z
      .array(ReviewFinding)
      .default([])
      .describe("Review findings recorded for the run."),
    pendingInteractions: z
      .array(ControlPendingInteraction)
      .default([])
      .describe("Interactive questions currently awaiting answers."),
    /** Typed executor progress for an orchestrate run (auto_safe/auto_full);
     * null for non-orchestrate runs or suggest autonomy. Projected from
     * final/orchestration_progress.yaml. */
    orchestrate: OrchestratePlanProgress.nullable()
      .default(null)
      .describe(
        "Typed executor progress for an orchestrate run; null for non-orchestrate runs or suggest autonomy.",
      ),
    /** Per-candidate evidence cards. Present for EVERY envelope-producing
     * mode (races show N lanes; single-candidate turns and convergence
     * refinements project their attempts too); empty only when no attempt
     * artifacts exist. */
    candidates: z
      .array(ControlCandidate)
      .default([])
      .describe(
        "Per-candidate evidence cards for every envelope-producing mode; empty only when no attempt artifacts exist.",
      ),
    /** Live plan checklist: the LAST plan.progress event's items, or null
     * when the run never emitted one. */
    planProgress: z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().describe("Plan item id."),
              title: z.string().describe("Plan item title."),
              status: z
                .enum(["pending", "in_progress", "completed"])
                .describe("Progress state of the item."),
            }),
          )
          .default([])
          .describe("Plan items, last-wins."),
      })
      .nullable()
      .default(null)
      .describe(
        "Live plan checklist from the last plan.progress event; null when the run never emitted one.",
      ),
    failure: RunFailure.nullable()
      .default(null)
      .describe("Typed failure info; null unless the run failed."),
  })
  .describe(
    "Full run detail snapshot served by GET /runs/:id: summary, artifacts, timeline, decision, findings, and progress.",
  );
export type ControlRunDetail = z.infer<typeof ControlRunDetail>;
