import { z } from "zod/v3";
import { Id } from "./primitives.js";

// Staged-field rule: the enum ships only kinds runs actually PRODUCE
// (patch / new_repo / report / files). Delivery-as-branch/commit/pr is a different,
// fully-consumed vocabulary (`ControlApplyRequest.mode`) — those values were
// never work-product kinds with a producer, so they do not live here.
export const WorkProductKind = z
  .enum(["patch", "new_repo", "report", "files"])
  .describe(
    "Kind of work product: Git patch, new repository, report, or complete directory file manifest with retained bytes.",
  );
export type WorkProductKind = z.infer<typeof WorkProductKind>;

export const WorkProduct = z
  .object({
    id: Id.describe("Work product id."),
    kind: WorkProductKind,
    source_task_id: Id.describe("Task the work product came from."),
    producer_attempt_id: Id.optional().describe("Attempt that produced it, when known."),
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
    "The deliverable a run produced, referenced by apply/delivery verbs; files uses files.manifest and meta.manifest_sha256.",
  );
export type WorkProduct = z.infer<typeof WorkProduct>;
