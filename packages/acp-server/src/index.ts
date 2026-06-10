import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ACP_PROTOCOL_VERSION = 1;

export interface RunnerHooks {
  /** Live RunEvent sink (mirrors events.jsonl) for session/update streaming. */
  onEvent?: (event: any) => void;
  /** Interactive question surface; resolve with answers or null to decline. */
  onInteraction?: (ctx: any) => Promise<any | null>;
  /** Cooperative cancellation (session/cancel aborts the underlying run). */
  signal?: AbortSignal;
}

export type RunnerFn = (params: any, hooks?: RunnerHooks) => Promise<unknown>;

export interface AcpServerOptions {
  runner: RunnerFn;
  transport: { read: Readable; write: Writable };
  name?: string;
  version?: string;
}

/**
 * Minimal Agent Client Protocol server (JSON-RPC over stdio). Exposes Claudexor as
 * a meta-agent: editors can talk to Claudexor instead of a single harness.
 * Implements initialize / session/new / session/prompt / session/cancel, streams
 * live run events as session/update notifications, and forwards interactive
 * harness questions as session/request_permission round-trips.
 */
export class AcpServer {
  private sessions = new Set<string>();
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, (result: any) => void>();
  /** Active run per session: lets session/cancel abort and keeps prompts serial. */
  private readonly activeRuns = new Map<string, AbortController>();

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
      // Responses to OUR outgoing requests carry an id and no method.
      if (msg.id !== undefined && msg.method === undefined) {
        const pending = this.pendingRequests.get(String(msg.id));
        if (pending) {
          this.pendingRequests.delete(String(msg.id));
          pending(msg.result ?? msg.error ?? null);
        }
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue;
      // NEVER block the read loop on a handler: session/prompt runs for
      // minutes and the loop must keep consuming session/request_permission
      // responses and session/cancel while the run is active. Handler errors
      // are reported per-request, not thrown into the loop.
      void this.handle(msg).catch((err) => {
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      });
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

  /** Server->client JSON-RPC request (e.g. session/request_permission). */
  private request(method: string, params: unknown): Promise<any> {
    const id = `srv-${this.nextRequestId++}`;
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async handle(msg: any): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.reply(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "0.8.0" },
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
        // One active run per session: a second prompt while one is running is
        // a protocol misuse and must fail loudly, not interleave run events.
        if (sessionId && this.activeRuns.has(sessionId)) {
          this.reply(id, { stopReason: "error", error: `session ${sessionId} already has an active prompt` });
          return;
        }
        const controller = new AbortController();
        if (sessionId) this.activeRuns.set(sessionId, controller);
        try {
          const hooks: RunnerHooks = {
            signal: controller.signal,
            ...(sessionId
              ? {
                  onEvent: (event: any) => this.forwardRunEvent(sessionId, event),
                  onInteraction: (ctx: any) => this.requestAnswers(sessionId, ctx),
                }
              : {}),
          };
          const result = await this.opts.runner({ prompt: text, mode: params?.mode ?? "agent" }, hooks);
          if (sessionId) {
            this.notify("session/update", {
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } },
            });
          }
          this.reply(id, { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" });
        } catch (err) {
          if (controller.signal.aborted) {
            this.reply(id, { stopReason: "cancelled" });
          } else {
            this.reply(id, { stopReason: "error", error: err instanceof Error ? err.message : String(err) });
          }
        } finally {
          if (sessionId && this.activeRuns.get(sessionId) === controller) this.activeRuns.delete(sessionId);
        }
        return;
      }
      case "session/cancel": {
        const sessionId = params?.sessionId as string | undefined;
        const active = sessionId ? this.activeRuns.get(sessionId) : undefined;
        if (active) active.abort();
        // Honest reply: report whether there was anything to cancel.
        this.reply(id, { cancelled: Boolean(active) });
        return;
      }
      default:
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }

  /** Thin RunEvent -> session/update projection (no business logic). */
  private forwardRunEvent(sessionId: string, event: any): void {
    const type = String(event?.type ?? "");
    const p = (event?.payload ?? {}) as Record<string, any>;
    if (type === "harness.event") {
      const sub = String(p["type"] ?? "");
      if (sub === "message" && typeof p["text"] === "string" && p["text"].trim()) {
        this.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p["text"] } },
        });
        return;
      }
      if (sub === "thinking" && typeof p["text"] === "string" && p["text"].trim()) {
        this.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: p["text"] } },
        });
        return;
      }
      if (sub === "tool_call" && p["tool"] && typeof p["tool"] === "object") {
        const tool = p["tool"] as Record<string, any>;
        this.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: String(tool["use_id"] ?? `tc-${Math.random().toString(36).slice(2, 8)}`),
            title: String(tool["name"] ?? "tool"),
            status: "in_progress",
          },
        });
        return;
      }
      return;
    }
    if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
      this.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[claudexor] ${type}` } },
      });
    }
  }

  /**
   * Interactive question -> one session/request_permission round-trip per
   * question (ACP's permission options carry a flat choice list). A cancelled
   * or unanswered request resolves null and the engine declines benignly.
   */
  private async requestAnswers(sessionId: string, ctx: any): Promise<any | null> {
    const request = ctx?.request;
    const questions: any[] = Array.isArray(request?.questions) ? request.questions : [];
    if (questions.length === 0) return null;
    const answers: any[] = [];
    for (const q of questions) {
      const options = (Array.isArray(q?.options) ? q.options : []).map((o: any, idx: number) => ({
        optionId: `opt-${idx + 1}`,
        name: String(o?.label ?? `option ${idx + 1}`),
        kind: "allow_once",
      }));
      if (options.length === 0) continue;
      const response = await this.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: String(request?.interaction_id ?? "interaction"), title: String(q?.question ?? "Question") },
        options,
      });
      const optionId = response?.outcome?.optionId ?? response?.optionId;
      const picked = typeof optionId === "string" ? options.find((o: any) => o.optionId === optionId) : undefined;
      if (picked) {
        answers.push({ question_id: String(q?.id ?? ""), selected_labels: [picked.name], free_text: null });
      }
    }
    return answers.length > 0 ? { interaction_id: String(request?.interaction_id ?? ""), answers } : null;
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
