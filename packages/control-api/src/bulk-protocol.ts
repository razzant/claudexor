import type {
  ControlPendingInteraction,
  ControlRunSummary,
  DeferredMessageProjection,
} from "@claudexor/schema";
import type { ArtifactReadRequest, ArtifactReadResult } from "./artifact-read.js";
import type { EventReplayRequest, EventReplayResult } from "./event-replay-batch.js";
import type { ControlOperatorDecisionRecord, DaemonRunRecord } from "./run-record.js";
import type { RunListFingerprint } from "./run-list-fingerprint.js";
import type { RouteHealthFacts } from "./route-health-facts.js";

export const BULK_WORKER_ROLE = "claudexor-control-bulk";
export interface SummarySnapshot {
  fingerprint: RunListFingerprint;
  summary: ControlRunSummary;
}
export interface DetailRead {
  record: DaemonRunRecord;
  cursor: number;
  pending: ControlPendingInteraction[];
  operator: ControlOperatorDecisionRecord | null;
  /** Each child's question attention, derived by pendingQuestionAttention. */
  children: {
    record: DaemonRunRecord;
    attention: { waitingOnUser: boolean; asyncQuestionsOnly: boolean };
  }[];
  deferred?: DeferredMessageProjection | null;
}
export interface BulkInputs {
  cursor: { path: string };
  detail: DetailRead;
  summary: { record: DaemonRunRecord; cached?: SummarySnapshot };
  "event-replay": EventReplayRequest;
  artifact: ArtifactReadRequest;
  "route-facts": { record: DaemonRunRecord };
}
export interface BulkResults {
  cursor: number;
  detail: string;
  summary: SummarySnapshot | { summary: ControlRunSummary };
  "event-replay": EventReplayResult;
  artifact: ArtifactReadResult;
  "route-facts": RouteHealthFacts;
}
export type BulkKind = keyof BulkInputs;
export type BulkJob<K extends BulkKind = BulkKind> = {
  [P in K]: { kind: P; input: BulkInputs[P] };
}[K];
export type BulkFailure = {
  message: string;
  code?: string;
  status?: number;
  retryable?: boolean;
  requiredActions?: string[];
  evidenceRefs?: string[];
};
export type WorkerReply =
  | {
      type: "result";
      id: number;
      value: BulkResults[BulkKind];
      queueMs: number;
      projectionMs: number;
    }
  | { type: "failed"; id: number; error: BulkFailure; queueMs: number; projectionMs: number }
  | { type: "publish-retained"; id: number; bytes: Uint8Array };
export type WorkerRequest =
  | { type: "run"; id: number; enqueuedAt: number; job: BulkJob }
  | { type: "published"; id: number; problem: string | null };
