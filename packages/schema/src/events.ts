import { z } from "zod";
import { FallbackReason, Id } from "./primitives.js";
import { AuthMode } from "./budget.js";

export const RunEventType = z.enum([
  "run.created",
  "task.contract.created",
  "context.pack.created",
  "project.git.initialized",
  "budget.lease.created",
  "budget.observation",
  "policy.web.upgraded",
  "harness.started",
  "harness.event",
  "harness.completed",
  "route.fallback.started",
  "route.fallback.completed",
  "route.fallback.exhausted",
  "route.transient.detected",
  "route.transient.retry_scheduled",
  "route.transient.exhausted",
  /** A subscription->API (or harness->harness) auth switch driven by a typed
   * quota/money signal. Distinct from a plain harness rotation; never silent. */
  "route.fallback.auth_switched",
  /** A thread re-hosted onto a different harness; payload is SessionReboundLineage. */
  "session.rebound",
  "interaction.requested",
  "interaction.answered",
  "interaction.timeout",
  "output.ready",
  "gate.started",
  "gate.completed",
  "review.started",
  "reviewer.started",
  "reviewer.first_event",
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
  /** Orchestrate executor (auto_safe/auto_full): a SAFE plan step spawned an
   * isolated envelope sub-run. Payload: {tool, mode, n}. */
  "orchestrate.subrun.started",
  /** Orchestrate executor: a plan step completed. Payload: {index, tool, status/ok, run_id}. */
  "orchestrate.step.done",
  /** Orchestrate executor: a RISKY plan step (apply) was blocked under auto_safe
   * (not executed; awaiting a human decision). Payload: {index, tool, autonomy}. */
  "orchestrate.step.blocked",
  "control.requested",
  "control.applied",
  "control.rejected",
  "run.blocked",
  "run.completed",
  "run.failed",
]);
export type RunEventType = z.infer<typeof RunEventType>;

/**
 * Typed payload for `route.fallback.*` events. The orchestrator validates this
 * before stamping it onto the (otherwise free-form) RunEvent.payload, so a
 * fallback/auth-switch is always evidence-backed and surfaced as a warning,
 * never an invisible info line.
 */
export const RouteFallbackPayload = z.object({
  from_harness: z.string().nullable().default(null),
  to_harness: z.string().nullable().default(null),
  from_auth_mode: AuthMode.default("unknown"),
  to_auth_mode: AuthMode.default("unknown"),
  reason: FallbackReason.default("manual"),
  attempt_id: z.string().nullable().default(null),
  error_summary: z.string().nullable().default(null),
});
export type RouteFallbackPayload = z.infer<typeof RouteFallbackPayload>;

/** Append-only event record (one JSONL line). */
export const RunEvent = z.object({
  /**
   * Monotonic per-run sequence stamped by the EventLog at emit time. It is the
   * durable SSE cursor (Last-Event-ID) and the snapshot fence (detail.lastSeq).
   * Optional only for pre-v0.8.0 artifacts; every new emit carries it.
   */
  seq: z.number().int().positive().optional(),
  ts: z.string(),
  run_id: Id,
  task_id: Id,
  /** Thread this run is a turn of, when any. Lets the global event multiplex
   * route live progress to a chat surface without a reverse job lookup. */
  thread_id: Id.optional(),
  type: RunEventType,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEvent>;
