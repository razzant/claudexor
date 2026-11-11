import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  Readable,
  Writable,
  type Readable as NodeReadableStream,
  type Writable as NodeWritableStream,
} from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { acpStopReason, RunOutcomeFacts } from "@claudexor/schema";
import {
  extractPromptText,
  renderPlanQuestions,
  summarizeResult,
  type AcpPlanQuestion,
} from "./prompt.js";
import { runControlsFromMeta, validateRunControls } from "./validate.js";
import { terminalAuth, type AcpAuthOptions } from "./auth.js";
import { attachmentInputs } from "./attachments.js";
import { AcpClosedHandoffs, acpToolCallId, acpToolOwner, toolResultUpdate } from "./tool-update.js";
import { requestInteractionAnswers } from "./interaction-answers.js";

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;

export interface RunnerHooks {
  onEvent?: (event: any) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
}

export type RunnerFn = (params: any, hooks?: RunnerHooks) => Promise<unknown>;
export interface AcpServerOptions extends AcpAuthOptions {
  runner: RunnerFn;
  transport: { read: NodeReadableStream; write: NodeWritableStream };
  name?: string;
  version?: string;
}

type AcpSessionRecord = {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  // Ordered replay history for session/load: each turn carries the user prompt
  // and the agent's typed primary output (null when a turn produced none, e.g.
  // a runless refusal). Absent for resume, which never replays.
  turns?: Array<{
    prompt?: string;
    output?: { kind?: string; text?: string; truncated?: boolean } | null;
  }>;
};

/** Official ACP SDK projection over Claudexor's daemon-owned threads. The SDK
 * owns parsing, protocol negotiation, cancellation, and JSON-RPC framing; this
 * class only translates stable ACP session methods to the injected /v2 runner. */
export class AcpServer {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly openToolCalls = new Map<string, string[]>();
  private readonly closedHandoffs = new AcpClosedHandoffs();

  constructor(private readonly opts: AcpServerOptions) {}

  async serve(): Promise<void> {
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.opts.transport.write) as globalThis.WritableStream<Uint8Array>,
      Readable.toWeb(this.opts.transport.read) as globalThis.ReadableStream<Uint8Array>,
    );
    const app = acp
      .agent({ name: this.opts.name ?? "claudexor" })
      .onRequest(acp.methods.agent.initialize, ({ params }) => ({
        protocolVersion:
          params.protocolVersion === ACP_PROTOCOL_VERSION
            ? params.protocolVersion
            : ACP_PROTOCOL_VERSION,
        agentInfo: { name: this.opts.name ?? "claudexor", version: this.opts.version ?? "dev" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: terminalAuth(params.clientCapabilities, this.opts.terminalAuthMethods),
      }))
      .onRequest(acp.methods.agent.session.new, async ({ params }) => {
        this.assertProjectRoot(params.cwd);
        const record = await this.sessionCall("new", {
          cwd: params.cwd,
          additionalDirectories: params.additionalDirectories ?? [],
        });
        return { sessionId: record.sessionId };
      })
      .onRequest(acp.methods.agent.session.list, async ({ params }) => {
        if (params.cwd != null) this.assertAbsolutePath(params.cwd, "session/list cwd");
        const result = (await this.opts.runner({
          mode: "__acp_session_list",
          repoPath: params.cwd ?? undefined,
          cursor: params.cursor ?? undefined,
        })) as { sessions?: AcpSessionRecord[]; nextCursor?: string | null };
        return {
          sessions: (result.sessions ?? []).map((session) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            ...(session.title != null ? { title: session.title } : {}),
            ...(session.updatedAt != null ? { updatedAt: session.updatedAt } : {}),
          })),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        };
      })
      .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
        this.assertProjectRoot(params.cwd);
        const record = await this.sessionCall("load", params);
        // ACP loadSession MUST replay the ENTIRE conversation via session/update
        // BEFORE responding (QA-020). Emit the ordered user/agent pair per turn:
        // the stored user prompt as a user_message_chunk, then the run's typed
        // primary output as an agent_message_chunk. Neither half is dropped
        // silently — a runless turn still shows its prompt, and its disclosed
        // failure text rides the agent half.
        for (const turn of record.turns ?? []) {
          if (turn.prompt?.trim()) {
            await this.userMessage(client, record.sessionId, turn.prompt.trim());
          }
          if (turn.output?.text?.trim()) {
            await this.agentMessage(client, record.sessionId, turn.output.text.trim());
          }
        }
        return {};
      })
      .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
        this.assertProjectRoot(params.cwd);
        await this.sessionCall("resume", params);
        return {};
      })
      .onRequest(acp.methods.agent.session.close, async ({ params }) => {
        this.activeRuns.get(params.sessionId)?.abort();
        await this.opts.runner({ mode: "__acp_session_close", sessionId: params.sessionId });
        this.activeRuns.delete(params.sessionId);
        this.dropToolCalls(params.sessionId);
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
        const controls = runControlsFromMeta(params._meta);
        const validation = validateRunControls({
          sessionId: params.sessionId,
          prompt: params.prompt,
          ...controls,
        });
        if (validation) throw new Error(validation.message);
        if (this.activeRuns.has(params.sessionId)) {
          throw new Error(`session ${params.sessionId} already has an active prompt`);
        }
        const controller = new AbortController();
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        this.activeRuns.set(params.sessionId, controller);
        try {
          const { mode: requestedMode, ...runControls } = controls;
          const result = (await this.opts.runner(
            {
              ...runControls,
              mode: "__acp_session_prompt",
              ...(requestedMode !== undefined ? { runMode: requestedMode } : {}),
              sessionId: params.sessionId,
              prompt: extractPromptText(params.prompt),
              attachments: attachmentInputs(params.prompt),
            },
            {
              signal: controller.signal,
              onEvent: (event) => void this.forwardRunEvent(client, params.sessionId, event),
              onInteraction: (ctx) =>
                requestInteractionAnswers(client, params.sessionId, ctx, (text) =>
                  this.agentMessage(client, params.sessionId, text),
                ),
            },
          )) as Record<string, unknown>;
          const summary = summarizeResult(result);
          if (summary) await this.agentMessage(client, params.sessionId, summary);
          // Plan questions end as turn text and continue next prompt; runtime choices use requestPermission.
          const planReadiness = result.planReadiness as { state?: string } | null | undefined;
          if (planReadiness?.state === "needs_answers") {
            const questions = Array.isArray(result.planQuestions)
              ? (result.planQuestions as AcpPlanQuestion[])
              : [];
            const rendered = renderPlanQuestions(questions);
            if (rendered) await this.agentMessage(client, params.sessionId, rendered);
          }
          // Project lifecycle status through the canonical ACP stop-reason owner.
          const status = typeof result.status === "string" ? result.status : "unknown";
          const parsedOutcomeFacts = RunOutcomeFacts.safeParse(result.outcomeFacts);
          const outcomeFacts = parsedOutcomeFacts.success ? parsedOutcomeFacts.data : null;
          const stopReason: acp.StopReason = controller.signal.aborted
            ? "cancelled"
            : acpStopReason(status, outcomeFacts?.reason ?? null);
          return {
            stopReason,
            _meta: {
              claudexor: {
                runId: result.runId ?? null,
                status,
                runFacts: result.runFacts ?? null,
                outcomeFacts,
                outcomeBanner: result.outcomeBanner ?? null,
                failure: result.failure ?? null,
                applyEligibility: result.applyEligibility ?? null,
                detailProblem: result.detailProblem ?? null,
              },
            },
          };
        } finally {
          if (this.activeRuns.get(params.sessionId) === controller)
            this.activeRuns.delete(params.sessionId);
          // The turn's run is over: its calls are never closed or refined later.
          this.dropToolCalls(params.sessionId);
        }
      })
      .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
        this.activeRuns.get(params.sessionId)?.abort("user_cancelled");
      });

    const connection = app.connect(stream);
    await connection.closed;
  }

  private async sessionCall(
    action: "new" | "load" | "resume",
    params: Record<string, unknown>,
  ): Promise<AcpSessionRecord> {
    return (await this.opts.runner({
      mode: `__acp_session_${action}`,
      sessionId: params["sessionId"],
      repoPath: params["cwd"],
      additionalDirectories: params["additionalDirectories"],
    })) as AcpSessionRecord;
  }

  private assertProjectRoot(path: string): void {
    this.assertAbsolutePath(path, "session cwd");
    try {
      if (statSync(path).isDirectory()) return;
    } catch {
      // Fall through to the stable ACP error below. statSync follows a valid
      // directory symlink, matching run-start admission and project identity.
    }
    throw new Error("session cwd must be an existing directory");
  }

  private assertAbsolutePath(path: string, name: string): void {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) {
      throw new Error(`${name} must be a non-empty absolute path`);
    }
  }

  private async agentMessage(
    client: acp.AgentContext,
    sessionId: string,
    text: string,
  ): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async userMessage(
    client: acp.AgentContext,
    sessionId: string,
    text: string,
  ): Promise<void> {
    await client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async forwardRunEvent(
    client: acp.AgentContext,
    sessionId: string,
    event: any,
  ): Promise<void> {
    const type = String(event?.type ?? "");
    const payload = (event?.payload ?? {}) as Record<string, any>;
    if (type === "surface.warning" && typeof payload.message === "string")
      return this.agentMessage(client, sessionId, payload.message);
    if (
      type === "control.applied" &&
      payload.control?.kind === "time_limit" &&
      payload.control?.action === "reached" &&
      payload.timeLimit?.mode === "soft"
    )
      return this.agentMessage(client, sessionId, "Soft time limit reached; work continues.");
    if (type !== "harness.event") return;
    const sub = String(payload["type"] ?? "");
    const tool = payload["tool"] as Record<string, any> | undefined;
    // A call belongs to the run and try that issued it, never to a bare native id (X2).
    const owner = acpToolOwner(event);
    const useId = typeof tool?.["use_id"] === "string" ? (tool["use_id"] as string) : null;
    const unnamed = `${sessionId}\0${owner}\0${String(tool?.["name"] ?? "")}`;
    if ((sub === "message" || sub === "thinking") && typeof payload["text"] === "string") {
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: sub === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
          content: { type: "text", text: payload["text"] },
        },
      });
      return;
    }
    if (sub === "tool_call" && tool) {
      const id = useId === null ? `tc-${crypto.randomUUID()}` : acpToolCallId(owner, useId);
      if (useId === null)
        this.openToolCalls.set(unnamed, [...(this.openToolCalls.get(unnamed) ?? []), id]);
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: String(tool["name"] ?? "tool"),
          status: "in_progress",
        },
      });
      return;
    }
    const update = this.closedHandoffs.refinement(sessionId, event);
    if (update) await client.notify(acp.methods.client.session.update, { sessionId, update });
    if (sub === "tool_result" && tool) {
      const queue = this.openToolCalls.get(unnamed);
      const id = useId === null ? queue?.shift() : acpToolCallId(owner, useId);
      if (queue?.length === 0) this.openToolCalls.delete(unnamed);
      if (!id) return;
      this.closedHandoffs.closed(sessionId, id, tool);
      const closing = toolResultUpdate(id, tool);
      await client.notify(acp.methods.client.session.update, { sessionId, update: closing });
    }
  }

  private dropToolCalls(sessionId: string): void {
    this.closedHandoffs.drop(sessionId);
    for (const key of this.openToolCalls.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.openToolCalls.delete(key);
    }
  }
}
