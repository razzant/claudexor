import { existsSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { extractPromptText, summarizeResult } from "./prompt.js";
import { validateRunControls } from "./validate.js";


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
  /** Editor-provided project root per session (anchors runs to the user's project). */
  private readonly sessionCwds = new Map<string, string>();
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, (result: any) => void>();
  /** Active run per session: lets session/cancel abort and keeps prompts serial. */
  private readonly activeRuns = new Map<string, AbortController>();
  /** Fallback tool_call ids keyed by `${sessionId}:${toolName}` — a FIFO QUEUE of
   * synthetic ids awaiting completion by a tool_result that arrives WITHOUT a
   * use_id. A queue (not a single slot) so two in-flight same-name use_id-less
   * calls don't clobber each other: each PUSHes on tool_call, the matching
   * tool_result SHIFTs one (oldest-first). use_id-bearing calls match directly
   * by id and never touch this. */
  private readonly openToolCalls = new Map<string, string[]>();

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
        // JSON-RPC 2.0 prescribes a Parse Error response with id null —
        // a malformed frame must never vanish silently (fail-loud surface).
        this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: invalid JSON frame" } });
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
      // A JSON-RPC NOTIFICATION (method present, no id) must be handled WITHOUT
      // a response — replying to a notification violates JSON-RPC. session/cancel
      // arrives this way (id-less) and aborts the active run silently.
      if (msg.id === undefined || msg.id === null) {
        this.handleNotification(msg);
        continue;
      }
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

  /** Spec-coded JSON-RPC error response ({code, message}) — never an ad-hoc shape. */
  private error(id: unknown, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Server->client JSON-RPC request (e.g. session/request_permission),
   * bounded by a deadline: an editor that never answers must not leave the
   * request pending forever (the engine's own interaction timeout would
   * eventually fire, but the ACP surface owns its half of the contract —
   * every request resolves, and the pending slot is always reclaimed).
   * Resolves null on deadline.
   */
  private request(method: string, params: unknown, deadlineMs?: number): Promise<any> {
    const id = `srv-${this.nextRequestId++}`;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (deadlineMs !== undefined && Number.isFinite(deadlineMs)) {
        timer = setTimeout(() => {
          if (this.pendingRequests.delete(id)) resolve(null);
        }, Math.max(0, deadlineMs));
        timer.unref?.();
      }
      this.pendingRequests.set(id, (result) => {
        if (timer) clearTimeout(timer);
        resolve(result);
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async handle(msg: any): Promise<void> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        this.reply(id, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "dev" },
          agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          // ACP v1 InitializeResponse carries authMethods; strict clients
          // deserialize it. Claudexor needs no editor-side auth: empty list.
          authMethods: [],
        });
        return;
      case "session/new": {
        const sessionId = `acp-${Math.random().toString(36).slice(2, 10)}`;
        // The editor's cwd anchors all of this session's runs to the project the
        // user is actually in (previously ignored -> runs hit the server's cwd).
        if (!params || !Object.prototype.hasOwnProperty.call(params, "cwd")) {
          this.error(id, -32600, "session/new cwd is required");
          return;
        }
        if (typeof params.cwd !== "string" || !params.cwd.trim()) {
          this.error(id, -32600, "session/new cwd must be a non-empty absolute path string");
          return;
        }
        const cwd = params.cwd.trim();
        if (!isAbsolute(cwd)) {
          this.error(id, -32600, "session/new cwd must be an absolute path");
          return;
        }
        if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) {
          this.error(id, -32600, "session/new cwd must be an existing directory");
          return;
        }
        this.sessions.add(sessionId);
        this.sessionCwds.set(sessionId, cwd);
        this.reply(id, { sessionId });
        return;
      }
      case "session/prompt": {
        const sessionId = params?.sessionId as string | undefined;
        const text = extractPromptText(params?.prompt);
        if (!text.trim()) {
          this.error(id, -32600, "prompt must be a non-empty string");
          return;
        }
        if (!sessionId || !this.sessions.has(sessionId) || !this.sessionCwds.has(sessionId)) {
          this.error(id, -32600, "session/prompt requires a known session created with session/new cwd");
          return;
        }
        const runControlError = validateRunControls(params);
        if (runControlError) {
          this.error(id, -32600, runControlError);
          return;
        }
        // One active run per session: a second prompt while one is running is
        // a protocol misuse. ACP StopReason has no "error" member, so fail loudly
        // as a JSON-RPC error (-32600 Invalid Request) rather than inventing one.
        if (this.activeRuns.has(sessionId)) {
          this.error(id, -32600, `session ${sessionId} already has an active prompt`);
          return;
        }
        const controller = new AbortController();
        this.activeRuns.set(sessionId, controller);
        try {
          const hooks: RunnerHooks = {
            signal: controller.signal,
            onEvent: (event: any) => this.forwardRunEvent(sessionId, event),
            onInteraction: (ctx: any) => this.requestAnswers(sessionId, ctx),
          };
          const result = await this.opts.runner(
            {
              prompt: text,
              mode: params?.mode ?? "agent",
              repoPath: this.sessionCwds.get(sessionId),
              ...(params?.harness !== undefined ? { harness: params.harness } : {}),
              ...(params?.primaryHarness !== undefined
                ? { primaryHarness: params.primaryHarness }
                : {}),
              ...(params?.web !== undefined ? { web: params.web } : {}),
              ...(params?.externalContextPolicy !== undefined
                ? { externalContextPolicy: params.externalContextPolicy }
                : {}),
              ...(params?.model !== undefined ? { model: params.model } : {}),
              ...(params?.effort !== undefined ? { effort: params.effort } : {}),
              ...(params?.n !== undefined ? { n: params.n } : {}),
              ...(params?.race === true ? { race: true } : {}),
              ...(params?.untilClean === true ? { untilClean: true } : {}),
              ...(params?.swarm === true ? { swarm: true } : {}),
              ...(params?.create === true ? { create: true } : {}),
              ...(params?.tests !== undefined ? { tests: params.tests } : {}),
              ...(params?.maxUsd !== undefined ? { maxUsd: params.maxUsd } : {}),
              ...(params?.access !== undefined ? { access: params.access } : {}),
              ...(params?.protectedPathApprovals !== undefined
                ? { protectedPathApprovals: params.protectedPathApprovals }
                : {}),
              ...(params?.reviewerPanel !== undefined ? { reviewerPanel: params.reviewerPanel } : {}),
              ...(params?.reviewerModels !== undefined
                ? { reviewerModels: params.reviewerModels }
                : {}),
              ...(params?.reviewerEfforts !== undefined
                ? { reviewerEfforts: params.reviewerEfforts }
                : {}),
            },
            hooks,
          );
          // The turn result is the human-readable summary/answer (the run's
          // primary output), not a raw dumped JSON object the editor can't show.
          const summary = summarizeResult(result);
          if (summary) {
            this.notify("session/update", {
              sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary } },
            });
          }
          this.reply(id, { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" });
        } catch (err) {
          if (controller.signal.aborted) {
            this.reply(id, { stopReason: "cancelled" });
          } else {
            // A failed turn is a JSON-RPC error (-32603 internal), not an invented
            // StopReason — the ACP StopReason enum has no "error" member.
            this.error(id, -32603, err instanceof Error ? err.message : String(err));
          }
        } finally {
          if (this.activeRuns.get(sessionId) === controller) this.activeRuns.delete(sessionId);
        }
        return;
      }
      default:
        this.error(id, -32601, `method not found: ${method}`);
    }
  }

  /**
   * JSON-RPC notifications (no `id`) get NO response. ACP `session/cancel` is a
   * notification: it aborts the underlying run (cooperative cancellation) and the
   * in-flight session/prompt then resolves with stopReason "cancelled".
   */
  private handleNotification(msg: any): void {
    const { method, params } = msg;
    if (method === "session/cancel") {
      const sessionId = params?.sessionId as string | undefined;
      const active = sessionId ? this.activeRuns.get(sessionId) : undefined;
      if (active) active.abort();
    }
    // Unknown notifications are silently ignored — JSON-RPC forbids replying.
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
        const toolCallId = String(tool["use_id"] ?? `tc-${Math.random().toString(36).slice(2, 8)}`);
        // Fallback matching for tool_results that lack a native use_id: only those
        // need it (a use_id-bearing result matches directly by id). Without this the
        // synthetic tc-* call never completes and the client hangs. Key by
        // sessionId+name (the only discriminator the result side also carries) and
        // PUSH onto a FIFO queue so two concurrent same-name use_id-less calls each
        // get their own slot — the matching results SHIFT them oldest-first.
        if (typeof tool["use_id"] !== "string") {
          const fallbackKey = `${sessionId}:${String(tool["name"] ?? "")}`;
          const queue = this.openToolCalls.get(fallbackKey);
          if (queue) queue.push(toolCallId);
          else this.openToolCalls.set(fallbackKey, [toolCallId]);
        }
        this.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: String(tool["name"] ?? "tool"),
            status: "in_progress",
          },
        });
        return;
      }
      if (sub === "tool_result" && p["tool"] && typeof p["tool"] === "object") {
        const tool = p["tool"] as Record<string, any>;
        // Terminal completion for the started tool_call. status: "ok"->completed,
        // "error"->failed; an unknown/missing status still completes (never hang).
        const hasUseId = typeof tool["use_id"] === "string" && tool["use_id"];
        const fallbackKey = `${sessionId}:${String(tool["name"] ?? "")}`;
        // use_id-bearing result -> match directly; otherwise SHIFT the oldest
        // queued synthetic id (FIFO) so concurrent same-name calls each complete.
        const queue = hasUseId ? undefined : this.openToolCalls.get(fallbackKey);
        const toolCallId = hasUseId ? String(tool["use_id"]) : queue?.shift();
        if (toolCallId) {
          // Drop the queue once drained so empty keys don't accumulate.
          if (queue && queue.length === 0) this.openToolCalls.delete(fallbackKey);
          this.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: tool["status"] === "error" ? "failed" : "completed",
            },
          });
        }
        return;
      }
      return;
    }
    if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
      // Human sentences, not raw event ids — this text lands in the editor's
      // chat timeline as-is.
      const text =
        type === "run.completed"
          ? "[claudexor] run completed."
          : type === "run.failed"
            ? "[claudexor] run failed — inspect the run artifacts for diagnostics."
            : "[claudexor] run blocked — a typed operator decision is required before this result can be applied.";
      this.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
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
    let declinedFreeText = false;
    for (const [qIdx, q] of questions.entries()) {
      const options = (Array.isArray(q?.options) ? q.options : []).map((o: any, idx: number) => ({
        optionId: `opt-${idx + 1}`,
        name: String(o?.label ?? `option ${idx + 1}`),
        kind: "allow_once",
      }));
      if (options.length === 0) {
        // A free-text question has no answer channel over ACP: session/request_permission
        // returns a chosen optionId, NOT arbitrary text. Faking an "Answer in chat"
        // affordance would advertise a capability this surface cannot honor. Decline
        // benignly (like the --json path) so the run continues with assumptions, and
        // note it honestly to the client below.
        declinedFreeText = true;
        continue;
      }
      // Announce the tool_call the permission request will reference —
      // clients that JOIN permissions to tool calls otherwise render an
      // orphan (the id must exist in the session's tool-call timeline).
      // UNIQUE per question: a multi-question interaction must not reuse one
      // id across frames (joining clients would clobber/mis-associate).
      const toolCallId = `${String(request?.interaction_id ?? "interaction")}:${String(q?.id ?? qIdx)}`;
      this.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: String(q?.question ?? "Question"),
          kind: "other",
          status: "pending",
        },
      });
      // Bound the wait by the interaction's own deadline (the engine stamps
      // timeoutAt on every interaction request); a silent editor then yields
      // a null response instead of a forever-pending server request.
      const deadlineMs = Date.parse(String(request?.timeout_at ?? ctx?.timeoutAt ?? "")) - Date.now();
      const response = await this.request(
        "session/request_permission",
        {
          sessionId,
          toolCall: { toolCallId, title: String(q?.question ?? "Question") },
          options,
        },
        Number.isFinite(deadlineMs) ? deadlineMs : 900_000,
      );
      const optionId = response?.outcome?.optionId ?? response?.optionId;
      const picked = typeof optionId === "string" ? options.find((o: any) => o.optionId === optionId) : undefined;
      // Terminal status for the announced call either way: completed on an
      // answer, failed on decline/timeout — a started tool_call never hangs.
      this.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: picked ? "completed" : "failed" },
      });
      if (picked) {
        answers.push({ question_id: String(q?.id ?? ""), selected_labels: [picked.name], free_text: null });
      }
    }
    if (declinedFreeText) {
      this.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "[claudexor] a free-text question could not be answered over ACP; the run continues with assumptions.",
          },
        },
      });
    }
    // Returning answers only for the choice questions; an empty set is a benign
    // decline (orchestrator/adapter then continue with assumptions).
    return answers.length > 0 ? { interaction_id: String(request?.interaction_id ?? ""), answers } : null;
  }
}
