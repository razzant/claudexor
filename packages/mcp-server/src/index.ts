import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { AccessProfile, EffortHint, ExternalContextPolicy, ProviderFamily } from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<string>;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools: McpTool[];
  transport: { read: Readable; write: Writable };
}

/**
 * Minimal MCP server over a newline-delimited JSON-RPC 2.0 stdio transport.
 * Implements initialize / tools/list / tools/call / ping. Tools call injected
 * handlers (the same orchestrator path the CLI uses).
 */
export class McpServer {
  private readonly tools: Map<string, McpTool>;

  constructor(private readonly opts: McpServerOptions) {
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
  }

  async serve(): Promise<void> {
    const rl = createInterface({ input: this.opts.transport.read });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // notification: no response
      await this.handle(msg);
    }
  }

  private write(obj: unknown): void {
    this.opts.transport.write.write(JSON.stringify(obj) + "\n");
  }

  private reply(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private error(id: unknown, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async handle(msg: any): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "dev" },
        });
        return;
      case "ping":
        this.reply(id, {});
        return;
      case "tools/list":
        this.reply(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
        return;
      case "tools/call": {
        const tool = this.tools.get(params?.name);
        if (!tool) {
          this.error(id, -32602, `unknown tool: ${params?.name}`);
          return;
        }
        const validation = validateToolArguments(tool, params?.arguments ?? {});
        if (validation) {
          this.error(id, -32602, validation);
          return;
        }
        try {
          const text = await tool.handler(params?.arguments ?? {});
          this.reply(id, { content: [{ type: "text", text }] });
        } catch (err) {
          this.reply(id, {
            content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          });
        }
        return;
      }
      default:
        this.error(id, -32601, `method not found: ${method}`);
    }
  }
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
  const runControlError = validateRunControls(obj);
  if (runControlError) return runControlError;
  return validateNoInlineSecrets(obj, "MCP tool arguments");
}

const EFFORTS: ReadonlySet<string> = new Set(EffortHint.options);
const ACCESS_PROFILES: ReadonlySet<string> = new Set(AccessProfile.options);
const PROVIDER_FAMILIES = ProviderFamily.options;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateStringArray(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    return `${name} must be an array of non-empty strings`;
  }
  return null;
}

function validateStringMap(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return `${name} must be an object`;
  for (const [key, child] of Object.entries(value)) {
    if (!ProviderFamily.safeParse(key).success) {
      return `${name} has unknown provider family key: ${key}`;
    }
    if (typeof child !== "string" || child.trim() === "") {
      return `${name} must map provider family keys to non-empty strings`;
    }
  }
  return null;
}

function validateEffortMap(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (!isPlainRecord(value)) return `${name} must be an object`;
  for (const [key, child] of Object.entries(value)) {
    if (!ProviderFamily.safeParse(key).success) {
      return `${name} has unknown provider family key: ${key}`;
    }
    if (typeof child !== "string" || !EFFORTS.has(child)) {
      return `${name} must map provider family keys to valid effort values`;
    }
  }
  return null;
}

function validateRunControls(obj: Record<string, unknown>): string | null {
  const primaryHarnessError = validateOptionalNonEmptyString(obj.primaryHarness, "primaryHarness");
  if (primaryHarnessError) return primaryHarnessError;
  if (obj.web !== undefined && (typeof obj.web !== "string" || !ExternalContextPolicy.safeParse(obj.web).success)) {
    return "web must be a valid external context policy";
  }
  if (
    obj.externalContextPolicy !== undefined &&
    (typeof obj.externalContextPolicy !== "string" || !ExternalContextPolicy.safeParse(obj.externalContextPolicy).success)
  ) {
    return "externalContextPolicy must be a valid external context policy";
  }
  if (
    obj.web !== undefined &&
    obj.externalContextPolicy !== undefined &&
    obj.web !== obj.externalContextPolicy
  ) {
    return "web and externalContextPolicy must be equal when both are provided";
  }
  const modelError = validateOptionalNonEmptyString(obj.model, "model");
  if (modelError) return modelError;
  if (obj.effort !== undefined && (typeof obj.effort !== "string" || !EffortHint.safeParse(obj.effort).success)) {
    return "effort must be a valid effort value";
  }
  const testsError = validateStringArray(obj.tests, "tests");
  if (testsError) return testsError;
  if (obj.maxUsd !== undefined && (typeof obj.maxUsd !== "number" || !Number.isFinite(obj.maxUsd) || obj.maxUsd < 0)) {
    return "maxUsd must be a non-negative number";
  }
  if (obj.access !== undefined && (typeof obj.access !== "string" || !ACCESS_PROFILES.has(obj.access))) {
    return "access must be a valid access profile";
  }
  if (obj.reviewerPanel !== undefined) {
    if (!Array.isArray(obj.reviewerPanel) || obj.reviewerPanel.length === 0) {
      return "reviewerPanel must be a non-empty array";
    }
    for (const entry of obj.reviewerPanel) {
      if (!isPlainRecord(entry)) return "reviewerPanel entries must be objects";
      const keys = Object.keys(entry);
      const allowed = new Set(["harness", "model", "effort"]);
      for (const key of keys) if (!allowed.has(key)) return `unknown reviewerPanel field: ${key}`;
      if (typeof entry.harness !== "string" || entry.harness.trim() === "") {
        return "reviewerPanel[].harness must be a non-empty string";
      }
      if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.trim() === "")) {
        return "reviewerPanel[].model must be a non-empty string";
      }
      if (entry.effort !== undefined && (typeof entry.effort !== "string" || !EFFORTS.has(entry.effort))) {
        return "reviewerPanel[].effort must be a valid effort value";
      }
    }
  }
  const modelsError = validateStringMap(obj.reviewerModels, "reviewerModels");
  if (modelsError) return modelsError;
  const effortsError = validateEffortMap(obj.reviewerEfforts, "reviewerEfforts");
  if (effortsError) return effortsError;
  if (obj.protectedPathApprovals !== undefined) {
    if (!Array.isArray(obj.protectedPathApprovals)) {
      return "protectedPathApprovals must be an array";
    }
    for (const entry of obj.protectedPathApprovals) {
      if (!isPlainRecord(entry)) return "protectedPathApprovals entries must be objects";
      const keys = Object.keys(entry);
      const allowed = new Set(["path", "reason"]);
      for (const key of keys) if (!allowed.has(key)) return `unknown protectedPathApprovals field: ${key}`;
      if (typeof entry.path !== "string" || entry.path.trim() === "") {
        return "protectedPathApprovals[].path must be a non-empty string";
      }
      if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.trim() === "")) {
        return "protectedPathApprovals[].reason must be a non-empty string";
      }
    }
  }
  return null;
}

function validateNoInlineSecrets(value: unknown, context: string): string | null {
  try {
    assertNoInlineSecretValues(value, "$", context);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function validateOptionalNonEmptyString(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return `${name} must be a non-empty string`;
  return null;
}

export type RunnerFn = (params: any) => Promise<unknown>;

/**
 * Reduce a run result to the human-readable text an MCP host should show. Mirrors
 * the ACP server's summarizeResult: the orchestrator returns an OrchestratorResult
 * whose `summary` is the primary output; prefer it over dumping the whole internal
 * run object. Falls back to a compact JSON string only when no summary/answer/text
 * field is present.
 */
function summarizeResult(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    for (const key of ["summary", "answer", "text"]) {
      const v = r[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return JSON.stringify(result);
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
    // Return the run SUMMARY / primary output, not the raw internal run object
    // (parity with the ACP server — MCP hosts should not see raw JSON dumps).
    handler: async (args) => summarizeResult(await runner({ ...args, ...params })),
  });
  return [
    mk("claudexor_ask", "One-shot read-only answer through Claudexor; returns final output, not a live thread.", { mode: "ask" }),
    mk("claudexor_explore", "One-shot bounded read-only exploration and synthesis through Claudexor.", { mode: "audit", swarm: true }),
    mk("claudexor_run", "One-shot Agent-mode Claudexor run; returns the final WorkProduct summary.", { mode: "agent" }),
    mk("claudexor_race", "One-shot best-of-N Claudexor race with cross-family review.", { mode: "agent", race: true }, 2),
    mk("claudexor_plan", "One-shot read-only Claudexor implementation plan.", { mode: "plan" }),
    mk("claudexor_create", "One-shot create-from-scratch Claudexor run.", { mode: "agent", create: true }),
    mk("claudexor_orchestrate", "One-shot typed Claudexor orchestration plan over the tool belt.", { mode: "orchestrate" }),
    {
      name: "claudexor_status",
      description: "Return doctor-backed Claudexor runtime status for this MCP server.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      handler: async () => summarizeResult(await runner({ mode: "__status" })),
    },
  ];
}
