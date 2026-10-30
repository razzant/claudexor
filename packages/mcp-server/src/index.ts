import { mcpToolFailure } from "./tool-failure.js";
import { attachmentRefsSchema } from "./attachment-ref-schema.js";
import { uploadTools } from "./upload-tools.js";
import { catalogTools } from "./catalog-tools.js";
import { runExecutionSchema } from "./run-execution-schema.js";
import { idempotencyKeySchema } from "./idempotency-key-schema.js";
import { isAbsolute } from "node:path";
import mcpRunToolResultSchemaRaw from "@claudexor/schema/generated/McpRunToolResult.schema.json" with { type: "json" };
import mcpRunHandleResultSchemaRaw from "@claudexor/schema/generated/McpRunHandleResult.schema.json" with { type: "json" };
import testCommandInvocationSchemaRaw from "@claudexor/schema/generated/TestCommandInvocation.schema.json" with { type: "json" };
import type { Readable, Writable } from "node:stream";
import { McpServer as SdkMcpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
  type ServeStdioOptions,
} from "@modelcontextprotocol/server/stdio";
import {
  effortJsonSchema,
  type ModeKind,
  runControlApplicability,
  validateOptionalNonEmptyString,
  validateSurfaceRunControls,
} from "@claudexor/schema";
import { journalRecoveryTools } from "./recovery-tools.js";
import { formatRunResult, structuredRunResult } from "./run-result-format.js";
import { assertNoPluginArtifactSkew } from "./plugin-skew.js";
import { threadTools } from "./thread-tools.js";
import { runControlTools } from "./run-control-tools.js";
import { runObservationTools } from "./run-observation-tools.js";
import { runStatusTool } from "./run-status-tool.js";
import { inlineJsonSchemaRefs } from "./inline-json-schema-refs.js";
import { processingPreferenceSchema } from "./reviewer-panel-schema.js";
import {
  accessAndLimitProperties,
  externalContextProperties,
  reviewProperties,
  taskGroupProperties,
} from "./run-control-properties.js";
const mcpRunToolResultSchema = inlineJsonSchemaRefs(
  mcpRunToolResultSchemaRaw as Record<string, unknown>,
);
const mcpRunHandleResultSchema = inlineJsonSchemaRefs(
  mcpRunHandleResultSchemaRaw as Record<string, unknown>,
);
const testCommandInvocationSchema = inlineJsonSchemaRefs(testCommandInvocationSchemaRaw);
const RUN_STRATEGY_PROPERTIES = {
  ask: {
    deepScan: {
      type: "boolean",
      description: "Widen the answer into a bounded multi-scout research sweep with synthesis.",
    },
  },
  plan: {
    council: {
      type: "boolean",
      description: "Draft n plans (2 to the configured cap), then merge one plan and question set.",
    },
  },
  agent: {
    tests: {
      type: "array",
      items: testCommandInvocationSchema,
      description: "Typed-argv deterministic gate commands for this run.",
    },
  },
};

/**
 * Thin MCP v2 SDK surface: negotiation, concurrent dispatch, schema validation,
 * Claudexor semantic checks, and runner-shape translation; no business logic.
 */

export interface McpToolContext {
  /** Host cancellation; each controller defines whether it aborts a run or just its request. */
  signal?: AbortSignal;
}

/** Behavior hints per the MCP ToolAnnotations contract (all advisory). */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/** Tool output: plain text, or text plus a structured mirror (structuredContent). */
export type McpToolOutput =
  | string
  | {
      text: string;
      structured?: Record<string, unknown>;
      isError?: boolean;
    };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** JSON Schema of the structured result (declared to hosts as outputSchema). */
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  runMode?: ModeKind;
  handler: (args: any, ctx: McpToolContext) => Promise<McpToolOutput>;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools: McpTool[];
  /** Custom stdio streams (tests, socket bindings); defaults to process stdio. */
  transport?: { read: Readable; write: Writable };
}

/** Build the SDK server with Claudexor's tools registered (one era-agnostic factory). */
export function buildMcpServer(opts: {
  name?: string;
  version?: string;
  tools: McpTool[];
}): SdkMcpServer {
  const server = new SdkMcpServer({
    name: opts.name ?? "claudexor",
    version: opts.version ?? "dev",
  });
  for (const tool of opts.tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as any) as any,
        // Structured results are declared, mirrored in text, and carry behavior hints.
        ...(tool.outputSchema
          ? { outputSchema: fromJsonSchema(tool.outputSchema as any) as any }
          : {}),
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      (async (args: unknown, ctx: any) => {
        const provided = (args ?? {}) as Record<string, unknown>;
        // Apply semantic checks that JSON Schema cannot express.
        const validation = validateToolArguments(tool, provided);
        if (validation) {
          // The SDK maps thrown argument failures to isError tool results,
          // matching its structural validation rather than JSON-RPC errors.
          throw new Error(validation);
        }
        const out = await tool
          .handler(provided, {
            signal: ctx?.mcpReq?.signal,
          })
          .catch(mcpToolFailure);
        const text = typeof out === "string" ? out : out.text;
        const structured = typeof out === "string" ? undefined : out.structured;
        return {
          content: [{ type: "text" as const, text }],
          ...(structured !== undefined ? { structuredContent: structured } : {}),
          ...(typeof out !== "string" && out.isError ? { isError: true } : {}),
        };
      }) as any,
    );
  }
  return server;
}

/** Serve the same tools over stdio; the SDK selects the connection's protocol era. */
export function serveClaudexorMcp(opts: McpServerOptions): { close(): Promise<void> } {
  assertNoPluginArtifactSkew(opts.version);
  const serveOpts: ServeStdioOptions = {
    ...(opts.transport
      ? { transport: new StdioServerTransport(opts.transport.read, opts.transport.write) }
      : {}),
    // Out-of-band transport errors go to stderr — stdout is the wire.
    onerror: (err) => process.stderr.write(`claudexor mcp: ${err.message}\n`),
  };
  return serveStdio(() => buildMcpServer(opts), serveOpts);
}

function validateToolArguments(tool: McpTool, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return "tool arguments must be an object";
  const obj = args as Record<string, unknown>;
  const allowed = new Set(
    Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>),
  );
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `unknown argument: ${key}`;
  }
  // Prompt is required exactly when the tool's own schema REQUIRES it — no
  // per-tool-name special cases (no-argument tools like status/capabilities
  // simply do not declare a prompt property).
  const requiredKeys = Array.isArray(tool.inputSchema.required)
    ? (tool.inputSchema.required as string[])
    : [];
  if (requiredKeys.includes("prompt")) {
    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0)
      return "prompt must be a non-empty string";
  }
  const harnessError = validateOptionalNonEmptyString(obj.harness, "harness");
  if (harnessError) return harnessError;
  if (obj.repoPath !== undefined && (typeof obj.repoPath !== "string" || !isAbsolute(obj.repoPath)))
    return "repoPath must be an absolute path";
  const nSchema = ((tool.inputSchema.properties ?? {}) as Record<string, { minimum?: unknown }>).n;
  const minN = typeof nSchema?.minimum === "number" ? nSchema.minimum : 1;
  if (obj.n !== undefined && (!Number.isInteger(obj.n) || (obj.n as number) < minN))
    return `n must be an integer >= ${minN}`;
  // Shared semantic run-control rules (ONE owner in @claudexor/schema).
  const runControlError = validateSurfaceRunControls(
    tool.runMode ? { ...obj, mode: tool.runMode } : obj,
  );
  return runControlError;
}

export interface RunnerHooks {
  /** Interactive question surface; resolve with answers or null to decline. */
  onInteraction?: (ctx: any) => Promise<any | null>;
  /** Cooperative cancellation; live-message controllers abort only their HTTP request. */
  signal?: AbortSignal;
}

export type RunnerFn = (params: any, hooks?: RunnerHooks) => Promise<unknown>;

/** Default Claudexor MCP tool surface: three canonical modes plus strategy controls. */
export function defaultClaudexorTools(runner: RunnerFn): McpTool[] {
  const promptSchema = (minN = 1, mode: "ask" | "plan" | "agent" = "agent") => ({
    type: "object",
    additionalProperties: false,
    properties: {
      idempotencyKey: idempotencyKeySchema,
      attachments: attachmentRefsSchema,
      ...taskGroupProperties(),
      prompt: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "The user task or question to run through Claudexor.",
      },
      harness: {
        type: "string",
        minLength: 1,
        description: "Optional harness id to force for this one-shot run.",
      },
      primaryHarness: {
        type: "string",
        minLength: 1,
        description: "Optional primary harness id for this run.",
      },
      model: {
        type: "string",
        minLength: 1,
        description: "Optional model override for the primary harness.",
      },
      effort: effortJsonSchema("Optional effort override for the primary harness."),
      processingPreference: processingPreferenceSchema,
      ...externalContextProperties(),
      n: {
        type: "integer",
        minimum: minN,
        description: "Optional best-of-N width for candidate races (or deep-scan scout width).",
      },
      ...RUN_STRATEGY_PROPERTIES[mode],
      repoPath: {
        type: "string",
        description:
          "Absolute path of the target project. Defaults to the MCP server cwd; required with idempotencyKey.",
      },
      execution: runExecutionSchema,
      ...accessAndLimitProperties(),
      ...(runControlApplicability({ mode }).reviewerPanel.applicable ? reviewProperties() : {}),
      ...(runControlApplicability({ mode }).protectedPathApprovals.applicable
        ? {
            protectedPathApprovals: {
              type: "array",
              description: "Typed approvals for existing protected path edits.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", minLength: 1 },
                  reason: { type: "string", minLength: 1 },
                },
                required: ["path"],
              },
            },
          }
        : {}),
    },
    required: ["prompt"],
  });
  // Behavior hints derive from mode: ask/plan are read-only; agent tools mutate.
  const annotationsFor = (params: Record<string, unknown>): McpToolAnnotations =>
    params["mode"] === "agent"
      ? { readOnlyHint: false, destructiveHint: false }
      : { readOnlyHint: true };
  const mk = (
    name: string,
    description: string,
    params: Record<string, unknown>,
    minN = 1,
  ): McpTool => ({
    name,
    description,
    inputSchema: promptSchema(
      minN,
      params["mode"] === "ask" || params["mode"] === "plan" ? params["mode"] : "agent",
    ),
    outputSchema: mcpRunToolResultSchema,
    annotations: annotationsFor(params),
    runMode: params["mode"] as ModeKind,
    // Summary precedes the run handle; structured content mirrors the same facts.
    handler: async (args, ctx) => {
      const result = await runner(
        // Return a durable daemon handle while MCP Tasks remain experimental.
        { ...args, ...params, deferred: true },
        ctx.signal ? { signal: ctx.signal } : {},
      );
      return { text: formatRunResult(result), structured: structuredRunResult(result) };
    },
  });
  const runIdSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: {
        type: "string",
        minLength: 1,
        description: "Daemon run id (from a run tool's runId trailer or claudexor_runs).",
      },
    },
    required: ["runId"],
  };
  const interactionAnswerSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string", minLength: 1 },
      interactionId: { type: "string", minLength: 1 },
      answers: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            questionId: { type: "string", minLength: 1 },
            selectedLabels: { type: "array", items: { type: "string" } },
            freeText: { type: "string" },
          },
          required: ["questionId", "selectedLabels"],
        },
      },
    },
    required: ["runId", "interactionId", "answers"],
  };
  return [
    mk(
      "claudexor_ask",
      "Enqueue a read-only Claudexor answer; pass deepScan:true for a bounded multi-scout research sweep with synthesis. Returns a durable run handle, not terminal output; use claudexor_run_status/result for the final answer.",
      { mode: "ask" },
    ),
    mk(
      "claudexor_run",
      "Enqueue an Agent-mode Claudexor run. Internal model review is off by default; review:true selects a panel automatically, and an explicit reviewerPanel enables review. Returns a durable run handle plus any immediate start facts; use claudexor_run_status/result for the terminal WorkProduct.",
      { mode: "agent" },
    ),
    mk(
      "claudexor_best_of",
      "Enqueue a best-of-N Claudexor run with cross-family review. Returns a durable run handle; use claudexor_run_status/result for terminal output.",
      { mode: "agent", race: true },
      2,
    ),
    mk(
      "claudexor_plan",
      "Enqueue a read-only Claudexor implementation plan. Returns a durable run handle; use claudexor_run_status/result for the final plan.",
      { mode: "plan" },
    ),
    mk(
      "claudexor_create",
      "Enqueue a create-from-scratch Claudexor run. Returns a durable run handle; use claudexor_run_status/result for terminal output.",
      {
        mode: "agent",
        create: true,
      },
    ),
    ...threadTools(runner),
    ...uploadTools(runner),
    ...runControlTools(runner),
    ...runObservationTools(runner),
    ...catalogTools(runner),
    // Read-only daemon projections let hosts recover lost run handles.
    {
      name: "claudexor_runs",
      description: "List recent daemon-tracked Claudexor runs (recovery: find a lost runId).",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const result = await runner({ mode: "__runs_list" });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      },
    },
    {
      name: "claudexor_inspect",
      description:
        "Inspect a daemon-tracked run: status, summary, decision verdict, and the derived applyEligibility (what unblocks apply).",
      inputSchema: runIdSchema,
      outputSchema: mcpRunHandleResultSchema,
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const result = await runner({ mode: "__run_inspect", runId: String(args?.runId ?? "") });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      },
    },
    runStatusTool(runner, runIdSchema, mcpRunHandleResultSchema),
    {
      name: "claudexor_run_result",
      description:
        "Read a durable run's terminal result and apply eligibility; non-terminal runs report their current state without pretending to be complete.",
      inputSchema: runIdSchema,
      outputSchema: mcpRunHandleResultSchema,
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const result = await runner({ mode: "__run_result", runId: String(args?.runId ?? "") });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      },
    },
    {
      name: "claudexor_run_cancel",
      description:
        "Request cancellation of a daemon-owned run; success is returned only after the control API acknowledges the durable command. The same call holds the run's next message (claudexor_next_message) that is not accepted yet, also after the run ended; an already accepted successor fails next_message_dispatched with its job handle and keeps running. If that hold cannot be saved, the call fails next_message_hold_failed (retryable) after any cancel was applied; the next message is still not sent, and a retried cancel records the hold.",
      inputSchema: runIdSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      handler: async (args) => {
        const result = await runner({ mode: "__run_cancel", runId: String(args?.runId ?? "") });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      },
    },
    {
      name: "claudexor_run_interactions",
      description:
        "List the complete daemon-persisted questions still awaiting answers for a run, including bodies claudexor_run_wait omitted; the text content carries the same JSON.",
      inputSchema: runIdSchema,
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const result = await runner({
          mode: "__run_interactions",
          runId: String(args?.runId ?? ""),
        });
        const structured = (result && typeof result === "object" ? result : {}) as Record<
          string,
          unknown
        >;
        return { text: JSON.stringify(structured), structured };
      },
    },
    {
      name: "claudexor_answer_interaction",
      description:
        "Answer a daemon-persisted run interaction; success (status delivered) is reported only after the control API acknowledges the journal mutation. Refusals keep their typed status as the failure code: not_found, already_resolved (never proof that this answer landed) or rejected. Answers have no replay key and are not retried.",
      inputSchema: interactionAnswerSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (args) => {
        const result = await runner({ mode: "__run_answer", ...args });
        const structured = (result && typeof result === "object" ? result : {}) as Record<
          string,
          unknown
        >;
        return { text: JSON.stringify(structured), structured };
      },
    },
    {
      name: "claudexor_apply_check",
      description:
        "Dry-check whether a run's patch would apply cleanly to its original project (no mutation).",
      inputSchema: runIdSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
      handler: async (args) => {
        const result = await runner({ mode: "__apply_check", runId: String(args?.runId ?? "") });
        return {
          text: formatRunResult(result),
          structured: (result && typeof result === "object" ? result : {}) as Record<
            string,
            unknown
          >,
        };
      },
    },
    ...journalRecoveryTools(runner, formatRunResult),
  ];
}
export * from "./delegation-belt.js";
