import { z } from "zod";

/**
 * Coarse tool classification used for typed governance (no tool-name string
 * matching outside adapters). Adapters map native tool names to a kind.
 */
export const ToolKind = z
  .enum(["web", "file", "command", "mcp", "search", "other"])
  .describe(
    "Coarse tool classification used for typed governance; adapters map native tool names to a kind.",
  );
export type ToolKind = z.infer<typeof ToolKind>;

/**
 * Typed tool reference attached to `tool_call` / `tool_result` events.
 * `status` is REQUIRED on `tool_result` events (adapter conformance enforces it);
 * a missing status on a result is treated as a dropped/diagnostic event, never as ok.
 */
export const ToolRef = z
  .object({
    name: z.string().describe("Native tool name as the harness reports it."),
    kind: ToolKind.default("other"),
    use_id: z.string().optional().describe("Correlates a tool_result with its tool_call."),
    /** Redacted, bounded human-readable target (query/url/path/command). */
    target: z
      .string()
      .optional()
      .describe("Redacted, bounded human-readable target (query/url/path/command)."),
    status: z
      .enum(["ok", "error", "cancelled", "denied"])
      .optional()
      .describe(
        "Outcome of the tool use; required on tool_result events (a missing status is never treated as ok).",
      ),
    /** Redacted, bounded error detail for status=error results. */
    error_summary: z
      .string()
      .optional()
      .describe("Redacted, bounded error detail for status=error results."),
    /** Redacted, bounded content detail for results (success or failure). */
    content_summary: z
      .string()
      .optional()
      .describe("Redacted, bounded content detail for results (success or failure)."),
    exit_code: z
      .number()
      .int()
      .optional()
      .describe("Process exit code for command tools, when known."),
  })
  .describe("Typed tool reference attached to tool_call/tool_result events.");
export type ToolRef = z.infer<typeof ToolRef>;
