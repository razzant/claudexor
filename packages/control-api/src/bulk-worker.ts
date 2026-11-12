import { lastRunEventSeq } from "@claudexor/event-log";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { ControlRunSummary, Id } from "@claudexor/schema";
import { redactSecrets } from "@claudexor/util";
import { readArtifact } from "./artifact-read.js";
import { readEventReplayBatch } from "./event-replay-batch.js";
import { detailFor, summarizeRun } from "./run-projection.js";
import { validRunOperatorDecision } from "./run-apply-projection.js";
import { inRunProjection } from "./projection-context.js";
import { prepareInterruptedOutput } from "./retained-output.js";
import { routeHealthFactsOf } from "./route-health-facts.js";
import { summaryFingerprint } from "./run-list-fingerprint.js";
import { paramsRecord, type DaemonRunRecord } from "./run-record.js";
import {
  BULK_WORKER_ROLE,
  type BulkJob,
  type BulkResults,
  type BulkKind,
  type WorkerRequest,
  type WorkerReply,
  type BulkFailure,
} from "./bulk-protocol.js";

function summaryOrDiagnostic(record: DaemonRunRecord): ControlRunSummary {
  try {
    return summarizeRun(record);
  } catch (error) {
    return diagnosticSummary(record, error);
  }
}

function diagnosticSummary(record: DaemonRunRecord, error: unknown): ControlRunSummary {
  const parent = Id.safeParse(paramsRecord(record)["delegatedFromRunId"]);
  return ControlRunSummary.parse({
    jobId: record.id,
    runId: record.runId ?? record.id,
    ...(parent.success ? { delegatedFromRunId: parent.data } : {}),
    state: "failed",
    error: redactSecrets(
      `unprojectable job record: ${error instanceof Error ? error.message : String(error)}`,
    ),
  });
}

/** One context spans parent, children and the exact digest. No live service crosses the port. */
export function projectBulkJob(
  job: BulkJob,
  publish: (bytes: Uint8Array) => Promise<string | null>,
): Promise<BulkResults[BulkKind]> {
  return inRunProjection(async () => {
    switch (job.kind) {
      case "cursor":
        return lastRunEventSeq(job.input.path);
      case "artifact":
        return readArtifact(job.input);
      case "event-replay":
        return readEventReplayBatch(job.input);
      case "route-facts":
        return routeHealthFactsOf(job.input.record);
      case "summary": {
        const { record, cached } = job.input;
        try {
          const fingerprint = summaryFingerprint(record, cached?.fingerprint);
          return {
            fingerprint,
            summary:
              cached?.fingerprint.value === fingerprint.value
                ? cached.summary
                : summarizeRun(record),
          };
        } catch (error) {
          // A failed fingerprint/projection is per-record evidence, never a cache entry.
          return { summary: diagnosticSummary(record, error) };
        }
      }
      case "detail": {
        const { record, pending, cursor, operator, children, deferred } = job.input;
        const text = prepareInterruptedOutput(record);
        const problem = text === null ? null : await publish(new TextEncoder().encode(text));
        const detail = detailFor(
          record,
          pending,
          cursor,
          validRunOperatorDecision(record, operator),
          children.map(({ record: child, attention }) => ({
            ...summaryOrDiagnostic(child),
            ...attention,
          })),
          problem,
        );
        return JSON.stringify({
          ...detail,
          ...(deferred === undefined ? {} : { deferredMessage: deferred }),
        });
      }
    }
  });
}

const port = parentPort;
if (!isMainThread && port && workerData?.role === BULK_WORKER_ROLE) {
  const publications = new Map<number, (problem: string | null) => void>();
  port.on("message", async (message: WorkerRequest) => {
    if (message.type === "published") {
      publications.get(message.id)?.(message.problem);
      publications.delete(message.id);
      return;
    }
    const start = performance.now();
    const queueMs = Math.max(0, performance.timeOrigin + start - message.enqueuedAt);
    const publish = (bytes: Uint8Array) =>
      new Promise<string | null>((resolve) => {
        publications.set(message.id, resolve);
        port.postMessage(
          { type: "publish-retained", id: message.id, bytes } satisfies WorkerReply,
          [bytes.buffer as ArrayBuffer],
        );
      });
    try {
      const value = await projectBulkJob(message.job, publish);
      const transfer =
        message.job.kind === "artifact" &&
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "body"
          ? [(value.body as Uint8Array).buffer as ArrayBuffer]
          : [];
      port.postMessage(
        {
          type: "result",
          id: message.id,
          value,
          queueMs,
          projectionMs: performance.now() - start,
        } satisfies WorkerReply,
        transfer,
      );
    } catch (thrown) {
      const error = thrown as Partial<BulkFailure>;
      port.postMessage({
        type: "failed",
        id: message.id,
        queueMs,
        projectionMs: performance.now() - start,
        error: {
          message: redactSecrets(error?.message ?? String(thrown)),
          code: error?.code,
          status: error?.status,
          retryable: error?.retryable,
          requiredActions: error?.requiredActions,
          evidenceRefs: error?.evidenceRefs,
        },
      } satisfies WorkerReply);
    }
  });
}
