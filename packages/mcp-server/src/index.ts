import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

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
          serverInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "0.8.0" },
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

export type RunnerFn = (params: any) => Promise<unknown>;

/** Default Claudexor tool surface for MCP (v0.9: 5 canonical modes + strategy flags). */
export function defaultClaudexorTools(runner: RunnerFn): McpTool[] {
  const promptSchema = {
    type: "object",
    properties: {
      prompt: { type: "string" },
      harness: { type: "string" },
      n: { type: "number" },
      repoPath: { type: "string", description: "Absolute path of the target project (defaults to the server cwd)." },
    },
    required: ["prompt"],
  };
  const mk = (name: string, description: string, params: Record<string, unknown>): McpTool => ({
    name,
    description,
    inputSchema: promptSchema,
    handler: async (args) => JSON.stringify(await runner({ ...args, ...params }), null, 2),
  });
  return [
    mk("claudexor_ask", "Answer a question through a read-only selected harness route.", { mode: "ask" }),
    mk("claudexor_explore", "Run a bounded read-only exploration and verified synthesis.", { mode: "audit", swarm: true }),
    mk("claudexor_run", "Run a task in Agent mode and return the WorkProduct summary.", { mode: "agent" }),
    mk("claudexor_race", "Best-of-N race (agent --n) with cross-family review.", { mode: "agent", race: true }),
    mk("claudexor_plan", "Produce a read-only plan.", { mode: "plan" }),
    mk("claudexor_create", "Create a new project from scratch.", { mode: "agent", create: true }),
    mk("claudexor_orchestrate", "Brain: produce a typed orchestration plan over the tool belt.", { mode: "orchestrate" }),
    {
      name: "claudexor_status",
      description: "Return Claudexor/runtime status.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => JSON.stringify(await runner({ mode: "__status" }), null, 2),
    },
  ];
}
