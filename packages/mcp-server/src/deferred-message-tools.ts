import {
  DeferredMessageCall,
  DeferredMessageReceipt,
  DeferredMessageReadInput,
  DeferredMessageReadResult,
} from "@claudexor/schema";
import callRaw from "@claudexor/schema/generated/DeferredMessageCall.schema.json" with { type: "json" };
import receiptRaw from "@claudexor/schema/generated/DeferredMessageReceipt.schema.json" with { type: "json" };
import readRaw from "@claudexor/schema/generated/DeferredMessageReadInput.schema.json" with { type: "json" };
import resultRaw from "@claudexor/schema/generated/DeferredMessageReadResult.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

/** Registered only on the operator surface; never included in the Delegate belt. */
export function deferredMessageTools(runner: RunnerFn): McpTool[] {
  return [false, true].map((read) => ({
    name: read ? "claudexor_next_message_read" : "claudexor_next_message",
    description: read
      ? "Read one exact deferred draft: bounded prompt/ref preview with explicit omissions, predecessor result path, successor handles and `controls`, the values frozen at creation by origin (inherited from the predecessor, resolved at creation, captured Settings preferences) with their capture time. Permissions, trust, accounts and quota are not frozen. This read never dispatches. A terminal predecessor may still have a waiting or held draft; inspect its state."
      : "Operator-only editable next message for one daemon-owned single-candidate Agent/Ask predecessor. request.action create captures controls once and reserves its one successor; replace changes only the full prompt/ref list at expectedRevision; clear releases only the draft. Every mutation requires a stable idempotencyKey. Eligible settled success dispatches one ordinary continuation; failures, Stop, restart or admission refusal hold without retry. Held edits never rearm. The successor keeps the predecessor's execution: after a successful isolated (envelope) Agent it starts from the project base and receives only the path of the unapplied saved patch; nothing is applied automatically. No thread or engine Delegate child targets. Ordinary controller-owned one-shot workers are supported.",
    inputSchema: inlineJsonSchemaRefs(read ? readRaw : callRaw),
    outputSchema: inlineJsonSchemaRefs(read ? resultRaw : receiptRaw),
    annotations: { readOnlyHint: read, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = read ? DeferredMessageReadInput.parse(args) : DeferredMessageCall.parse(args);
        const output = await runner(
          { mode: read ? "__next_message_read" : "__next_message", ...input },
          ctx.signal ? { signal: ctx.signal } : {},
        );
        const receipt = read
          ? DeferredMessageReadResult.parse(output)
          : DeferredMessageReceipt.parse(output);
        return { text: JSON.stringify(receipt), structured: receipt };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  }));
}
