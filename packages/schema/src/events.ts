import { z } from "zod";
import { Id } from "./primitives.js";

export const RunEventType = z.enum([
  "run.created",
  "task.contract.created",
  "context.pack.created",
  "budget.lease.created",
  "budget.observation",
  "policy.web.upgraded",
  "harness.started",
  "harness.event",
  "harness.completed",
  "route.fallback.started",
  "route.fallback.completed",
  "route.fallback.exhausted",
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
  ts: z.string(),
  run_id: Id,
  task_id: Id,
  type: RunEventType,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type RunEvent = z.infer<typeof RunEvent>;
