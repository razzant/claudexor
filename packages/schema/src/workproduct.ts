import { z } from "zod";
import { Id } from "./primitives.js";

// Staged-field rule: the enum ships only kinds runs actually PRODUCE
// (patch / new_repo / report). Delivery-as-branch/commit/pr is a different,
// fully-consumed vocabulary (`ControlApplyRequest.mode`) — those values were
// never work-product kinds with a producer, so they do not live here.
export const WorkProductKind = z.enum(["patch", "new_repo", "report"]);
export type WorkProductKind = z.infer<typeof WorkProductKind>;

export const WorkProduct = z.object({
  id: Id,
  kind: WorkProductKind,
  source_task_id: Id,
  producer_attempt_id: Id.optional(),
  evidence_dir: z.string().optional(),
  /** Kind-specific payload (validated loosely here; specialized per kind by callers). */
  files: z.record(z.string(), z.string()).default({}),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type WorkProduct = z.infer<typeof WorkProduct>;
