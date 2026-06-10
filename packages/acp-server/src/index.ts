import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ACP_PROTOCOL_VERSION = 1;

export type RunnerFn = (params: any) => Promise<unknown>;

export interface AcpServerOptions {
  runner: RunnerFn;
  transport: { read: Readable; write: Writable };
  name?: string;
  version?: string;
}

/**
 * Minimal Agent Client Protocol server (JSON-RPC over stdio). Exposes Claudexor as
 * a meta-agent: editors can talk to Claudexor instead of a single harness.
 * Implements initialize / session/new / session/prompt / session/cancel.
 */
export class AcpServer {
  private sessions = new Set<string>();

  constructor(private readonly opts: AcpServerOptions) {}

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
      if (msg.id === undefined || msg.id === null) continue;
      await this.handle(msg);
    }
  }

  private write(obj: unknown): void {
    this.opts.transport.write.write(JSON.stringify(obj) + "\n");
  }

  private reply(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async handle(msg: any): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.reply(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "0.7.0" },
          agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: true } },
        });
        return;
      case "session/new": {
        const sessionId = `acp-${Math.random().toString(36).slice(2, 10)}`;
        this.sessions.add(sessionId);
        this.reply(id, { sessionId });
        return;
      }
      case "session/prompt": {
        const sessionId = params?.sessionId as string | undefined;
        const text = extractPromptText(params?.prompt);
        try {
          const result = await this.opts.runner({ prompt: text, mode: params?.mode ?? "agent" });
          if (sessionId) {
            this.notify("session/update", {
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } },
            });
          }
          this.reply(id, { stopReason: "end_turn" });
        } catch (err) {
          this.reply(id, { stopReason: "error", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case "session/cancel":
        this.reply(id, {});
        return;
      default:
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
}

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((p: any) => (typeof p === "string" ? p : (p?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  if (prompt && typeof prompt === "object" && typeof (prompt as any).text === "string") {
    return (prompt as any).text;
  }
  return "";
}
