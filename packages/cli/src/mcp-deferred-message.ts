import { CONTINUATION_INHERITED_KEYS } from "@claudexor/control-api";
import {
  DEFERRED_MESSAGE_CONTROL_KEYS,
  DeferredMessageCall,
  DeferredMessageDetail,
  DeferredMessageProjection,
  DeferredMessageReceipt,
  DeferredMessageReadInput,
  DeferredMessageReadResult,
  type DeferredMessageCapturedControls,
} from "@claudexor/schema";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { controlProblemError } from "./cli-error.js";
import { daemonUnavailableError } from "./mcp-daemon-unavailable.js";

/** Operator-only forwarding; no daemon startup, current-directory registration,
 * control capture or scheduling authority lives in this surface. */
export async function deferredMessageQuery(
  input: Record<string, unknown>,
  beltContext = false,
  signal?: AbortSignal,
) {
  if (beltContext || input.delegatedFromRunId !== undefined || input.beltContext === true)
    throw Object.assign(new Error("the delegation belt cannot control deferred messages"), {
      code: "delegation_forbidden",
      status: 403,
    });
  const { mode, ...raw } = input;
  const read = mode === "__next_message_read";
  const request = read ? DeferredMessageReadInput.parse(raw) : DeferredMessageCall.parse(raw);
  const connection = await connectDaemonIfRunning();
  if (!connection) throw daemonUnavailableError(false, "deferred messages do not start one");
  const path = read
    ? `/runs/next-message/${encodeURIComponent((request as { draftId: string }).draftId)}`
    : "/runs/next-message";
  const call = read ? null : DeferredMessageCall.parse(request);
  const response = await controlApiFetch(
    connection.addr,
    path,
    read
      ? { method: "GET", signal }
      : {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", "Idempotency-Key": call!.idempotencyKey },
          body: JSON.stringify(call!.request),
        },
  );
  const body: unknown = await response.json();
  if (!response.ok)
    throw controlProblemError(
      response.status,
      body,
      `deferred message failed (HTTP ${response.status})`,
    );
  return read
    ? boundedDeferredMessage(DeferredMessageDetail.parse(body))
    : DeferredMessageReceipt.parse(body);
}

export function boundedDeferredMessage(detail: DeferredMessageDetail): DeferredMessageReadResult {
  const bytes = Buffer.from(detail.prompt);
  // Decode only complete UTF-8 code points; an omitted suffix is disclosed.
  let end = Math.min(bytes.length, 4096);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return DeferredMessageReadResult.parse({
    draft: DeferredMessageProjection.strip().parse(detail),
    promptPreview: bytes.subarray(0, end).toString("utf8"),
    promptBytes: bytes.length,
    omittedPromptBytes: bytes.length - end,
    attachments: detail.attachments.slice(0, 32),
    omittedAttachments: Math.max(0, detail.attachments.length - 32),
    controls: capturedControls(detail),
    detailPath: `/v2/runs/next-message/${encodeURIComponent(detail.draftId)}`,
  });
}

/** The frozen values by origin, from fixed key lists: bounded, never re-resolved. */
function capturedControls(detail: DeferredMessageDetail): DeferredMessageCapturedControls | null {
  const captured = detail.capturedStart as Record<string, unknown> | null;
  if (!captured || !detail.capturedAt) return null;
  const pick = (keys: readonly string[]) =>
    Object.fromEntries(
      keys.filter((key) => captured[key] !== undefined).map((key) => [key, captured[key]]),
    );
  return {
    capturedAt: detail.capturedAt,
    inherited: pick(CONTINUATION_INHERITED_KEYS),
    resolved: pick([...DEFERRED_MESSAGE_CONTROL_KEYS, "routingGoal"]),
    settings: detail.capturedStart?.deferredDefaults ?? null,
  };
}
