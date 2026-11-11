import { RunWaitManyInput } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/RunWaitManyInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/RunWaitManyResult.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

export function runsWaitTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_runs_wait",
    description:
      "Observe lifecycle and pending attention from 1..1000 existing durable job/run handles in one read. targets contains {runId, seen?}; waitMs defaults to 25000 (0..50000). Echo each summary token as that target's seen to suppress unchanged terminal/question attention; tokens are not event cursors or answers. Returns ascending attention indexes and compact summaries in input order, including duplicates and explicit unknowns, within 128 KiB of logical JSON. includeBlocking=true adds blocking to each summary with pending questions: false only when every one is async and the agent keeps working. waitMs=0 reads once; timeout never retries. Discovery adds up to 5s and HTTP adds up to waitMs+5s (total waitMs+10s). Host abort closes only observation; discovery's read-only handshake may settle in the background. Requires an existing supporting daemon; never starts one or a worker. Terminal lifecycle is not output readiness: use claudexor_run_result for output and claudexor_run_interactions for question bodies.",
    inputSchema: inlineJsonSchemaRefs(inputSchema),
    outputSchema: inlineJsonSchemaRefs(resultSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = RunWaitManyInput.parse(args);
        const result = await runner(
          {
            mode: "__runs_wait",
            targets: input.targets,
            ...(args["waitMs"] === undefined ? {} : { waitMs: input.waitMs }),
            ...(input.includeBlocking ? { includeBlocking: true } : {}),
          },
          { signal: ctx.signal },
        );
        return { text: JSON.stringify(result), structured: result as Record<string, unknown> };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
