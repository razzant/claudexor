import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  McpServer as SdkMcpServer,
  MissingRequiredClientCapabilityError,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio, type ServeStdioOptions } from "@modelcontextprotocol/server/stdio";
import {
  EffortHint,
  ExternalContextPolicy,
  ProviderFamily,
  validateOptionalNonEmptyString,
  validateSurfaceRunControls,
  type InteractionAnswer,
  type InteractionQuestion,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";


/**
 * Claudexor's MCP surface on the official TypeScript SDK v2.
 *
 * The SDK owns the protocol core: version negotiation (2025-11-25 down to
 * 2024-10-07 — Cursor's 2025-06-18 handshake keeps working), CONCURRENT
 * request dispatch (a multi-minute race no longer blocks ping/tools/list —
 * the old hand-rolled loop awaited every call inline), structural argument
 * validation against the declared JSON Schemas, and elicitation round-trips.
 * This module stays a THIN surface: tool descriptors, Claudexor's semantic
 * argument checks (the parts a JSON Schema cannot express), and translation
 * between runner results/interactions and MCP shapes. No business logic.
 */

export interface McpToolContext {
  /**
   * Ask the user the engine's interactive questions through MCP elicitation.
   * Resolves null when the host lacks the elicitation capability or declines
   * — the engine's timeout-decline fallback stays the honest default.
   */
  elicit: ((request: { interaction_id: string; questions: InteractionQuestion[] }) => Promise<InteractionAnswer[] | null>) | null;
  /**
   * The request's cancellation signal (`notifications/cancelled` from the
   * host) — runners abort the underlying run with it, exactly like Ctrl-C
   * on the CLI.
   */
  signal?: AbortSignal;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any, ctx: McpToolContext) => Promise<string>;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools: McpTool[];
  /** Custom stdio streams (tests, socket bindings); defaults to process stdio. */
  transport?: { read: Readable; write: Writable };
}

/** Build the SDK server with Claudexor's tools registered (one era-agnostic factory). */
export function buildMcpServer(opts: { name?: string; version?: string; tools: McpTool[] }): SdkMcpServer {
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
      },
      (async (args: unknown, ctx: any) => {
        const provided = (args ?? {}) as Record<string, unknown>;
        // Semantic checks a JSON Schema cannot express (absolute paths, the
        // secret fence, cross-field equality). Structural validation already
        // happened in the SDK against the same schema.
        const validation = validateToolArguments(tool, provided);
        if (validation) {
          // The official SDK's contract: tool-argument failures surface as
          // isError:true TOOL results (its own structural validation does the
          // same), not JSON-RPC protocol errors — a thrown handler error maps
          // there. The old hand-rolled -32602 contract is retired with it.
          throw new Error(validation);
        }
        // Offer the elicitation bridge ONLY when the client declared the
        // capability — otherwise the ENGINE must not think an interactive
        // channel exists (it would offer the harness a channel whose every
        // question dies as a decline).
        const canElicit = Boolean(server.server.getClientCapabilities()?.elicitation);
        const text = await tool.handler(provided, {
          elicit: canElicit ? elicitBridge(ctx) : null,
          signal: ctx?.mcpReq?.signal,
        });
        return { content: [{ type: "text" as const, text }] };
      }) as any,
    );
  }
  return server;
}

/**
 * Serve Claudexor over stdio. The SDK entry owns the era decision per
 * connection; the factory registers the same tools for every era.
 */
export function serveClaudexorMcp(opts: McpServerOptions): { close(): Promise<void> } {
  warnOnPluginVersionSkew(opts.version);
  const serveOpts: ServeStdioOptions = {
    ...(opts.transport ? { transport: new StdioServerTransport(opts.transport.read, opts.transport.write) } : {}),
    // Out-of-band transport errors go to stderr — stdout is the wire.
    onerror: (err) => process.stderr.write(`claudexor mcp: ${err.message}\n`),
  };
  return serveStdio(() => buildMcpServer(opts), serveOpts);
}

/**
 * Installed host plugins export CLAUDEXOR_PLUGIN_VERSION into the server env
 * (plugins.ts). A mismatch with the running CLI means the host is driving a
 * NEWER/OLDER runtime than the artifacts it discovered — tool schemas may be
 * stale until `claudexor plugin repair`. Disclose on stderr (the wire stays
 * clean); this is the env var's first real reader.
 */
function warnOnPluginVersionSkew(serverVersion: string | undefined): void {
  const pluginVersion = process.env["CLAUDEXOR_PLUGIN_VERSION"];
  if (pluginVersion && serverVersion && pluginVersion !== serverVersion) {
    // The env value is environment-sourced: never echo arbitrary content to
    // the log — a non-version-shaped value is disclosed generically.
    const shown = /^[\w.+-]{1,32}$/.test(pluginVersion) ? pluginVersion : "<non-version value>";
    process.stderr.write(
      `claudexor mcp: plugin artifacts are version ${shown} but the CLI is ${serverVersion}; ` +
        `run \`claudexor plugin repair all\` and reload the host to refresh cached tool schemas\n`,
    );
  }
}

/**
 * Map the SDK's server-initiated elicitation onto the engine's typed
 * interaction questions. One elicitation per QUESTION (MCP forms are flat);
 * a missing client capability resolves null so the engine's timeout-decline
 * fallback applies — never a fake answer.
 */
function elicitBridge(ctx: any): McpToolContext["elicit"] {
  const elicitInput = ctx?.mcpReq?.elicitInput;
  if (typeof elicitInput !== "function") return null;
  return async ({ questions }) => {
    const answers: InteractionAnswer[] = [];
    for (const q of questions) {
      const hasOptions = q.options.length > 0;
      const property: Record<string, unknown> = hasOptions
        ? q.multi_select
          ? { type: "array", items: { type: "string", enum: q.options.map((o) => o.label) }, description: optionLegend(q) }
          : { type: "string", enum: q.options.map((o) => o.label), description: optionLegend(q) }
        : { type: "string", description: "Free-text answer" };
      let result: any;
      try {
        result = await ctx.mcpReq.elicitInput({
          message: q.header ? `${q.header}: ${q.question}` : q.question,
          requestedSchema: {
            type: "object",
            properties: { answer: property },
            required: ["answer"],
          },
        });
      } catch (err) {
        if (err instanceof MissingRequiredClientCapabilityError) return null;
        throw err;
      }
      if (result?.action !== "accept" || !result?.content || typeof result.content !== "object") {
        // Decline/cancel any single question = decline the whole interaction
        // (the engine treats partial answer sets as declines anyway).
        return null;
      }
      const answer = (result.content as Record<string, unknown>)["answer"];
      if (hasOptions && q.multi_select && Array.isArray(answer)) {
        answers.push({ question_id: q.id, selected_labels: answer.map(String), free_text: null });
      } else if (hasOptions && typeof answer === "string") {
        answers.push({ question_id: q.id, selected_labels: [answer], free_text: null });
      } else if (typeof answer === "string" && answer.trim()) {
        answers.push({ question_id: q.id, selected_labels: [], free_text: answer });
      } else {
        return null;
      }
    }
    return answers;
  };
}

function optionLegend(q: InteractionQuestion): string {
  const withDetail = q.options.filter((o) => o.description);
  if (withDetail.length === 0) return "Choose from the listed options";
  return withDetail.map((o) => `${o.label}: ${o.description}`).join("; ");
}

function validateToolArguments(tool: McpTool, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "tool arguments must be an object";
  const obj = args as Record<string, unknown>;
  const allowed = new Set(Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>));
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `unknown argument: ${key}`;
  }
  if (tool.name !== "claudexor_status") {
    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) return "prompt must be a non-empty string";
  }
  const harnessError = validateOptionalNonEmptyString(obj.harness, "harness");
  if (harnessError) return harnessError;
  if (obj.repoPath !== undefined && (typeof obj.repoPath !== "string" || !isAbsolute(obj.repoPath))) return "repoPath must be an absolute path";
  const nSchema = ((tool.inputSchema.properties ?? {}) as Record<string, { minimum?: unknown }>).n;
  const minN = typeof nSchema?.minimum === "number" ? nSchema.minimum : 1;
  if (obj.n !== undefined && (!Number.isInteger(obj.n) || (obj.n as number) < minN)) return `n must be an integer >= ${minN}`;
  // Shared semantic run-control rules (ONE owner in @claudexor/schema).
  const runControlError = validateSurfaceRunControls(obj);
  if (runControlError) return runControlError;
  return validateNoInlineSecrets(obj, "MCP tool arguments");
}

const PROVIDER_FAMILIES = ProviderFamily.options;

function validateNoInlineSecrets(value: unknown, context: string): string | null {
  try {
    assertNoInlineSecretValues(value, "$", context);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export interface RunnerHooks {
  /** Interactive question surface; resolve with answers or null to decline. */
  onInteraction?: (ctx: any) => Promise<any | null>;
  /** Cooperative cancellation: host `notifications/cancelled` aborts the run. */
  signal?: AbortSignal;
}

export type RunnerFn = (params: any, hooks?: RunnerHooks) => Promise<unknown>;

/**
 * Render a run result for an MCP host: the human-readable summary FIRST, then
 * the artifact handles (runId/artifacts/status) so the host can inspect,
 * apply, follow, or unblock the run through the CLI — the old surface dropped
 * the runId and left hosts with no handle at all.
 */
function formatRunResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    let summary = "";
    for (const key of ["summary", "answer", "text"]) {
      const v = r[key];
      if (typeof v === "string" && v.trim()) {
        summary = v.trim();
        break;
      }
    }
    const trailer: string[] = [];
    if (typeof r["runId"] === "string" && r["runId"]) trailer.push(`runId: ${r["runId"]}`);
    if (typeof r["runDir"] === "string" && r["runDir"]) trailer.push(`artifacts: ${r["runDir"]}`);
    if (typeof r["status"] === "string" && r["status"]) trailer.push(`status: ${r["status"]}`);
    if (!summary && trailer.length === 0) return JSON.stringify(result);
    return trailer.length > 0 ? `${summary ? `${summary}\n\n` : ""}${trailer.join("\n")}` : summary;
  }
  return result === undefined || result === null ? "" : String(result);
}

/** Default Claudexor tool surface for MCP (v0.9: 5 canonical modes + strategy flags). */
export function defaultClaudexorTools(runner: RunnerFn): McpTool[] {
  const reviewerModelProperties = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [family, { type: "string", minLength: 1 }]),
  );
  const reviewerEffortProperties = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [
      family,
      { type: "string", enum: EffortHint.options },
    ]),
  );
  const promptSchema = (minN = 1) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1, pattern: "\\S", description: "The user task or question to run through Claudexor." },
      harness: { type: "string", minLength: 1, description: "Optional harness id to force for this one-shot run." },
      primaryHarness: { type: "string", minLength: 1, description: "Optional primary harness id for this run." },
      model: { type: "string", minLength: 1, description: "Optional model override for the primary harness." },
      effort: { type: "string", enum: EffortHint.options, description: "Optional effort override for the primary harness." },
      web: { type: "string", enum: ExternalContextPolicy.options, description: "External context policy for this run." },
      externalContextPolicy: { type: "string", enum: ExternalContextPolicy.options, description: "Alias of web for control-api parity." },
      n: { type: "integer", minimum: minN, description: "Optional race width for best-of-N routes." },
      repoPath: { type: "string", description: "Absolute path of the target project. Defaults to the MCP server cwd." },
      tests: { type: "array", items: { type: "string", minLength: 1 }, description: "Deterministic gate commands for this run." },
      maxUsd: { type: "number", minimum: 0, description: "Optional per-run budget ceiling." },
      access: {
        type: "string",
        enum: ["readonly", "workspace_write", "full", "external_sandbox_full", "inherit_native"],
        description: "Optional access profile for this run.",
      },
      reviewerPanel: {
        type: "array",
        minItems: 1,
        description: "Explicit reviewer panel entries, preserving order and duplicates.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            harness: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
            effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
          },
          required: ["harness"],
        },
      },
      reviewerModels: {
        type: "object",
        additionalProperties: false,
        properties: reviewerModelProperties,
        description: "Per-provider reviewer model overrides.",
      },
      reviewerEfforts: {
        type: "object",
        additionalProperties: false,
        properties: reviewerEffortProperties,
        description: "Per-provider reviewer effort overrides.",
      },
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
    },
    required: ["prompt"],
  });
  const mk = (name: string, description: string, params: Record<string, unknown>, minN = 1): McpTool => ({
    name,
    description,
    inputSchema: promptSchema(minN),
    // Summary first, then the runId/artifacts trailer (hosts get a handle).
    // The elicitation bridge rides the hooks: the runner surfaces the engine's
    // interactive questions and this tool answers them via the host.
    handler: async (args, ctx) =>
      formatRunResult(
        await runner(
          { ...args, ...params },
          {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.elicit
              ? {
                  onInteraction: async (ictx: any) => {
                    const interactionId = ictx?.request?.interaction_id ?? "";
                    const answers = await ctx.elicit!({
                      interaction_id: interactionId,
                      questions: Array.isArray(ictx?.request?.questions) ? ictx.request.questions : [],
                    });
                    // The TYPED InteractionAnswerSet carries the interaction id
                    // (ACP/daemon parity; the engine keys the set to the request).
                    return answers ? { interaction_id: interactionId, answers } : null;
                  },
                }
              : {}),
          },
        ),
      ),
  });
  return [
    mk("claudexor_ask", "One-shot read-only answer through Claudexor; returns final output, not a live thread.", { mode: "ask" }),
    mk("claudexor_explore", "One-shot bounded read-only exploration and synthesis through Claudexor.", { mode: "audit", swarm: true }),
    mk("claudexor_run", "One-shot Agent-mode Claudexor run; returns the final WorkProduct summary plus runId.", { mode: "agent" }),
    mk("claudexor_race", "One-shot best-of-N Claudexor race with cross-family review.", { mode: "agent", race: true }, 2),
    mk("claudexor_plan", "One-shot read-only Claudexor implementation plan.", { mode: "plan" }),
    mk("claudexor_create", "One-shot create-from-scratch Claudexor run.", { mode: "agent", create: true }),
    mk("claudexor_orchestrate", "One-shot typed Claudexor orchestration plan over the tool belt.", { mode: "orchestrate" }),
    {
      name: "claudexor_status",
      description: "Return doctor-backed Claudexor runtime status for this MCP server.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      handler: async () => formatRunResult(await runner({ mode: "__status" })),
    },
  ];
}
