import { ControlRunEventPart, McpRunEventReadInput } from "@claudexor/schema";
import inputSchema from "@claudexor/schema/generated/McpRunEventReadInput.schema.json" with { type: "json" };
import partSchema from "@claudexor/schema/generated/ControlRunEventPart.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

/**
 * Text mirror: one header line with every range fact, then the part verbatim,
 * so a text-only client can reassemble the exact bytes too.
 */
function partText(part: ControlRunEventPart): string {
  const range = `bytes ${part.offset}-${part.nextOffset} of ${part.totalBytes}`;
  const next =
    part.nextOffset < part.totalBytes
      ? `incomplete: read again with offset ${part.nextOffset}`
      : `complete: verify sha256, parse the concatenated parts as one JSON event, then call claudexor_run_wait with afterSeq ${part.seq}`;
  return `event ${part.seq} (${part.type}) of run ${part.runId}, ${range}, sha256 ${part.sha256}; ${next}\n${part.text}`;
}

/** Bounded part reads of one event the wait page could not hold; no path or log access. */
export function runEventReadTool(runner: RunnerFn): McpTool {
  return {
    name: "claudexor_run_event_read",
    description:
      "Read one bounded part of one run event by run id and seq, typically claudexor_run_wait's oversizedEvent. Returns the exact UTF-8 bytes [offset, nextOffset) of the stored serialization the run event stream delivers, with totalBytes and the sha256 of the whole event; parts never split a character. Read from offset 0, then each nextOffset until it equals totalBytes; a partial read is not a consumed event, so do not move claudexor_run_wait past it until the last part. Only validated events of this run are readable; there is no path, artifact or whole-log access.",
    inputSchema: inlineJsonSchemaRefs(inputSchema),
    outputSchema: inlineJsonSchemaRefs(partSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = McpRunEventReadInput.parse(args);
        const part = ControlRunEventPart.parse(
          await runner({ mode: "__run_event_read", ...input }, { signal: ctx.signal }),
        );
        return { text: partText(part), structured: part };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  };
}
