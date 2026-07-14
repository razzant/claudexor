import { z } from "zod";
import { Id } from "./primitives.js";

// Staged-field rule: the enum ships only kinds runs actually PRODUCE
// (patch / new_repo / report). Delivery-as-branch/commit/pr is a different,
// fully-consumed vocabulary (`ControlApplyRequest.mode`) — those values were
// never work-product kinds with a producer, so they do not live here.
export const WorkProductKind = z
  .enum(["patch", "new_repo", "report"])
  .describe(
    "Kind of work product a run produces: a patch against the base tree, a newly created repository, or a report document.",
  );
export type WorkProductKind = z.infer<typeof WorkProductKind>;

export const WorkProduct = z
  .object({
    id: Id.describe("Work product id."),
    kind: WorkProductKind,
    source_task_id: Id.describe("Task the work product came from."),
    producer_attempt_id: Id.optional().describe("Attempt that produced it, when known."),
    evidence_dir: z.string().optional().describe("Directory holding run evidence artifacts."),
    /** Kind-specific payload (validated loosely here; specialized per kind by callers). */
    files: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Kind-specific file payload, e.g. artifact name to path (validated loosely here; specialized per kind by callers).",
      ),
    meta: z.record(z.string(), z.unknown()).default({}).describe("Kind-specific metadata."),
  })
  .describe(
    "The deliverable a run produced (patch, new repo, or report), referenced by apply/delivery verbs.",
  );
export type WorkProduct = z.infer<typeof WorkProduct>;
