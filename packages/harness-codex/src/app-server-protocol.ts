import {
  browserMcpCommand,
  type ChildStdin,
  type LiveMessageResult,
  type spawnProcess,
} from "@claudexor/core";
import type {
  EffortHint,
  HarnessEvent,
  HarnessRunSpec,
  HarnessRequestRefusal,
} from "@claudexor/schema";
import { nowIso, redactSecrets } from "@claudexor/util";
import { codexNativeWarningEvents, isCodexNativeWarningMethod } from "./app-server-warnings.js";
import { codexEffortFor } from "./effort-probe.js";
import { parseCodexEvent, type CodexParseState } from "./parse.js";
import { codexRateLimitEvents } from "./quota.js";
import { CodexRpcError } from "./rpc-error.js";
import { codexSandboxMode } from "./sandbox.js";
export { CodexRpcError } from "./rpc-error.js";

export type JsonObject = Record<string, unknown>;

export interface CodexAppServerRunInput {
  bin: string;
  args: string[];
  spec: HarnessRunSpec;
  env: Record<string, string | null | undefined>;
  spawn?: typeof spawnProcess;
  controller?: CodexAppServerController;
  /** The run's ONE effort receipt (`submitted`); resolved from the snapshot when absent. */
  effort?: EffortHint | null;
  pollIntervalMs?: number;
  cancelDeadlineMs?: number;
  /** Bound on the vendor's `turn/steer` answer (default 30 s); see createCodexSteer. */
  steerDeadlineMs?: number;
}

export class CodexServerRequestRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function codexApprovalDenial(params: JsonObject | null): "decline" | "cancel" {
  const offered = params?.["availableDecisions"];
  return Array.isArray(offered) && !offered.includes("decline") ? "cancel" : "decline";
}

/** Server IDs are independent of client IDs; unattended requests never grant authority. */
export function refuseCodexServerRequest(
  message: JsonObject,
  io: Pick<ChildStdin, "write">,
  reason = "this run cannot grant native approval",
): void {
  const method = message["method"];
  if (
    typeof method !== "string" ||
    (typeof message["id"] !== "number" && typeof message["id"] !== "string")
  )
    return;
  const approval =
    method === "item/fileChange/requestApproval" ||
    method === "item/commandExecution/requestApproval";
  io.write(
    `${JSON.stringify({
      id: message["id"],
      ...(approval
        ? { result: { decision: codexApprovalDenial(asObject(message["params"])) } }
        : { error: { code: -32601, message: "Unsupported server request" } }),
    })}\n`,
  );
  throw new CodexServerRequestRefusal(
    approval ? "codex_approval_required" : "codex_request_unsupported",
    approval
      ? `Codex approval refused (${method}): ${reason}; declined without expanding access`
      : `Codex requested an unsupported client action (${method})`,
  );
}

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Startup is not ready while a required MCP server is still initializing. */
export function codexRequiredMcpStatuses(spec: HarnessRunSpec) {
  return new Map<string, { status: "starting" | "ready" | "failed" | "cancelled"; error?: string }>(
    spec.extra_mcp_servers
      .filter((server) => server.required)
      .map((server) => [server.name, { status: "starting" }] as const),
  );
}

export async function waitForCodexMcp(
  statuses: Map<string, { status: "starting" | "ready" | "failed" | "cancelled"; error?: string }>,
  nextNotification: (method: string) => Promise<JsonObject>,
): Promise<void> {
  while (statuses.size) {
    const failed = [...statuses].filter(
      ([, value]) => value.status === "failed" || value.status === "cancelled",
    );
    if (failed.length)
      throw new Error(
        `required MCP servers failed to initialize: ${failed.map(([name, value]) => `${name}: ${value.error ?? value.status}`).join(", ")}`,
      );
    if ([...statuses.values()].every((value) => value.status === "ready")) return;
    await nextNotification("mcpServer/startupStatus/updated");
  }
}

/** Native machine evidence, never a match against the vendor's error wording. */
export function codexRequestRefusal(error: unknown): HarnessRequestRefusal | null {
  if (!(error instanceof CodexRpcError)) return null;
  const data = asObject(error.data);
  if (data?.["input_error_code"] !== "input_too_large") return null;
  const measure = (key: string, positive = false): number | null => {
    const value = data[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0)
      ? value
      : null;
  };
  return {
    kind: "input_too_large",
    scope: "turn_text",
    unit: "unicode_scalars",
    limit: measure("max_chars", true),
    actual: measure("actual_chars"),
    source: "codex.app-server.turn/start",
    native_code: "input_too_large",
  };
}

/** Where a request's answer came from: the vendor's result, its typed refusal, or the transport. */
export type CodexRpcProvenance =
  | { kind: "result"; result: JsonObject }
  | { kind: "rpc_error"; code: number | null; message: string }
  | { kind: "transport"; cause: Error };

/** Typed provenance for a request whose failure must not taint the run. */
export function rpcProvenance(reply: Promise<JsonObject>): Promise<CodexRpcProvenance> {
  return reply.then(
    (result): CodexRpcProvenance => ({ kind: "result", result }),
    (error: unknown): CodexRpcProvenance =>
      error instanceof CodexRpcError
        ? { kind: "rpc_error", code: error.code, message: error.message }
        : { kind: "transport", cause: error instanceof Error ? error : new Error(String(error)) },
  );
}

export interface CodexSteerInput {
  messageId: string;
  text: string;
}

export type CodexSteerFn = (input: CodexSteerInput) => Promise<LiveMessageResult>;

export class CodexAppServerController {
  private cancelRun: (() => Promise<void>) | null = null;
  private steerRun: CodexSteerFn | null = null;
  private steerEnded = false;

  bind(cancel: () => Promise<void>): void {
    this.cancelRun = cancel;
  }

  clear(cancel: () => Promise<void>): void {
    if (this.cancelRun === cancel) this.cancelRun = null;
  }

  async cancel(): Promise<void> {
    await this.cancelRun?.();
  }

  bindSteer(steer: CodexSteerFn): void {
    this.steerRun = steer;
    this.steerEnded = false;
  }

  clearSteer(steer: CodexSteerFn): void {
    if (this.steerRun !== steer) return;
    this.steerRun = null;
    this.steerEnded = true;
  }

  /** Never bound = no app-server channel (legacy exec path); bound then cleared = the session ended. */
  steer(input: CodexSteerInput): Promise<LiveMessageResult> {
    if (this.steerRun) return this.steerRun(input);
    return Promise.resolve(
      this.steerEnded
        ? { outcome: "not_active", reason: "no_active_turn" }
        : { outcome: "unsupported", reason: "no_live_session" },
    );
  }
}

export interface CodexSteerDeps {
  sessionId: string;
  threadId: () => string | null;
  activeTurnId: () => string | null;
  /** False once cancellation was requested or the app-server process stopped. */
  live: () => boolean;
  /** The NON-tainting request variant: a refusal here never marks the run errored. */
  send: (method: string, params: JsonObject) => Promise<CodexRpcProvenance>;
  /** Bound on the vendor's answer; past it the message may still have landed. */
  responseDeadlineMs: number;
}

export interface CodexSteer {
  send: CodexSteerFn;
  /** onMessage hook, in arrival order: a userMessage echo settles its pending steer as delivered. */
  observeEcho(notification: JsonObject): void;
  /** Main-loop hook: the typed delivery receipt for an observed echo, emitted once. */
  deliveredEvents(notification: JsonObject): HarnessEvent[] | null;
}

interface SteerCorrelation {
  turnId: string;
  settle: (result: LiveMessageResult) => void;
  delivered: boolean;
  announced: boolean;
}

/** The echo of a steered message: a userMessage item whose clientId names the steer. */
function steerEcho(
  notification: JsonObject,
): { clientId: string; threadId: unknown; turnId: unknown } | null {
  const method = notification["method"];
  if (method !== "item/started" && method !== "item/completed") return null;
  const params = asObject(notification["params"]);
  const item = asObject(params?.["item"]);
  if (item?.["type"] !== "userMessage" || typeof item["clientId"] !== "string") return null;
  return { clientId: item["clientId"], threadId: params?.["threadId"], turnId: params?.["turnId"] };
}

/**
 * Live input for one app-server run: `turn/steer` into the active turn.
 * Outcomes come from the adapter's own state — every codex refusal shares
 * JSON-RPC code -32600, so error prose is never consulted (INV-049):
 * no active turn → `not_active` without an RPC; `{turnId}` → `accepted`;
 * a refusal while the snapshot turn is still active → `rejected`, after the
 * turn moved on → `not_active`; transport loss, a malformed reply or a missed
 * deadline → `delivery_unknown`. The `userMessage` echo carrying our clientId
 * (recorded on codex-cli 0.156.1) proves consumption: it settles a still-open
 * steer as `delivered` and yields one `live_input_delivered` status event.
 * A steer never cancels or fails the run.
 */
export function createCodexSteer(deps: CodexSteerDeps): CodexSteer {
  const correlations = new Map<string, SteerCorrelation>();
  const matching = (notification: JsonObject): SteerCorrelation | null => {
    const echo = steerEcho(notification);
    const correlation = echo ? correlations.get(echo.clientId) : undefined;
    if (!echo || !correlation) return null;
    if (echo.threadId !== undefined && echo.threadId !== deps.threadId()) return null;
    if (echo.turnId !== undefined && echo.turnId !== correlation.turnId) return null;
    return correlation;
  };
  return {
    send(input) {
      const threadId = deps.threadId();
      const turnId = deps.activeTurnId();
      if (!deps.live() || !threadId || !turnId)
        return Promise.resolve({ outcome: "not_active", reason: "no_active_turn" });
      return new Promise<LiveMessageResult>((resolve) => {
        let settled = false;
        const settle = (result: LiveMessageResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(
          () => settle({ outcome: "delivery_unknown", reason: "response_timeout" }),
          deps.responseDeadlineMs,
        );
        // Registered BEFORE the write: an echo that beats the reply still counts.
        correlations.set(input.messageId, { turnId, settle, delivered: false, announced: false });
        void deps
          .send("turn/steer", {
            threadId,
            expectedTurnId: turnId,
            clientUserMessageId: input.messageId,
            input: [{ type: "text", text: input.text, text_elements: [] }],
          })
          .then((reply) => {
            if (reply.kind === "result") {
              const nativeTurnId = reply.result["turnId"];
              settle(
                typeof nativeTurnId === "string"
                  ? { outcome: "accepted", nativeTurnId }
                  : { outcome: "delivery_unknown", reason: "transport_lost" },
              );
            } else if (reply.kind === "rpc_error") {
              settle(
                deps.activeTurnId() === turnId
                  ? { outcome: "rejected", reason: "rpc_refused" }
                  : { outcome: "not_active", reason: "no_active_turn" },
              );
            } else settle({ outcome: "delivery_unknown", reason: "transport_lost" });
          });
      });
    },
    observeEcho(notification) {
      const correlation = matching(notification);
      if (!correlation || correlation.delivered) return;
      correlation.delivered = true;
      correlation.settle({ outcome: "delivered", nativeTurnId: correlation.turnId });
    },
    deliveredEvents(notification) {
      const correlation = matching(notification);
      if (!correlation?.delivered) return null;
      if (correlation.announced) return [];
      correlation.announced = true;
      const messageId = steerEcho(notification)?.clientId ?? "";
      return [
        {
          type: "status",
          session_id: deps.sessionId,
          ts: nowIso(),
          text: `live message ${messageId} consumed by turn ${correlation.turnId}`,
          payload: {
            code: "live_input_delivered",
            message_id: messageId,
            native_turn_id: correlation.turnId,
          },
        },
      ];
    },
  };
}

export type CodexRequest = (method: string, params: JsonObject) => Promise<JsonObject>;

export interface CodexThreadLifecycle {
  threadStatus: string | null;
  threadSettled: boolean;
  goalActive: boolean;
  ownedBackground: JsonObject[];
}

async function backgroundTerminals(request: CodexRequest, threadId: string): Promise<JsonObject[]> {
  const terminals: JsonObject[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const result = await request("thread/backgroundTerminals/list", {
      threadId,
      ...(cursor ? { cursor } : {}),
    });
    if (Array.isArray(result["data"]))
      terminals.push(
        ...result["data"].map(asObject).filter((item): item is JsonObject => item !== null),
      );
    const nextCursor =
      typeof result["nextCursor"] === "string" && result["nextCursor"]
        ? result["nextCursor"]
        : undefined;
    if (!nextCursor) return terminals;
    if (seenCursors.has(nextCursor))
      throw new Error("Codex app-server repeated a background terminal cursor");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/** Quiescence facts of the run's thread: status, goal, and the run-owned background terminals. */
export async function readCodexLifecycle(
  request: CodexRequest,
  threadId: string | null,
  ownedCommandItemIds: ReadonlySet<string>,
): Promise<CodexThreadLifecycle> {
  if (!threadId)
    return { threadStatus: null, threadSettled: false, goalActive: false, ownedBackground: [] };
  const [threadResult, goalResult, terminals] = await Promise.all([
    request("thread/read", { threadId, includeTurns: false }),
    request("thread/goal/get", { threadId }),
    backgroundTerminals(request, threadId),
  ]);
  const status = asObject(asObject(threadResult["thread"])?.["status"]);
  const threadStatus = typeof status?.["type"] === "string" ? status["type"] : null;
  const goal = asObject(goalResult["goal"]);
  return {
    threadStatus,
    threadSettled: threadStatus === "idle" || threadStatus === "systemError",
    goalActive: goal?.["status"] === "active",
    ownedBackground: terminals.filter(
      (terminal) =>
        typeof terminal["itemId"] === "string" && ownedCommandItemIds.has(terminal["itemId"]),
    ),
  };
}

export function codexAppServerThreadParams(
  spec: HarnessRunSpec,
  /** The run's ONE effort receipt (`submitted`); arg-shape callers resolve on the snapshot. */
  effort: EffortHint | null = codexEffortFor(undefined, spec.model_hint, spec.effort_hint),
): JsonObject {
  const mcpServers: Record<string, JsonObject> = {};
  if (spec.browser && spec.external_context_policy !== "off") {
    const browser = browserMcpCommand(spec.browser);
    mcpServers["browser"] = {
      command: browser.command,
      args: browser.args,
      startup_timeout_sec: 90,
      tool_timeout_sec: 120,
    };
  }
  for (const server of spec.extra_mcp_servers) {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args,
      env: server.env,
      required: server.required,
      startup_timeout_sec: 90,
      tool_timeout_sec: 120,
    };
  }
  const config: JsonObject = {
    web_search:
      spec.external_context_policy === "off"
        ? "disabled"
        : spec.external_context_policy === "live"
          ? "live"
          : "cached",
    project_doc_fallback_filenames: ["CLAUDE.md"],
    ...(Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {}),
  };
  if (effort) config["model_reasoning_effort"] = effort;
  if (spec.processing?.submittedNative) config["service_tier"] = spec.processing.submittedNative;
  const sandbox = codexSandboxMode(spec.access);
  return {
    cwd: spec.cwd,
    model: spec.model_hint,
    ...(sandbox ? { sandbox } : {}),
    ...codexAppServerApprovalParams(spec),
    ...(spec.instructions?.trim() ? { developerInstructions: spec.instructions } : {}),
    config,
  };
}

export function codexAppServerApprovalParams(spec: HarnessRunSpec): JsonObject {
  return {
    // Native automatic review needs an interactive policy to receive requests.
    approvalPolicy: spec.access === "workspace_write" ? "on-request" : "never",
    approvalsReviewer: "auto_review",
  };
}

function appServerItem(item: JsonObject): JsonObject {
  const type = item["type"];
  if (type === "agentMessage") return { ...item, type: "agent_message" };
  if (type === "commandExecution")
    return {
      ...item,
      type: "command_execution",
      aggregated_output: item["aggregatedOutput"],
      exit_code: item["exitCode"],
    };
  if (type === "fileChange")
    return {
      ...item,
      type: "file_change",
      path: Array.isArray(item["changes"]) ? asObject(item["changes"][0])?.["path"] : undefined,
    };
  if (type === "mcpToolCall") return { ...item, type: "mcp_tool_call" };
  if (type === "webSearch") return { ...item, type: "web_search" };
  if (type === "reasoning")
    return {
      ...item,
      text: [
        ...(Array.isArray(item["summary"]) ? item["summary"] : []),
        ...(Array.isArray(item["content"]) ? item["content"] : []),
      ].join("\n"),
    };
  return item;
}

/** Map official app-server notifications onto the adapter's existing event vocabulary. */
export function codexAppServerEvents(
  notification: JsonObject,
  sessionId: string,
  state: CodexParseState,
): HarnessEvent[] | null {
  const method = notification["method"];
  const params = asObject(notification["params"]);
  if (!params) return null;
  if (method === "account/rateLimits/updated") return codexRateLimitEvents(params, sessionId);
  if (isCodexNativeWarningMethod(method))
    return codexNativeWarningEvents(method, params, sessionId);
  if (method === "error" && params["willRetry"] === true) {
    // A vendor transport error is an engine diagnostic, masked where it is
    // created (INV-146); it is not the user's working content.
    const safe = JSON.parse(redactSecrets(JSON.stringify(params))) as JsonObject;
    const message = asObject(safe["error"])?.["message"];
    return [
      {
        type: "status",
        session_id: sessionId,
        ts: nowIso(),
        ...(typeof message === "string" ? { text: message } : {}),
        status: { kind: "api_retry" },
        payload: safe,
      },
    ];
  }
  if (method === "item/started" || method === "item/completed") {
    const item = asObject(params["item"]);
    if (!item) return null;
    const items =
      item["type"] === "fileChange" && Array.isArray(item["changes"])
        ? item["changes"]
            .map(asObject)
            .filter((change): change is JsonObject => typeof change?.["path"] === "string")
            .map((change) => ({ ...appServerItem(item), path: change["path"] }))
        : [appServerItem(item)];
    const events: HarnessEvent[] = [];
    for (const mappedItem of items) {
      const mapped = parseCodexEvent(
        {
          type: method === "item/started" ? "item.started" : "item.completed",
          item: mappedItem,
        },
        sessionId,
        state,
      );
      if (mapped === null) return null;
      events.push(...mapped);
    }
    return events;
  }
  if (method === "turn/plan/updated") {
    const plan = Array.isArray(params["plan"]) ? params["plan"] : [];
    const items = plan.map((raw, index) => {
      const step = asObject(raw);
      return {
        id: `codex-${index}`,
        title: String(step?.["step"] ?? ""),
        status:
          step?.["status"] === "completed"
            ? ("completed" as const)
            : step?.["status"] === "inProgress"
              ? ("in_progress" as const)
              : ("pending" as const),
      };
    });
    const key = JSON.stringify(items);
    if (state.lastPlanProgressKey === key) return [];
    state.lastPlanProgressKey = key;
    return [
      {
        type: "message",
        session_id: sessionId,
        ts: nowIso(),
        text: items.length
          ? `Plan:\n${items.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.title}`).join("\n")}`
          : "Plan updated",
        plan_progress: { items },
      },
    ];
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = asObject(asObject(params["tokenUsage"])?.["last"]);
    if (!usage) return null;
    const number = (key: string): number | undefined =>
      typeof usage[key] === "number" ? usage[key] : undefined;
    return [
      {
        type: "usage",
        session_id: sessionId,
        ts: nowIso(),
        usage: {
          input_tokens: number("inputTokens"),
          output_tokens: number("outputTokens"),
          cached_input_tokens: number("cachedInputTokens"),
          input_token_usage: {
            total_tokens: number("inputTokens") ?? null,
            cache_read_tokens: number("cachedInputTokens") ?? null,
            cache_write_tokens: number("cacheWriteInputTokens") ?? null,
          },
        },
      },
    ];
  }
  return null;
}
