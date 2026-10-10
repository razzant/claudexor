import { z } from "zod/v3";
import { FallbackReason, Id, ModeKind } from "./primitives.js";
import { AuthMode } from "./budget.js";
import { CredentialUnusableObservation } from "./credential-profile.js";

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

/**
 * Payload of the JOURNALED copy of a `run.created` event. The per-run
 * `events.jsonl` keeps the prompt text; the owning global/project journal
 * partition stores the prompt's digest and byte length instead, so the durable
 * stream never carries a prompt body (the accepted command already holds it).
 */
export const JournaledRunCreatedPayload = z
  .object({
    mode: ModeKind,
    prompt_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe("sha256 hex digest of the redacted prompt text."),
    prompt_bytes: z
      .number()
      .int()
      .nonnegative()
      .describe("UTF-8 byte length of the redacted prompt text."),
  })
  .passthrough()
  .describe(
    "Journaled `run.created` payload: the prompt text is replaced by its sha256 digest and byte " +
      "length in the global/project journal partition; the per-run event log keeps the prompt.",
  );
export type JournaledRunCreatedPayload = z.infer<typeof JournaledRunCreatedPayload>;

export const RunEventType = z
  .enum([
    "run.created",
    "task.contract.created",
    "context.pack.created",
    "project.git.initialized",
    /** D-14 (INV-113): a thin `CLAUDE.md` bridge (`@AGENTS.md` import + ownership
     * marker) was created at the PROJECT root because it had `AGENTS.md` and no
     * `CLAUDE.md`, so a Claude Code route reads the same instructions codex/cursor
     * read natively. The ONE live-tree write this feature adds; exclusive-create +
     * no-follow, never overwriting a hand-written file, emitted only on an actual
     * create. Payload: {project_root, path, source}. */
    "project.claude_bridge.created",
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
    /** A7 differential probe: on a rotation-eligible failure the CURRENT
     * credential subject was probed (existing poller/doctor evidence only —
     * never a quota-spending mini-run) and found UNUSABLE (dead credential,
     * not spent quota). Payload: RouteCredentialUnusablePayload. */
    "route.profile.credential_unusable",
    /** Unified account model (D-U1): an unpinned run's pool selection — the
     * quota-aware pool of enabled+ready rows picked this account. */
    "route.account.pool_selected",
    /** Q1=A disclosed lane switch: the thread's bound account became
     * disabled/deleted/revoked/exhausted and the run moved to a pool sibling
     * (the vendor session starts fresh; continuity hydration is disclosed on
     * the turn). Never silent. */
    "route.account.lane_switch",
    /** Q3=A: the pool is empty or every ready row is exhausted. A null
     * fallback precedes the typed `credential_pool_exhausted` terminal
     * (waiting for the earliest reset is the default);
     * `fallback: "api_key_route"` means the EXPLICIT api_key preference opted
     * the run onto the typed PAID route (INV-061) — never silently under auto. */
    "route.account.pool_exhausted",
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
    /** Live message into a running attempt (`POST /v2/runs/:id/messages`).
     * `message.accepted` = daemon ADMISSION, journaled through a
     * failure-propagating append BEFORE any native dispatch (nothing is sent
     * when it cannot land). `message.delivered` = a correlated native
     * consumption event was observed. `message.refused` = a typed non-delivery
     * (`outcome` rejected | not_active | unsupported | delivery_unknown plus
     * `reason`). A native `accepted` verdict adds no row: it is the receipt the
     * route returns and replays under the same Idempotency-Key. Payload:
     * {message_id, attempt_id?, harness_id?, outcome?, reason?, live_input?,
     *  native_turn_id?, text_sha256, text_bytes, text, title}; the journaled
     * copy drops `text` (daemon journaled-run-events.ts), the per-run
     * events.jsonl keeps it, and the timeline shows it as the row detail. */
    "message.accepted",
    "message.delivered",
    "message.refused",
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
    /** Delegate was requested but known unavailable before harness startup, so
     * the run continued as an ordinary Agent with a durable warning. */
    "delegation.belt.degraded",
    "output.ready",
    "gate.started",
    "gate.completed",
    /** Reviewer-panel preflight disclosure (INV-105): a requested reviewer
     * knob the resolved panel could not honor was DROPPED instead of refused
     * (the auto panel's per-family `reviewerEfforts` map, which also rides
     * stored replay surfaces). Payload: {ignored_settings: string[]} — the
     * same disclosure channel harness.started uses (QA-070). */
    "review.preflight",
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
    /** Per-try receipt of a CONTINUED try: the in-run continuation ladder's
     * later tries and the first try of a `continueFrom` successor. Carrier,
     * cause, accounts, workspace, memory and this try's model attestation.
     * Payload: {harness_id, attempt_id, session_id, receipt:
     * RunContinuityReceipt}. */
    "run.continuity",
    /** A stopped run's isolated envelope was kept for continuation (custody
     * `retained`). Payload: {attempt_id, root, cause, bytes}. Released by
     * adoption (`continueFrom`), apply or the discard decision; never removed
     * automatically. */
    "workspace.retained",
  ])
  .describe(
    "Type of an append-only run event, covering run lifecycle, contract/context creation, budget, routing fallbacks, harness activity, interactions, gates, review, arbitration, work products, and control verbs.",
  );
export type RunEventType = z.infer<typeof RunEventType>;

/**
 * Typed receipt emitted only after a user-facing run artifact has materialized.
 * Terminal preparation consumes these receipts in event order; the schema is
 * intentionally strict so a malformed announcement cannot become presentation
 * authority by accident.
 */
export const OutputReadyPayload = z
  .object({
    kind: z
      .enum(["answer", "report", "plan", "summary", "patch", "structured_output", "artifact"])
      .describe("Kind of materialized output announced by this receipt."),
    path: z.string().min(1).describe("Run-relative path of the materialized output artifact."),
    state: z
      .enum(["ready", "diagnostic"])
      .default("ready")
      .describe("Whether the announced artifact is normal output or diagnostic output."),
  })
  .strict()
  .describe("Validated payload of an output.ready run event.");
export type OutputReadyPayload = z.infer<typeof OutputReadyPayload>;

/**
 * Typed payload for `route.profile.credential_unusable` (A7): the differential
 * probe's observation plus the attempt it fired in. The rotation module
 * validates this before stamping it onto the RunEvent payload, so the
 * unusable verdict is always evidence-backed — code, source, and expiry come
 * from the observation itself, never invented at emit time.
 */
export const RouteCredentialUnusablePayload = CredentialUnusableObservation.extend({
  attempt_id: z
    .string()
    .nullable()
    .default(null)
    .describe("Attempt whose rotation-eligible failure triggered the probe, when known."),
}).describe(
  "Typed payload for route.profile.credential_unusable: the differential probe's typed observation of a dead credential, validated before being stamped onto the RunEvent payload.",
);
export type RouteCredentialUnusablePayload = z.infer<typeof RouteCredentialUnusablePayload>;

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
