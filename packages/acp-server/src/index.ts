import { existsSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  AccessProfile,
  EffortHint,
  ExternalContextPolicy,
  ModeKind,
  ProviderFamily,
} from "@claudexor/schema";
import { assertNoInlineSecretValues } from "@claudexor/util";

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
        const cwdProvided = params && Object.prototype.hasOwnProperty.call(params, "cwd");
        const cwd = cwdProvided && typeof params?.cwd === "string" ? params.cwd.trim() : undefined;
        if (!cwdProvided) {
          this.error(id, -32600, "session/new cwd is required");
          return;
        }
        if (cwdProvided && typeof params?.cwd !== "string") {
          this.error(id, -32600, "session/new cwd must be a non-empty absolute path string");
          return;
        }
        if (cwdProvided && !cwd) {
          this.error(id, -32600, "session/new cwd must be a non-empty absolute path");
          return;
        }
        if (cwd && !isAbsolute(cwd)) {
          this.error(id, -32600, "session/new cwd must be an absolute path");
          return;
        }
        if (cwd && (!existsSync(cwd) || !lstatSync(cwd).isDirectory())) {
          this.error(id, -32600, "session/new cwd must be an existing directory");
          return;
        }
        this.sessions.add(sessionId);
        if (cwd) this.sessionCwds.set(sessionId, cwd);
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
        if (sessionId && this.activeRuns.has(sessionId)) {
          this.error(id, -32600, `session ${sessionId} already has an active prompt`);
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
          const result = await this.opts.runner(
            {
              prompt: text,
              mode: params?.mode ?? "agent",
              ...(sessionId && this.sessionCwds.has(sessionId) ? { repoPath: this.sessionCwds.get(sessionId) } : {}),
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
          if (sessionId) {
            // The turn result is the human-readable summary/answer (the run's
            // primary output), not a raw dumped JSON object the editor can't show.
            const summary = summarizeResult(result);
            if (summary) {
              this.notify("session/update", {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary } },
              });
            }
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
          if (sessionId && this.activeRuns.get(sessionId) === controller) this.activeRuns.delete(sessionId);
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
    let declinedFreeText = false;
    for (const q of questions) {
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
      const toolCallId = String(request?.interaction_id ?? "interaction");
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
      const response = await this.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: String(q?.question ?? "Question") },
        options,
      });
      this.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
      });
      const optionId = response?.outcome?.optionId ?? response?.optionId;
      const picked = typeof optionId === "string" ? options.find((o: any) => o.optionId === optionId) : undefined;
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

/**
 * Reduce a run result to the human-readable text the editor should show. The
 * orchestrator returns an OrchestratorResult whose `summary` is the primary
 * output; prefer it over dumping the whole internal object. Falls back to a
 * compact JSON string only when no summary/text field is present.
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

const EFFORTS: ReadonlySet<string> = new Set(EffortHint.options);
const ACCESS_PROFILES: ReadonlySet<string> = new Set(AccessProfile.options);

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

function validateRunControls(params: unknown): string | null {
  if (!isPlainRecord(params)) return null;
  const allowedKeys = new Set([
    "sessionId",
    "prompt",
    "mode",
    "harness",
    "primaryHarness",
    "web",
    "externalContextPolicy",
    "model",
    "effort",
    "n",
    "race",
    "untilClean",
    "swarm",
    "create",
    "tests",
    "maxUsd",
    "access",
    "protectedPathApprovals",
    "reviewerPanel",
    "reviewerModels",
    "reviewerEfforts",
  ]);
  for (const key of Object.keys(params)) {
    // `_meta` is the PROTOCOL's forward-compat envelope (other parties'
    // standard field), not a Claudexor knob — tolerate it, reject the rest.
    // Unknown CLAUDEXOR fields still fail loudly (typo'd knobs never no-op).
    if (key === "_meta") continue;
    if (!allowedKeys.has(key)) return `unknown session/prompt field: ${key}`;
  }
  if (params.mode !== undefined && (typeof params.mode !== "string" || !ModeKind.safeParse(params.mode).success)) {
    return "mode must be a valid mode";
  }
  const harnessError = validateOptionalNonEmptyString(params.harness, "harness");
  if (harnessError) return harnessError;
  const primaryHarnessError = validateOptionalNonEmptyString(params.primaryHarness, "primaryHarness");
  if (primaryHarnessError) return primaryHarnessError;
  if (params.web !== undefined && (typeof params.web !== "string" || !ExternalContextPolicy.safeParse(params.web).success)) {
    return "web must be a valid external context policy";
  }
  if (
    params.externalContextPolicy !== undefined &&
    (typeof params.externalContextPolicy !== "string" || !ExternalContextPolicy.safeParse(params.externalContextPolicy).success)
  ) {
    return "externalContextPolicy must be a valid external context policy";
  }
  if (
    params.web !== undefined &&
    params.externalContextPolicy !== undefined &&
    params.web !== params.externalContextPolicy
  ) {
    return "web and externalContextPolicy must be equal when both are provided";
  }
  const modelError = validateOptionalNonEmptyString(params.model, "model");
  if (modelError) return modelError;
  if (params.effort !== undefined && (typeof params.effort !== "string" || !EffortHint.safeParse(params.effort).success)) {
    return "effort must be a valid effort value";
  }
  if (params.n !== undefined && (!Number.isInteger(params.n) || (params.n as number) < 1)) {
    return "n must be an integer >= 1";
  }
  for (const name of ["race", "untilClean", "swarm", "create"]) {
    if (params[name] !== undefined && typeof params[name] !== "boolean") {
      return `${name} must be a boolean`;
    }
  }
  if (params.race === true && params.n !== undefined && (params.n as number) < 2) {
    return "race n must be an integer >= 2";
  }
  if (params.tests !== undefined) {
    const testsError = validateStringArray(params.tests, "tests");
    if (testsError) return testsError;
  }
  if (params.maxUsd !== undefined && (typeof params.maxUsd !== "number" || !Number.isFinite(params.maxUsd) || params.maxUsd < 0)) {
    return "maxUsd must be a non-negative number";
  }
  if (params.access !== undefined && (typeof params.access !== "string" || !ACCESS_PROFILES.has(params.access))) {
    return "access must be a valid access profile";
  }
  if (params.reviewerPanel !== undefined) {
    if (!Array.isArray(params.reviewerPanel) || params.reviewerPanel.length === 0) {
      return "reviewerPanel must be a non-empty array";
    }
    for (const entry of params.reviewerPanel) {
      if (!isPlainRecord(entry)) return "reviewerPanel entries must be objects";
      const allowed = new Set(["harness", "model", "effort"]);
      for (const key of Object.keys(entry)) if (!allowed.has(key)) return `unknown reviewerPanel field: ${key}`;
      if (typeof entry.harness !== "string" || entry.harness.trim() === "") return "reviewerPanel[].harness must be a non-empty string";
      if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.trim() === "")) return "reviewerPanel[].model must be a non-empty string";
      if (entry.effort !== undefined && (typeof entry.effort !== "string" || !EFFORTS.has(entry.effort))) return "reviewerPanel[].effort must be a valid effort value";
    }
  }
  const modelsError = validateStringMap(params.reviewerModels, "reviewerModels");
  if (modelsError) return modelsError;
  const effortsError = validateEffortMap(params.reviewerEfforts, "reviewerEfforts");
  if (effortsError) return effortsError;
  if (params.protectedPathApprovals !== undefined) {
    if (!Array.isArray(params.protectedPathApprovals)) return "protectedPathApprovals must be an array";
    for (const entry of params.protectedPathApprovals) {
      if (!isPlainRecord(entry)) return "protectedPathApprovals entries must be objects";
      const allowed = new Set(["path", "reason"]);
      for (const key of Object.keys(entry)) if (!allowed.has(key)) return `unknown protectedPathApprovals field: ${key}`;
      if (typeof entry.path !== "string" || entry.path.trim() === "") return "protectedPathApprovals[].path must be a non-empty string";
      if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.trim() === "")) return "protectedPathApprovals[].reason must be a non-empty string";
    }
  }
  return validateNoInlineSecrets(params, "ACP session/prompt");
}

function validateOptionalNonEmptyString(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") return `${name} must be a non-empty string`;
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
