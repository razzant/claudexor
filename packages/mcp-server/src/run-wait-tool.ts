import { McpRunWaitInput } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/McpRunWaitInput.schema.json" with { type: "json" };
import resultSchema from "@claudexor/schema/generated/McpRunWaitResult.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

export function runWaitTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_wait",
    description:
      "Observe an existing durable run (or a queued job id) through bounded event replay. Defaults: afterSeq=0, waitMs=25000, maxEvents=50, wake=batch. Events already available at the snapshot fence are returned first, even while a question is pending. wake=batch then keeps collecting until the page fills, it includes a question event (also one written before the wait), the run ends, or waitMs elapses; wake=event returns as soon as any event is available. waitMs=0 returns only the already available page. A pending question whose event is not in the page never ends a wait by itself; it is always reported in pendingInteractions. Resume with nextSeq; snapshotSeq is a fence, and terminal is not the end of events, until a page with no events reports eventOmission stream_ended (the stream cannot serve the rest, such as a last line left unterminated by a crash): stop there. Pages are capped at 64 KiB of events, pending bodies at 32 KiB, results at 128 KiB (UTF-8 JSON); an event too large for any page is named in oversizedEvent: read it with claudexor_run_event_read, then resume with afterSeq set to its seq. Daemon discovery and each snapshot read have separate 5s budgets, so a call can take waitMs plus about 15s; size waitMs to your client's tool timeout. Timeout, disconnect and host abort close only this read, never the worker. Use claudexor_run_result for output and claudexor_run_interactions for omitted question bodies.",
    inputSchema: inlineJsonSchemaRefs(inputSchema),
    outputSchema: inlineJsonSchemaRefs(resultSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = McpRunWaitInput.parse(args);
        const result = await runner({ mode: "__run_wait", ...input }, { signal: ctx.signal });
        return {
          text: JSON.stringify(result),
          structured: result as Record<string, unknown>,
        };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
