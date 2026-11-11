import { RunTimeLimitRequest } from "@claudexor/schema";
import { mcpToolFailure } from "./tool-failure.js";
import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

export function runTimeLimitTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_time_limit",
    description:
      "Read, set, extend, or disable one live run's time limit. Mutations require the current expectedRevision from a read; a conflicting revision must be read again before retrying.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["runId", "action"],
      properties: {
        runId: { type: "string", minLength: 1 },
        action: { type: "string", enum: ["read", "set", "extend", "disable"] },
        seconds: { type: "integer", minimum: 1, maximum: 604800 },
        mode: {
          type: "string",
          enum: ["soft", "hard"],
          description: "For set only; omission keeps the timer's current mode.",
        },
        expectedRevision: { type: "integer", minimum: 0 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    handler: async (args) => {
      try {
        if (typeof args?.runId !== "string" || !args.runId.trim())
          throw new Error("runId is required");
        const { runId, ...rawRequest } = args;
        const request = RunTimeLimitRequest.parse(rawRequest);
        const result = await runner({ mode: "__run_time_limit", runId, request });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
