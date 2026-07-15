import { z } from "zod";
import {
  ControlArtifactInfo,
  ControlQueuedRunInfo,
  ControlRunStartInfo,
  ControlRunStartRequest,
  ControlRunSummary,
} from "./control.js";
import { Id } from "./primitives.js";
import { FinalVerifyRecord } from "./decision.js";

export const ControlRunStartResponse = z
  .union([ControlRunStartInfo, ControlQueuedRunInfo])
  .describe("Immediate or queued durable handle returned by POST /runs.");
export type ControlRunStartResponse = z.infer<typeof ControlRunStartResponse>;

export const ControlRunListResponse = z
  .object({ runs: z.array(ControlRunSummary).default([]) })
  .strict()
  .describe("All durable run summaries visible to the daemon.");
export type ControlRunListResponse = z.infer<typeof ControlRunListResponse>;

export const ControlArtifactListResponse = z
  .object({ runId: Id, artifacts: z.array(ControlArtifactInfo).default([]) })
  .strict()
  .describe("Run-keyed technical artifact or produced-output listing.");
export type ControlArtifactListResponse = z.infer<typeof ControlArtifactListResponse>;

export const ControlApplyCheckResponse = z
  .object({ ok: z.boolean(), code: z.number().int().nullable(), stderr: z.string() })
  .strict()
  .describe("Mechanical git apply --check result.");
export type ControlApplyCheckResponse = z.infer<typeof ControlApplyCheckResponse>;

export const ControlDeliveryResponse = z
  .object({
    mode: z.enum(["artifact_only", "apply", "branch", "commit", "pr"]),
    applied: z.boolean(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    prUrl: z.string().optional(),
    detail: z.string().optional(),
    treeMutated: z.boolean().optional(),
    finalVerify: FinalVerifyRecord.describe("Fresh verifier evidence for this delivery attempt."),
    targetPreimageSha: z.string().describe("Target snapshot verified immediately before delivery."),
  })
  .strict()
  .describe("Result of a manual run delivery attempt.");
export type ControlDeliveryResponse = z.infer<typeof ControlDeliveryResponse>;

export const ControlThreadTurnRequest = ControlRunStartRequest.omit({
  scope: true,
  execution: true,
  threadId: true,
  turnId: true,
  parentRunId: true,
  retryOf: true,
}).describe("Client-settable thread-turn request; scope, execution and lineage are server-owned.");
export type ControlThreadTurnRequest = z.infer<typeof ControlThreadTurnRequest>;

export const ControlThreadTurnResponse = z
  .union([
    ControlRunStartInfo.extend({ threadId: Id, turnId: Id }),
    z.object({ jobId: Id, threadId: Id, turnId: Id, state: z.string().min(1) }).strict(),
  ])
  .describe("Durable handle returned by thread turn create or Exact Retry.");
export type ControlThreadTurnResponse = z.infer<typeof ControlThreadTurnResponse>;
