import { z } from "zod";
import { Id } from "./primitives.js";

export const RunEventType = z.enum([
  "run.created",
  "task.contract.created",
  "context.pack.created",
  "budget.lease.created",
  "budget.observation",
  "harness.started",
  "harness.event",
  "harness.completed",
  "gate.started",
  "gate.completed",
  "review.started",
  "review.finding.proposed",
  "finding.revalidated",
  "synthesis.started",
  "arbitration.completed",
  "work_product.emitted",
  "control.requested",
  "control.applied",
  "control.rejected",
  "input.requested",
  "input.received",
  "input.forwarded",
  "run.blocked",
  "run.unblocked",
  "run.successor_created",
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
