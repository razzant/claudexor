import mcpThreadTurnResultSchemaRaw from "@claudexor/schema/generated/McpThreadTurnResult.schema.json" with { type: "json" };
import {
  AccessProfile,
  ExternalContextPolicy,
  WorkspaceMode,
  effortJsonSchema,
} from "@claudexor/schema";
import { mcpToolFailure } from "./tool-failure.js";
import { formatRunResult } from "./run-result-format.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import type { McpTool, McpToolOutput, RunnerFn } from "./index.js";

// Every member is an object; the explicit root type keeps 2025-era hosts from
// receiving the handle wrapped as {result: ...}.
const threadTurnResultSchema = {
  type: "object",
  ...inlineJsonSchemaRefs(mcpThreadTurnResultSchemaRaw as Record<string, unknown>),
};

/** MCP thread controls only translate daemon-owned operations. */
export function threadTools(runner: RunnerFn): McpTool[] {
  const nonBlankString = { type: "string", minLength: 1, pattern: "\\S" };
  const threadCreateSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      repoPath: {
        type: "string",
        description: "Absolute path of the target project.",
      },
      title: nonBlankString,
      defaultMode: { type: "string", enum: ["ask", "plan", "agent"] },
      workspace: {
        type: "string",
        enum: WorkspaceMode.options,
        description: WorkspaceMode.description,
      },
      workspaceRoot: {
        type: "string",
        minLength: 1,
        description:
          "Required exactly with workspace=delegated: absolute existing caller-owned directory every turn executes in. Every later turn inherits delegated authority (no repository full-access trust record, no outer OS boundary), so choose it only for a workspace you own.",
      },
      credentialProfileId: nonBlankString,
      primaryHarness: nonBlankString,
      eligibleHarnesses: { type: "array", minItems: 1, items: nonBlankString },
      access: { type: "string", enum: AccessProfile.options },
      idempotencyKey: {
        ...nonBlankString,
        maxLength: 256,
        description:
          "Caller-owned key for this exact creation. Reuse after an unknown response; a different request with the same key conflicts.",
      },
    },
    required: ["repoPath"],
  };
  const threadTurnSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      threadId: nonBlankString,
      prompt: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "The next user turn for the persistent thread.",
      },
      runMode: { type: "string", enum: ["ask", "plan", "agent"] },
      harness: nonBlankString,
      primaryHarness: nonBlankString,
      model: nonBlankString,
      effort: effortJsonSchema("Optional effort override for this turn."),
      credentialProfileId: nonBlankString,
      access: { type: "string", enum: AccessProfile.options },
      web: { type: "string", enum: ExternalContextPolicy.options },
      maxSeconds: { type: "integer", minimum: 1 },
      idempotencyKey: {
        ...nonBlankString,
        maxLength: 256,
        description:
          "Caller-owned key for one logical turn. Retry an unknown outcome with the same key and body; use a new key for an intentional next turn.",
      },
    },
    required: ["threadId", "prompt"],
  };
  const callThreadTool = async (
    args: Record<string, unknown>,
    mode: "__thread_create" | "__thread_turn" | "__thread_read",
  ): Promise<McpToolOutput> => {
    try {
      const result = await runner({ ...args, mode });
      return {
        text: formatRunResult(result),
        structured: (result && typeof result === "object" ? result : {}) as Record<string, unknown>,
      };
    } catch (error) {
      return mcpToolFailure(error);
    }
  };
  return [
    {
      name: "claudexor_thread_create",
      description:
        "Create a persistent Claudexor thread bound to a project and optional strict account profile. Creation starts no model. Write turns default to editing the project directory directly (in_place); choose workspace=isolated to use a persistent thread worktree created on the first write turn, then thread Apply to merge changes into the project. workspace=delegated with workspaceRoot binds every turn to that caller-owned directory under delegated authority (persistent, never applied to the project). Use claudexor_thread_turn to start work in it.",
      inputSchema: threadCreateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) => callThreadTool(args, "__thread_create"),
    },
    {
      name: "claudexor_thread_turn",
      description:
        "Enqueue a turn on a persistent Claudexor thread with optional routing and strict account overrides. Supply idempotencyKey to recover a lost response without creating another paid turn. Returns durable thread and turn handles plus runId or a queued jobId.",
      inputSchema: threadTurnSchema,
      outputSchema: threadTurnResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) => callThreadTool(args, "__thread_turn"),
    },
    {
      name: "claudexor_thread_read",
      description:
        "Read a thread's daemon-owned turns and native session handles, including earlier turns after a lost response; use the run status/result tools for terminal output.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { threadId: nonBlankString },
        required: ["threadId"],
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => callThreadTool(args, "__thread_read"),
    },
  ];
}
