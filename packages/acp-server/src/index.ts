import { existsSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  Readable,
  Writable,
  type Readable as NodeReadableStream,
  type Writable as NodeWritableStream,
} from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { acpStopReason } from "@claudexor/schema";
import {
  extractPromptText,
  renderPlanQuestions,
  summarizeResult,
  type AcpPlanQuestion,
} from "./prompt.js";
import { validateRunControls } from "./validate.js";

export const ACP_PROTOCOL_VERSION = acp.PROTOCOL_VERSION;

export interface RunnerHooks {
  onEvent?: (event: any) => void;
  onInteraction?: (ctx: any) => Promise<any | null>;
  signal?: AbortSignal;
}

export type RunnerFn = (params: any, hooks?: RunnerHooks) => Promise<unknown>;

export interface AcpServerOptions {
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

/**
 * Official ACP SDK projection over Claudexor's daemon-owned threads. The SDK
 * owns parsing, protocol negotiation, cancellation, and JSON-RPC framing; this
 * class only translates stable ACP session methods to the injected /v2 runner.
 */
export class AcpServer {
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly openToolCalls = new Map<string, string[]>();

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
        authMethods: [],
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
        const controls = this.controls(params._meta);
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
              onInteraction: (ctx) => this.requestAnswers(client, params.sessionId, ctx),
            },
          )) as Record<string, unknown>;
          const summary = summarizeResult(result);
          if (summary) await this.agentMessage(client, params.sessionId, summary);
          // Plan lifecycle (D14/D17): a plan turn that ends needs_answers renders
          // its ENGINE-parsed open questions as TURN TEXT and ends the turn — the
          // user's next prompt is an ordinary follow-up plan turn on this same
          // session (POST /threads/:id/turns), the same path every surface uses.
          // Single-choice RUN-TIME interactions keep the requestPermission bridge
          // (requestAnswers); this is the end-of-turn typed-question batch.
          const planReadiness = result.planReadiness as { state?: string } | null | undefined;
          if (planReadiness?.state === "needs_answers") {
            const questions = Array.isArray(result.planQuestions)
              ? (result.planQuestions as AcpPlanQuestion[])
              : [];
            const rendered = renderPlanQuestions(questions);
            if (rendered) await this.agentMessage(client, params.sessionId, rendered);
          }
          // `result.status` is the run LIFECYCLE (D8); the ACP stop reason is
          // projected through the ONE owner (acpStopReason).
          const status = typeof result.status === "string" ? result.status : "unknown";
          const stopReason: acp.StopReason = controller.signal.aborted
            ? "cancelled"
            : acpStopReason(status);
          return {
            stopReason,
            _meta: {
              claudexor: {
                runId: result.runId ?? null,
                status,
                applyEligibility: result.applyEligibility ?? null,
              },
            },
          };
        } finally {
          if (this.activeRuns.get(params.sessionId) === controller)
            this.activeRuns.delete(params.sessionId);
        }
      })
      .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
        this.activeRuns.get(params.sessionId)?.abort();
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
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error("session cwd must be an existing directory");
    }
  }

  private assertAbsolutePath(path: string, name: string): void {
    if (typeof path !== "string" || !path.trim() || !isAbsolute(path)) {
      throw new Error(`${name} must be a non-empty absolute path`);
    }
  }

  private controls(meta: unknown): Record<string, unknown> {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
    const value = (meta as Record<string, unknown>)["claudexor"];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
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
    if (type !== "harness.event") return;
    const sub = String(payload["type"] ?? "");
    const tool = payload["tool"] as Record<string, any> | undefined;
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
      const id = String(tool["use_id"] ?? `tc-${crypto.randomUUID()}`);
      if (typeof tool["use_id"] !== "string") {
        const key = `${sessionId}:${String(tool["name"] ?? "")}`;
        this.openToolCalls.set(key, [...(this.openToolCalls.get(key) ?? []), id]);
      }
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
    if (sub === "tool_result" && tool) {
      const key = `${sessionId}:${String(tool["name"] ?? "")}`;
      const queue = this.openToolCalls.get(key);
      const id = typeof tool["use_id"] === "string" ? tool["use_id"] : queue?.shift();
      if (queue?.length === 0) this.openToolCalls.delete(key);
      if (!id) return;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: tool["status"] === "error" ? "failed" : "completed",
        },
      });
    }
  }

  private async requestAnswers(
    client: acp.AgentContext,
    sessionId: string,
    ctx: any,
  ): Promise<any | null> {
    const request = ctx?.request;
    const runId = typeof ctx?.run_id === "string" ? ctx.run_id : "";
    const questions: any[] = Array.isArray(request?.questions) ? request.questions : [];
    const answers: any[] = [];
    const unanswerable: string[] = [];
    for (const [index, question] of questions.entries()) {
      const rawOptions = Array.isArray(question?.options) ? question.options : [];
      const options = rawOptions.map((option: any, optionIndex: number) => ({
        optionId: `opt-${optionIndex + 1}`,
        name: String(option?.label ?? `option ${optionIndex + 1}`),
        kind: "allow_once" as const,
      }));
      // Option-less (free-text) questions cannot be answered through ACP's
      // permission mechanism (which is choice-only). NEVER silently skip them:
      // collect them and disclose as turn text below, naming the documented
      // answer path, and leave the interaction pending so it stays answerable.
      if (options.length === 0) {
        unanswerable.push(String(question?.question ?? `question ${index + 1}`));
        continue;
      }
      const title = String(question?.question ?? "Question");
      const multi = question?.multi_select === true;
      if (multi) {
        // Multi-select: iterate one include/skip permission round per option so
        // the client can pick MORE THAN ONE label (a single requestPermission
        // returns exactly one optionId and would collapse the selection).
        const selectedLabels: string[] = [];
        for (const option of options) {
          const toolCallId = `${String(request?.interaction_id ?? "interaction")}:${String(question?.id ?? index)}:${option.optionId}`;
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `${title} — include "${option.name}"?`,
              kind: "other",
              status: "pending",
            },
          });
          const response = (await client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId, title: `${title} — include "${option.name}"?` },
            options: [
              { optionId: "include", name: `Include ${option.name}`, kind: "allow_once" as const },
              { optionId: "skip", name: `Skip ${option.name}`, kind: "reject_once" as const },
            ],
          })) as acp.RequestPermissionResponse;
          const include =
            response.outcome.outcome === "selected" && response.outcome.optionId === "include";
          if (include) selectedLabels.push(option.name);
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" },
          });
        }
        answers.push({
          question_id: String(question?.id ?? ""),
          selected_labels: selectedLabels,
          free_text: null,
        });
        continue;
      }
      const toolCallId = `${String(request?.interaction_id ?? "interaction")}:${String(question?.id ?? index)}`;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "other",
          status: "pending",
        },
      });
      const response = (await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId, title },
        options,
      })) as acp.RequestPermissionResponse;
      const outcome = response.outcome;
      const selected =
        outcome.outcome === "selected"
          ? options.find((option: { optionId: string }) => option.optionId === outcome.optionId)
          : undefined;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: selected ? "completed" : "failed",
        },
      });
      if (selected) {
        answers.push({
          question_id: String(question?.id ?? ""),
          selected_labels: [selected.name],
          free_text: null,
        });
      }
    }
    if (unanswerable.length > 0) {
      // Honest disclosure (never a silent skip): the free-text question(s) stay
      // pending on the run; the editor's user answers them via the CLI/API.
      const runHint = runId ? `\`claudexor follow ${runId}\`` : "`claudexor follow <run>`";
      const list = unanswerable.map((q, i) => `${i + 1}. ${q}`).join("\n");
      await this.agentMessage(
        client,
        sessionId,
        `This run is waiting on ${unanswerable.length} free-text question(s) that ACP cannot answer inline (ACP presents choices only):\n\n${list}\n\nAnswer them with ${runHint} or POST /v2/runs/:id/interactions/:id/answer; the run stays paused until then.`,
      );
    }
    return answers.length > 0
      ? { interaction_id: String(request?.interaction_id ?? ""), answers }
      : null;
  }

  private dropToolCalls(sessionId: string): void {
    for (const key of this.openToolCalls.keys()) {
      if (key.startsWith(`${sessionId}:`)) this.openToolCalls.delete(key);
    }
  }
}

function attachmentInputs(prompt: acp.ContentBlock[]): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  for (const [index, block] of prompt.entries()) {
    if (block.type === "image") {
      attachments.push({
        kind: "image",
        mime: block.mimeType,
        name: `acp-image-${index + 1}`,
        data: block.data,
      });
    } else if (block.type === "resource" && "blob" in block.resource) {
      attachments.push({
        kind: "file",
        mime: block.resource.mimeType ?? "application/octet-stream",
        name: `acp-resource-${index + 1}`,
        data: block.resource.blob,
      });
    } else if (block.type === "resource" && "text" in block.resource) {
      attachments.push({
        kind: "file",
        mime: block.resource.mimeType ?? "text/plain",
        name: `acp-resource-${index + 1}`,
        data: Buffer.from(block.resource.text, "utf8").toString("base64"),
      });
    }
  }
  return attachments;
}
