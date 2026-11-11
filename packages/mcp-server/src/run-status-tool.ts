import { formatRunResult } from "./run-result-format.js";
import type { McpTool, RunnerFn } from "./index.js";

/** Existing snapshot read, extracted to keep registration below its size ratchet. */
export function runStatusTool(
  runner: RunnerFn,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
): McpTool {
  return {
    name: "claudexor_run_status",
    description: "Read the current daemon-acknowledged state of a durable Claudexor run.",
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const result = await runner({ mode: "__run_status", runId: String(args?.runId ?? "") });
      return {
        text: formatRunResult(result),
        structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
      };
    },
  };
}
