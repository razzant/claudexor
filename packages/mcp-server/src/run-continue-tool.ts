import mcpRunToolResultSchemaRaw from "@claudexor/schema/generated/McpRunToolResult.schema.json" with { type: "json" };
import { ContinueCarrierPreference } from "@claudexor/schema";
import { mcpToolFailure } from "./tool-failure.js";
import { attachmentRefsSchema } from "./attachment-ref-schema.js";
import { formatRunResult, structuredRunResult } from "./run-result-format.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import {
  accessAndLimitProperties,
  effortProperties,
  externalContextProperties,
  reviewProperties,
  taskGroupProperties,
} from "./run-control-properties.js";
import type { McpTool, RunnerFn } from "./index.js";

const outputSchema = inlineJsonSchemaRefs(mcpRunToolResultSchemaRaw as Record<string, unknown>);

/** Continuation admission, history, workspace custody and inheritance belong to the daemon. */
export function runContinueTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_continue",
    description:
      "Start one successor of a terminal single-candidate Agent or Ask run on the existing daemon. The daemon inherits only mode, scope, execution, harness, model and the prompt-cache lifetime, which this tool cannot change (another lifetime, Default included, needs a new run); every other omitted control takes its ordinary new-run default, not the predecessor's value, so restate access, web, account, effort, budget, time limit and review when the successor must keep them. Budget and time limits apply to this successor alone, never as a remainder of the chain. prompt is optional and may be empty. Supply idempotencyKey to replay an unknown response. Returns the same durable handle as the launch tools (jobId, runId once bound); pass either as runId to claudexor_run_wait/status/result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId"],
      properties: {
        runId: { type: "string", minLength: 1, pattern: "\\S" },
        prompt: { type: "string", description: "Optional continuation text; empty is valid." },
        attachments: attachmentRefsSchema,
        idempotencyKey: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "\\S",
          description: "Reuse the same key and arguments after an unknown response.",
        },
        ...effortProperties(),
        ...externalContextProperties(),
        ...taskGroupProperties(),
        ...accessAndLimitProperties(),
        ...reviewProperties(),
        continueCarrier: {
          type: "string",
          enum: ContinueCarrierPreference.options,
          description: ContinueCarrierPreference.description,
        },
      },
    },
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args) => {
      try {
        const result = await runner({ ...args, mode: "__run_continue" });
        return { text: formatRunResult(result), structured: structuredRunResult(result) };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
