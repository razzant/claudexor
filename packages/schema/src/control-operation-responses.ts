import { z } from "zod";
import {
  ControlArtifactInfo,
  ControlQueuedRunInfo,
  ControlRunStartInfo,
  ControlRunStartRequest,
  ControlRunSummary,
} from "./control.js";
import { Id } from "./primitives.js";
import { DeliveryReceipt } from "./delivery.js";

export const ControlRunStartResponse = z
  .union([ControlRunStartInfo, ControlQueuedRunInfo])
  .describe("Immediate or queued durable handle returned by POST /runs.");
export type ControlRunStartResponse = z.infer<typeof ControlRunStartResponse>;

export const ControlRunListResponse = z
  .object({
    runs: z.array(ControlRunSummary).default([]),
    /** QA-052 keyset page cursor: opaque `(createdAt,id)` token to fetch the
     * next (older) page. Null when this page is the tail — no further runs match
     * the current filter. Feed it back verbatim as the `cursor` query param. */
    nextCursor: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Opaque keyset cursor for the next (older) page under the current filter; null on the final page. Pass verbatim as the `cursor` query param.",
      ),
    /** True when at least one further run matches the current filter beyond this
     * page. A consumer keeps paging while this is true, never inferring the tail
     * from a short page. */
    hasMore: z
      .boolean()
      .default(false)
      .describe("True when more matching runs exist beyond this page."),
  })
  .strict()
  .describe(
    "A bounded, newest-first, keyset-paginated page of durable run summaries visible to the daemon (QA-052).",
  );
export type ControlRunListResponse = z.infer<typeof ControlRunListResponse>;

export const ControlArtifactListResponse = z
  .object({ runId: Id, artifacts: z.array(ControlArtifactInfo).default([]) })
  .strict()
  .describe("Run-keyed technical artifact or produced-output listing.");
export type ControlArtifactListResponse = z.infer<typeof ControlArtifactListResponse>;

export const ControlProjectOutputsResponse = z
  .object({ projectId: Id, artifacts: z.array(ControlArtifactInfo).default([]) })
  .strict()
  .describe(
    "Project-keyed durable outputs listing (GET /projects/:id/outputs): the files under the project's artifacts/ directory, server-owned and path-traversal-safe.",
  );
export type ControlProjectOutputsResponse = z.infer<typeof ControlProjectOutputsResponse>;

export const ControlApplyCheckResponse = z
  .object({
    ok: z.boolean(),
    code: z.number().int().nullable(),
    stderr: z.string(),
    /** #26: TRUE when `ok` is a typed already-applied no-op (the run is
     * delivered and the tree is this patch's exact postimage) rather than a
     * fresh clean forward check. Lets a dry-run consumer distinguish "would
     * apply cleanly" from "already applied; nothing would change". Defaults
     * false. */
    alreadyApplied: z
      .boolean()
      .default(false)
      .describe("True when the clean check is an already-applied idempotent no-op."),
  })
  .strict()
  .describe("Mechanical git apply --check result.");
export type ControlApplyCheckResponse = z.infer<typeof ControlApplyCheckResponse>;

export const ControlDeliveryResponse = DeliveryReceipt.describe(
  "Result of a manual run delivery attempt.",
);
export type ControlDeliveryResponse = z.infer<typeof ControlDeliveryResponse>;

export const ControlThreadTurnRequest = ControlRunStartRequest.omit({
  scope: true,
  execution: true,
  threadId: true,
  turnId: true,
  parentRunId: true,
  retryOf: true,
})
  .extend({
    /** Implement-plan only: explicitly proceed although the plan still has
     * open questions (D17). Recorded on the turn for provenance. */
    overridePlanReadiness: z
      .boolean()
      .optional()
      .describe("Implement a not-ready plan anyway; recorded on the turn."),
  })
  .describe("Client-settable thread-turn request; scope, execution and lineage are server-owned.");
export type ControlThreadTurnRequest = z.infer<typeof ControlThreadTurnRequest>;

export const ControlThreadTurnResponse = z
  .union([
    ControlRunStartInfo.extend({ threadId: Id, turnId: Id }),
    z.object({ jobId: Id, threadId: Id, turnId: Id, state: z.string().min(1) }).strict(),
  ])
  .describe("Durable handle returned by thread turn create or Exact Retry.");
export type ControlThreadTurnResponse = z.infer<typeof ControlThreadTurnResponse>;
