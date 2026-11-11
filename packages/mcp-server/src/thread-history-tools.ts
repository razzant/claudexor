import {
  ThreadHistoryInput,
  ThreadHistoryPage,
  ThreadPromptPartInput,
  ThreadPromptPart,
} from "@claudexor/schema";
import historyInput from "@claudexor/schema/generated/ThreadHistoryInput.schema.json" with { type: "json" };
import historyOutput from "@claudexor/schema/generated/ThreadHistoryPage.schema.json" with { type: "json" };
import promptInput from "@claudexor/schema/generated/ThreadPromptPartInput.schema.json" with { type: "json" };
import promptOutput from "@claudexor/schema/generated/ThreadPromptPart.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { mcpToolFailure } from "./tool-failure.js";
import type { McpTool, RunnerFn } from "./index.js";

export function threadHistoryTools(runner: RunnerFn): McpTool[] {
  return [false, true].map((prompt) => ({
    name: prompt ? "claudexor_thread_prompt" : "claudexor_thread_history",
    description: prompt
      ? "Read a bounded UTF-8 part of any turn's complete stored prompt, including refused turns. Continue at nextOffset; totalBytes and sha256 identify the full prompt. Requires an existing daemon."
      : "Read one bounded page of thread turns with answer previews and receipt facts. limit 1..20; choose at most one cursor, beforeTurnId, afterTurnId or aroundTurnId. No selector reads the newest turns. aroundTurnId returns the anchor and earlier turns; follow newerCursor for later turns. Ascending ordinals; cursors bind store, epoch, thread and limit. Replay refreshes current facts. Requires an existing daemon; never starts work.",
    inputSchema: inlineJsonSchemaRefs(prompt ? promptInput : historyInput),
    outputSchema: inlineJsonSchemaRefs(prompt ? promptOutput : historyOutput),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: async (args, ctx) => {
      try {
        const input = prompt ? ThreadPromptPartInput.parse(args) : ThreadHistoryInput.parse(args);
        const raw = await runner(
          { mode: prompt ? "__thread_prompt" : "__thread_history", ...input },
          { signal: ctx.signal },
        );
        const result = prompt ? ThreadPromptPart.parse(raw) : ThreadHistoryPage.parse(raw);
        if (result.threadId !== input.threadId) throw new Error("thread read identity mismatch");
        return { text: JSON.stringify(result), structured: result };
      } catch (error) {
        return mcpToolFailure(error);
      }
    },
  }));
}
