import { z } from "zod";
import { Id } from "./primitives.js";

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
  "control.requested",
  "control.applied",
  "control.rejected",
  "run.blocked",
  "run.completed",
  "run.failed",
]);
export type RunEventType = z.infer<typeof RunEventType>;

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
  type: RunEventType,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEvent>;
