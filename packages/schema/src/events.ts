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
    /** The requested/sticky PRIMARY harness was dropped BEFORE any attempt (its
     * account was quota-exhausted / on cooldown, or the route was unavailable),
     * so the run's effective harness differs from what the composer chip showed.
     * A pre-attempt routing divergence — distinct from a mid-run route.fallback.*
     * (no attempt was ever made on the primary to fall back FROM); never silent.
     * Payload: RoutePrimaryDivergedPayload {requested, effective, reason, detail}. */
    "route.primary.diverged",
    /** QA-043: an AUTO pool dropped one or more incompatible lanes and/or its
     * effective width fell below the requested `n`. The route resolver NEVER
     * backfills a dropped lane's slot by duplicating a surviving harness (the
     * self-race class), so a shrunk pool is disclosed here — requested vs
     * effective harnesses/width plus every dropped lane and its typed stage.
     * Explicit pools fail loudly at the drop instead of reaching this event.
     * Payload: RoutePoolDegradedPayload. */
    "route.pool.degraded",
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
    /** QA-024: a --delegate attempt injected the Claudexor delegation belt but
     * the harness reported its MCP server `failed` to start and no belt tool ran
     * — the requested capability never became operational (the harness may have
     * degraded to its own native subagent). Never silent: this surfaces the
     * failed belt so the terminal outcome and UI can disclose it. Payload:
     * {attempt_id, harness_id, server_name, reason}. */
    "delegation.belt.unavailable",
    "output.ready",
    "gate.started",
    "gate.completed",
    "review.started",
    /** QA-025: the paid reviewer panel was intentionally NOT run — every working
     * candidate had an empty diff, or no reviewers were configured. Emitted
     * INSTEAD of review.started so the audit trail never claims a review began
     * that was skipped. Payload:
     * {reason: "no_changes"|"no_reviewers", reviewable_candidates,
     *  configured_reviewers, configured_provider_families}. */
    "review.skipped",
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
    /** D-16d: a one-shot automatic continuation was launched after a terminal
     * context exhaustion (eligible cause, no completed WorkReport). Payload:
     * {from_attempt, cause, continuation_count, packet_turns}. */
    "run.continuation",
    /** D-16d: an eligible one-shot continuation was REFUSED because its budget
     * lease was denied — emitted INSTEAD of run.continuation so a denied lease
     * never leaves a disclosure claiming a continuation launched. No attempt ran
     * and the one-shot is not consumed. Payload: {from_attempt, cause, reason}. */
    "run.continuation.denied",
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

/**
 * Typed payload for the `route.primary.diverged` event. Emitted at route
 * selection when a run's requested/sticky PRIMARY harness is not the harness
 * that will actually run (its account was quota-exhausted / on cooldown, or the
 * route was unavailable), so the composer's visible harness choice silently
 * would not have applied. The orchestrator validates this before stamping it, so
 * the divergence is always evidence-backed — the receipt discloses "requested
 * <requested> → ran on <effective> (<reason>)" from real facts, never invented.
 */
export const RoutePrimaryDivergedPayload = z
  .object({
    requested: z.string().min(1).describe("The requested/sticky primary harness the chip showed."),
    effective: z
      .string()
      .nullable()
      .default(null)
      .describe("The harness that actually ran first, or null when nothing remained routable."),
    reason: FallbackReason.default("quota_exhausted"),
    detail: z
      .string()
      .nullable()
      .default(null)
      .describe("Redacted human reason the primary was dropped (e.g. cooldown, unavailable)."),
  })
  .describe(
    "Typed payload for route.primary.diverged, validated before being stamped onto the RunEvent payload so a pre-attempt primary divergence is always evidence-backed.",
  );
export type RoutePrimaryDivergedPayload = z.infer<typeof RoutePrimaryDivergedPayload>;

/** The routing stage at which an auto-pool lane was dropped. Typed so a
 * disclosed omission preserves the ACTUAL cause (an access refusal is not an
 * auth failure) instead of collapsing every drop to one reason (QA-043). */
export const RouteDropStage = z
  .enum([
    "discovery",
    "settings",
    "credential",
    "doctor",
    "capability",
    "access",
    "web",
    "attachment",
  ])
  .describe("The routing stage at which an auto-pool lane was dropped.");
export type RouteDropStage = z.infer<typeof RouteDropStage>;

/**
 * Typed payload for `route.pool.degraded`. Emitted once at route resolution
 * when an AUTO pool lost lanes and/or clamped width below the requested `n`.
 * It is the canonical requested-vs-effective route receipt: the resolver never
 * duplicates a surviving harness to refill a dropped lane's slot (the QA-043
 * self-race), so the shrink is disclosed here rather than hidden as an
 * identical extra candidate. Explicit pools throw at the drop and never reach
 * this event, so a degraded auto pool is always attributable to real
 * unavailability, not a silent substitution.
 */
export const RoutePoolDegradedPayload = z
  .object({
    requested_harnesses: z
      .array(z.string())
      .describe("The pool the resolver considered (explicit ids or auto-derived)."),
    effective_harnesses: z
      .array(z.string())
      .describe("Distinct harnesses that actually route, in attempt order."),
    requested_n: z.number().int().describe("The requested candidate width for this run."),
    effective_n: z
      .number()
      .int()
      .describe("Distinct candidates that will run; never inflated by duplication."),
    dropped_lanes: z
      .array(
        z.object({
          harness_id: z.string().describe("The dropped lane's harness id."),
          stage: RouteDropStage,
          detail: z.string().describe("Redacted human reason the lane was dropped."),
        }),
      )
      .describe("Every lane excluded from the auto pool, with its typed stage and reason."),
  })
  .describe(
    "Typed payload for route.pool.degraded: the requested-vs-effective route receipt for an auto pool that dropped lanes or clamped width, validated before being stamped onto the RunEvent payload.",
  );
export type RoutePoolDegradedPayload = z.infer<typeof RoutePoolDegradedPayload>;

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
