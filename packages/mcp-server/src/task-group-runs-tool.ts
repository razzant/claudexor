import { TaskGroupRunsInput, TaskGroupRunsResult } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/TaskGroupRunsInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/TaskGroupRunsResult.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

export function taskGroupRunsTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_task_group_runs",
    description:
      "Read exactly one retained task group page by caller UUID, optionally checking expectedStoreId. limit is 1..200 (default 50); state filters lifecycle; cursor (at most 2048 characters) is bound to group/filter/store/current served generations. The logical result is at most 131072 UTF-8 bytes and may return fewer members; resume only with nextCursor. Retained-only/current-served qualifiers are not a permanent roster or proof of submission. Job handles remain canonical while runId is null until binding. Explicit unavailable observations are unknown. Requires an existing supporting daemon; discovery and HTTP reads each allow up to 5s. Host cancellation closes only the read. Never launches, retries, resumes, cancels or answers work. Lifecycle is not output readiness; use addressed result/interactions tools for bodies.",
    inputSchema: inlineJsonSchemaRefs(inputSchema),
    outputSchema: inlineJsonSchemaRefs(resultSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = TaskGroupRunsInput.parse(args);
        const raw = await runner({ mode: "__task_group_runs", ...input }, { signal: ctx.signal });
        const parsed = TaskGroupRunsResult.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.taskGroupId !== input.taskGroupId ||
          parsed.data.members.length > input.limit ||
          (input.expectedStoreId !== undefined && parsed.data.storeId !== input.expectedStoreId)
        )
          throw Object.assign(new Error("invalid retained task group service response"), {
            code: "invalid_service_response",
            status: 500,
            retryable: false,
          });
        return { text: JSON.stringify(parsed.data), structured: parsed.data };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
