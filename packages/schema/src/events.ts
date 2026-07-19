import { z } from "zod";
import { FallbackReason, Id } from "./primitives.js";
import { AuthMode } from "./budget.js";

export const ControlJournalEvent = z
  .object({
    schemaVersion: z.literal(1),
    cursor: z.string().min(1).describe("Opaque partition-scoped resume cursor."),
    partition: z.string().min(1),
    type: z.string().min(1),
    observedAt: z.string().datetime({ offset: true }),
    payload: z.unknown(),
  })
  .strict()
  .describe("One durable event from a global or project journal partition.");
export type ControlJournalEvent = z.infer<typeof ControlJournalEvent>;

export const ThreadHeadPing = z
  .object({
    thread_id: Id,
    project_id: z
      .string()
      .min(1)
      .nullable()
      .describe("Owning project id, or null for a no-project (global-partition) thread."),
    revision: z
      .number()
      .int()
      .positive()
      .describe("Monotonic per-thread mutation counter; consumers drop stale/duplicate pings."),
  })
  .strict()
  .describe(
    "Payload of the `thread.head.updated` GLOBAL-partition journal event: a content-free " +
      "sidebar invalidation ping emitted on every thread mutation (create / rename / archive / " +
      "turn-add / run-terminal, from any surface). It carries identity only — consumers refetch " +
      "the authoritative thread summary instead of trusting event content.",
  );
export type ThreadHeadPing = z.infer<typeof ThreadHeadPing>;

export const RunEventType = z
  .enum([
    "run.created",
    "task.contract.created",
    "context.pack.created",
    "project.git.initialized",
    "budget.lease.created",
    "budget.observation",
    "budget.cash",
    "policy.web.upgraded",
    "harness.started",
    "harness.event",
    "harness.completed",
    "route.fallback.started",
    "route.fallback.completed",
    "route.fallback.exhausted",
    "route.transient.detected",
    "route.transient.retry_scheduled",
    "route.profile.headroom_exceeded",
    "route.profile.rotated",
    "route.profile.rotation_exhausted",
    "route.transient.exhausted",
    /** A subscription->API (or harness->harness) auth switch driven by a typed
     * quota/money signal. Distinct from a plain harness rotation; never silent. */
    "route.fallback.auth_switched",
    /** A thread turn was continued across the conversation (INV-137); payload
     * carries the ContinuityDisclosure stats (kind, packet_turns, summarized,
     * lane_switched_from). Replaces the old static session.rebound phrase. */
    "session.continuity",
    "interaction.requested",
    "interaction.answered",
    "interaction.timeout",
    "interaction.answer_discarded",
    "plan.progress",
    "plan.questions",
    "plan.brief.materialized",
    /** Council plan strategy (INV-031): membership announced, per-member draft
     * landed / failed, and the primary's merge completed. */
    "council.started",
    "council.draft",
    "council.member.failed",
    "council.merged",
    "budget.quota_pressure",
    "output.ready",
    "gate.started",
    "gate.completed",
    "review.started",
    "reviewer.started",
    "reviewer.first_event",
    "reviewer.auth_switched",
    "reviewer.completed",
    "reviewer.timed_out",
    "reviewer.failed",
    "finding.revalidated",
    "synthesis.started",
    "arbitration.completed",
    "work_product.emitted",
    /** A race/agent winner's patch was auto-applied to the live in-place tree
     * (or the apply was attempted and failed). Payload: {applied, patch_sha256, detail}. */
    "work_product.adopted",
    "control.requested",
    "control.applied",
    "control.rejected",
    "run.blocked",
    "run.completed",
    "run.failed",
  ])
  .describe(
    "Type of an append-only run event, covering run lifecycle, contract/context creation, budget, routing fallbacks, harness activity, interactions, gates, review, arbitration, work products, and control verbs.",
  );
export type RunEventType = z.infer<typeof RunEventType>;

/**
 * Typed payload for `route.fallback.*` events. The orchestrator validates this
 * before stamping it onto the (otherwise free-form) RunEvent.payload, so a
 * fallback/auth-switch is always evidence-backed and surfaced as a warning,
 * never an invisible info line.
 */
export const RouteFallbackPayload = z
  .object({
    from_harness: z.string().nullable().default(null).describe("Harness the route fell back from."),
    to_harness: z.string().nullable().default(null).describe("Harness the route fell back to."),
    from_auth_mode: AuthMode.default("unknown").describe("Auth mode before the switch."),
    to_auth_mode: AuthMode.default("unknown").describe("Auth mode after the switch."),
    reason: FallbackReason.default("manual"),
    attempt_id: z
      .string()
      .nullable()
      .default(null)
      .describe("Attempt the fallback happened in, when known."),
    error_summary: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted error detail that triggered the fallback."),
  })
  .describe(
    "Typed payload for route.fallback.* events, validated before being stamped onto the RunEvent payload so a fallback/auth-switch is always evidence-backed.",
  );
export type RouteFallbackPayload = z.infer<typeof RouteFallbackPayload>;

/** Append-only event record (one JSONL line). */
export const RunEvent = z
  .object({
    /**
     * Monotonic per-run sequence stamped by the EventLog at emit time. It is the
     * durable SSE cursor (Last-Event-ID) and the snapshot fence (detail.lastSeq).
     * Optional only for pre-v0.8.0 artifacts; every new emit carries it.
     */
    seq: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Monotonic per-run sequence stamped at emit time; the durable SSE cursor and snapshot fence. Optional only for pre-v0.8.0 artifacts.",
      ),
    ts: z.string().describe("Event timestamp."),
    run_id: Id.describe("Run the event belongs to."),
    task_id: Id.describe("Task the run belongs to."),
    /** Thread this run is a turn of, when any. Lets the global event multiplex
     * route live progress to a chat surface without a reverse job lookup. */
    thread_id: Id.optional().describe("Thread this run is a turn of, when any."),
    type: RunEventType,
    payload: z.record(z.string(), z.unknown()).default({}).describe("Event-type-specific payload."),
  })
  .describe("Append-only run event record (one JSONL line in the run's event log).");
export type RunEvent = z.infer<typeof RunEvent>;
