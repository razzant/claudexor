import { FinalMessagesOutcome } from "@claudexor/schema";
import resultSchema from "@claudexor/schema/generated/McpRunResultRead.schema.json" with { type: "json" };
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { formatRunResult } from "./run-result-format.js";
import type { McpTool, McpToolOutput, RunnerFn } from "./index.js";

type RunIdSchema = { properties: Record<string, unknown> } & Record<string, unknown>;
const outputSchema = inlineJsonSchemaRefs(resultSchema);

export function resultReadInput(runIdSchema: RunIdSchema): Record<string, unknown> {
  return {
    ...runIdSchema,
    properties: {
      ...runIdSchema.properties,
      includeFinalMessages: {
        type: "boolean",
        description:
          "Request the run's ordered final-message document (path, size, digest and coverage), a typed reason it is unavailable, or null if unknown. Omit or pass false for the original result.",
      },
    },
  };
}

/** Both MCP result readers keep their own normal text and append the same
 * machine-readable address for clients that receive only text content. */
export function resultReadOutput(
  result: unknown,
  requested = false,
  render: (plain: unknown) => McpToolOutput = (plain) => ({
    text: formatRunResult(plain),
    structured: (plain && typeof plain === "object" ? plain : {}) as Record<string, unknown>,
  }),
): McpToolOutput {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const { finalMessages, ...plain } = record ?? {};
  const output = render(record && Object.hasOwn(record, "finalMessages") ? plain : result);
  if (!requested) return output;
  const outcome = FinalMessagesOutcome.nullable().parse(finalMessages ?? null);
  const rendered = typeof output === "string" ? { text: output } : output;
  return {
    ...rendered,
    text: [rendered.text, `finalMessages: ${JSON.stringify(outcome)}`].filter(Boolean).join("\n\n"),
    structured: { ...rendered.structured, finalMessages: outcome },
  };
}

/** The durable result read. Its strict handle gains `finalMessages` only when
 * the host asks (#307), so a reader that never asks keeps the exact keys. */
export function runResultTool(runner: RunnerFn, runIdSchema: RunIdSchema): McpTool {
  return {
    name: "claudexor_run_result",
    description:
      "Read a durable run's terminal result and apply eligibility; non-terminal runs report their current state without pretending to be complete.",
    inputSchema: resultReadInput(runIdSchema),
    outputSchema,
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const result = await runner({
        mode: "__run_result",
        runId: String(args?.runId ?? ""),
        ...(args?.includeFinalMessages === true ? { includeFinalMessages: true } : {}),
      });
      return resultReadOutput(result, args?.includeFinalMessages === true);
    },
  };
}
