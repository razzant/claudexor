import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

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
  if (obj.harness !== undefined && typeof obj.harness !== "string") return "harness must be a string";
  if (obj.repoPath !== undefined && (typeof obj.repoPath !== "string" || !isAbsolute(obj.repoPath))) return "repoPath must be an absolute path";
  const nSchema = ((tool.inputSchema.properties ?? {}) as Record<string, { minimum?: unknown }>).n;
  const minN = typeof nSchema?.minimum === "number" ? nSchema.minimum : 1;
  if (obj.n !== undefined && (!Number.isInteger(obj.n) || (obj.n as number) < minN)) return `n must be an integer >= ${minN}`;
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
  const promptSchema = (minN = 1) => ({
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: { type: "string", minLength: 1, pattern: "\\S", description: "The user task or question to run through Claudexor." },
      harness: { type: "string", description: "Optional harness id to force for this one-shot run." },
      n: { type: "integer", minimum: minN, description: "Optional race width for best-of-N routes." },
      repoPath: { type: "string", description: "Absolute path of the target project. Defaults to the MCP server cwd." },
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
