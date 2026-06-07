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
 * handlers (the same ExecutionEngine the CLI uses).
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
          serverInfo: { name: this.opts.name ?? "claudex", version: this.opts.version ?? "0.2.0" },
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

/** Default Claudex tool surface for MCP. */
export function defaultClaudexTools(runner: RunnerFn): McpTool[] {
  const promptSchema = {
    type: "object",
    properties: { prompt: { type: "string" }, harness: { type: "string" }, n: { type: "number" } },
    required: ["prompt"],
  };
  const mk = (name: string, description: string, mode: string): McpTool => ({
    name,
    description,
    inputSchema: promptSchema,
    handler: async (args) => JSON.stringify(await runner({ ...args, mode }), null, 2),
  });
  return [
    mk("claudex_ask", "Answer a question through a read-only selected harness route.", "ask"),
    mk("claudex_run", "Run a task in Agent mode and return the WorkProduct summary.", "agent"),
    mk("claudex_race", "Best-of-N tournament with cross-family review.", "best_of_n"),
    mk("claudex_plan", "Produce a read-only plan.", "plan"),
    mk("claudex_create", "Create a new project from scratch.", "create"),
    {
      name: "claudex_status",
      description: "Return Claudex/runtime status.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => JSON.stringify(await runner({ mode: "__status" }), null, 2),
    },
  ];
}
