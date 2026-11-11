import { ControlRunMessageRequest, ControlRunMessageResponse } from "@claudexor/schema";
import requestSchemaRaw from "@claudexor/schema/generated/ControlRunMessageRequest.schema.json" with { type: "json" };
import responseSchemaRaw from "@claudexor/schema/generated/ControlRunMessageResponse.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

const requestSchema = inlineJsonSchemaRefs(requestSchemaRaw);
const responseSchema = inlineJsonSchemaRefs(responseSchemaRaw);
const receiptProperties = responseSchema.properties as Record<string, unknown>;

/** One caller-addressed submission; admission and delivery remain daemon-owned. */
export function runMessageTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_message",
    description:
      "Send a live message to an existing run's active attempt. Requires an explicit stable caller idempotencyKey (the message id); reuse the same key and body to read its recorded receipt. accepted proves native acceptance only (a later live_input_delivered harness event with the same message_id, seen through claudexor_run_wait, reports consumption), delivered proves observed consumption, neither proves obedience. delivery_unknown may have landed: never resend it under a new key. Refusals remain typed outcomes: a pending blocking question answers not_active/interaction_pending (an async question, during which the worker keeps going, does not refuse it; a message never answers a question: use claudexor_answer_interaction), a still-queued job not_active/no_live_session. not_active sent nothing, so a later attempt needs a new key. No automatic retry, queue, or relaunch; host cancellation stops only this request.",
    inputSchema: {
      ...requestSchema,
      required: ["runId", "text", "idempotencyKey"],
      properties: {
        ...(requestSchema.properties as Record<string, unknown>),
        runId: receiptProperties.runId,
        idempotencyKey: {
          ...(receiptProperties.messageId as Record<string, unknown>),
          pattern: "\\S",
        },
      },
    },
    outputSchema: responseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const { runId, idempotencyKey, ...body } = args ?? {};
        const target = ControlRunMessageResponse.shape.runId.parse(runId);
        const key = ControlRunMessageResponse.shape.messageId.trim().min(1).parse(idempotencyKey);
        const request = ControlRunMessageRequest.parse(body);
        const receipt = ControlRunMessageResponse.parse(
          await runner(
            { mode: "__run_message", runId: target, idempotencyKey: key, request },
            ctx.signal ? { signal: ctx.signal } : {},
          ),
        );
        return { text: JSON.stringify(receipt), structured: receipt };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
