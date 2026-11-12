import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { appendRunEvent } from "@claudexor/event-log";
import {
  ControlRunMessageRequest,
  ControlRunMessageResponse,
  type LiveMessageDelivery,
  type LiveMessageInput,
  type RunEventType,
} from "@claudexor/schema";
import { safeProblemMessage, sha256 } from "@claudexor/util";
import type { DaemonRunRecord } from "./run-record.js";
import { requiredIdempotencyKey } from "./run-start.js";
import { runIdempotentDelivery, type DeliveryCommandServices } from "./run-apply-routes.js";
import { TERMINAL_STATES } from "./sse-shared.js";

export interface RunMessageRouteContext {
  services?: DeliveryCommandServices & {
    sendRunMessage?: (input: LiveMessageInput) => Promise<LiveMessageDelivery>;
  };
  findRun(id: string): Promise<DaemonRunRecord | null>;
  readBody(req: IncomingMessage): Promise<unknown>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

/**
 * `POST /v2/runs/:id/messages` — a live message into a run's active attempt.
 *
 * HTTP carries only transport facts: 404 unknown run, 501 no service, 400
 * malformed/too-long body or missing Idempotency-Key, 409 idempotency
 * (conflict / in progress / interrupted after restart), 500 receipt-save
 * failure. EVERY typed outcome (delivered, accepted, rejected, not_active,
 * unsupported, delivery_unknown) is HTTP 200 — deliberately unlike the
 * answer/control routes — so the caller reads `outcome`, never the status.
 * The Idempotency-Key IS the message id; a replay returns the stored receipt.
 */
export async function handleRunMessageRoute(
  ctx: RunMessageRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const runMessageMatch = /^\/runs\/([^/]+)\/messages$/.exec(path);
  if (!(method === "POST" && runMessageMatch)) return false;
  const record = await ctx.findRun(decodeURIComponent(runMessageMatch[1] as string));
  if (!record) {
    ctx.json(res, 404, { error: "no such run" });
    return true;
  }
  const send = ctx.services?.sendRunMessage;
  if (!send) {
    ctx.json(res, 501, { error: "live messages are not supported by this engine build" });
    return true;
  }
  try {
    const key = requiredIdempotencyKey(req);
    const raw = await ctx.readBody(req);
    const body = ControlRunMessageRequest.parse(raw);
    const runId = record.runId ?? record.id;
    const deliver = (target: string) =>
      runIdempotentDelivery(ctx.services, {
        params: record.params,
        key,
        operation: "run.message",
        request: { runId: target, body },
        work: () => deliverLiveMessage(record, runId, key, body, send),
      });
    let receipt: ControlRunMessageResponse;
    try {
      receipt = await deliver(runId);
    } catch (error) {
      // A message sent while the job was still queued keeps its receipt under
      // the job id. Once the run binds, the same key and body replay it; any
      // other request under the key still conflicts.
      if (runId === record.id || (error as { code?: unknown })?.code !== "idempotency_conflict")
        throw error;
      receipt = await deliver(record.id);
    }
    ctx.json(res, 200, ControlRunMessageResponse.parse(receipt));
  } catch (error) {
    ctx.requestError(res, error);
  }
  return true;
}

/**
 * Journal-first admission (CONTRACT A23): the `message.accepted` row is
 * appended through the failure-PROPAGATING `appendRunEvent` (never the
 * swallowing audit helper) BEFORE the daemon service is called. If that append
 * throws, nothing is dispatched and the receipt is `rejected` /
 * `admission_persist_failed` (a new key is needed to try again). After the
 * adapter answers, `message.delivered` or `message.refused` closes the message
 * the same way; a row landing after the run's terminal commit is file-tail
 * stamped (durable, on the next timeline read; the live SSE push is missed).
 */
async function deliverLiveMessage(
  record: DaemonRunRecord,
  runId: string,
  messageId: string,
  body: ControlRunMessageRequest,
  send: (input: LiveMessageInput) => Promise<LiveMessageDelivery>,
): Promise<ControlRunMessageResponse> {
  const textBytes = Buffer.byteLength(body.text, "utf8");
  const digest = { message_id: messageId, text_sha256: sha256(body.text), text_bytes: textBytes };
  if (TERMINAL_STATES.has(record.state)) {
    return receiptFor(runId, messageId, {
      outcome: "not_active",
      reason: "run_terminal",
      message: `run ${runId} is ${record.state}; no live attempt can receive a message`,
    });
  }
  // An accepted job that has not bound its run yet exists, but nothing can
  // receive the message: nothing is journaled or sent.
  if (!record.runDir) {
    return receiptFor(runId, messageId, {
      outcome: "not_active",
      reason: "no_live_session",
      message: `job ${runId} is ${record.state} and has no live attempt yet; nothing was sent`,
    });
  }
  try {
    appendMessageRow(record, runId, "message.accepted", {
      ...digest,
      text: body.text,
      title: `Live message admitted (${textBytes} bytes)`,
    });
  } catch (error) {
    return receiptFor(runId, messageId, {
      outcome: "rejected",
      reason: "admission_persist_failed",
      message: `admission could not be journaled; nothing was sent: ${safeProblemMessage(error)}`,
    });
  }
  const delivery = await send({
    runId,
    text: body.text,
    ...(body.expectedAttemptId ? { expectedAttemptId: body.expectedAttemptId } : {}),
    messageId,
  });
  const closing: RunEventType | null =
    delivery.outcome === "delivered"
      ? "message.delivered"
      : delivery.outcome === "accepted"
        ? null
        : "message.refused";
  if (closing) {
    try {
      appendMessageRow(record, runId, closing, {
        ...digest,
        ...(delivery.attemptId ? { attempt_id: delivery.attemptId } : {}),
        ...(delivery.harnessId ? { harness_id: delivery.harnessId } : {}),
        outcome: delivery.outcome,
        ...(delivery.reason ? { reason: delivery.reason } : {}),
        ...(delivery.liveInput ? { live_input: delivery.liveInput } : {}),
        ...(delivery.nativeTurnId ? { native_turn_id: delivery.nativeTurnId } : {}),
        text: body.text,
        title:
          closing === "message.delivered"
            ? `Live message delivered (${textBytes} bytes)`
            : `Live message ${delivery.outcome}${delivery.reason ? ` (${delivery.reason})` : ""} (${textBytes} bytes)`,
      });
    } catch (error) {
      // The message may have landed; the durable receipt did not. Keep the
      // idempotency command failed (a replay reports this same 500) so no
      // caller resends under a new key on a "rejected" misreading.
      throw Object.assign(new Error("live message receipt could not be journaled"), {
        status: 500,
        code: "message_receipt_unavailable",
        cause: error,
      });
    }
  }
  return receiptFor(runId, messageId, delivery);
}

function appendMessageRow(
  record: DaemonRunRecord,
  runId: string,
  type: RunEventType,
  payload: Record<string, unknown>,
): void {
  appendRunEvent(
    join(record.runDir as string, "events.jsonl"),
    runId,
    record.taskId ?? "unknown",
    type,
    payload,
  );
}

function receiptFor(
  runId: string,
  messageId: string,
  delivery: LiveMessageDelivery,
): ControlRunMessageResponse {
  return ControlRunMessageResponse.parse({
    accepted: delivery.outcome === "delivered" || delivery.outcome === "accepted",
    outcome: delivery.outcome,
    ...(delivery.reason ? { reason: delivery.reason } : {}),
    runId,
    messageId,
    ...(delivery.attemptId ? { attemptId: delivery.attemptId } : {}),
    ...(delivery.harnessId ? { harnessId: delivery.harnessId } : {}),
    ...(delivery.liveInput ? { liveInput: delivery.liveInput } : {}),
    ...(delivery.nativeTurnId ? { nativeTurnId: delivery.nativeTurnId } : {}),
    ...(delivery.message ? { message: delivery.message } : {}),
  });
}
