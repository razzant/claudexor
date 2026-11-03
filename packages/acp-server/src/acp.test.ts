import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { noProjectRepoRoot } from "@claudexor/util";
import { describe, expect, it } from "vitest";
import { AcpEvents } from "../../harness-acp/src/events.js";
import { ACP_PROTOCOL_VERSION, AcpServer, type RunnerFn } from "./index.js";
import { rmSync as __rmSyncReap } from "node:fs";
import { afterAll as __afterAllReap } from "vitest";

// W-h: reap every temp dir this suite creates so the gate stops leaking tmpdirs.
const __reapDirs: string[] = [];
function reapMk(...args: Parameters<typeof mkdtempSync>): string {
  const dir = mkdtempSync(...args);
  __reapDirs.push(dir);
  return dir;
}
__afterAllReap(() => {
  for (const dir of __reapDirs.splice(0)) __rmSyncReap(dir, { recursive: true, force: true });
}, 0); // synchronous removal: no deadline (#376, see vitest.setup.ts)

function project(): string {
  return reapMk(join(tmpdir(), "claudexor-acp-project-"));
}

async function withClient<T>(
  runner: RunnerFn,
  op: (agent: acp.ClientContext, updates: acp.SessionNotification[]) => Promise<T>,
  options: Pick<ConstructorParameters<typeof AcpServer>[0], "terminalAuthMethods"> = {},
  /** Which permission option the editor picks (the first one by default);
   * `null` dismisses the prompt. Sees the whole permission request. */
  choose: (
    options: Array<{ optionId: string }>,
    request: acp.RequestPermissionRequest,
  ) => string | null = (options) => options[0]?.optionId ?? "",
): Promise<T> {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const server = new AcpServer({
    runner,
    transport: { read: clientToAgent, write: agentToClient },
    version: "2.0.0-test",
    ...options,
  });
  const serving = server.serve();
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: "claudexor-test-client" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const optionId = choose(params.options, params);
      return {
        outcome:
          optionId === null
            ? { outcome: "cancelled" as const }
            : { outcome: "selected" as const, optionId },
      };
    });
  const stream = acp.ndJsonStream(
    Writable.toWeb(clientToAgent) as globalThis.WritableStream<Uint8Array>,
    Readable.toWeb(agentToClient) as globalThis.ReadableStream<Uint8Array>,
  );
  try {
    return await client.connectWith(stream, (agent) => op(agent, updates));
  } finally {
    clientToAgent.end();
    await serving;
  }
}

describe("AcpServer official SDK projection", () => {
  it("forwards explicit soft timer controls and presents the reached warning without cancelling", async () => {
    await withClient(
      async (params, hooks) => {
        expect(params).toMatchObject({ maxSeconds: 60, timeLimitMode: "soft" });
        hooks?.onEvent?.({
          type: "control.applied",
          payload: {
            control: { kind: "time_limit", action: "reached" },
            timeLimit: { mode: "soft" },
          },
        });
        return { summary: "completed normally", status: "succeeded" };
      },
      async (agent, updates) => {
        const result = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: "timer-session",
          prompt: [{ type: "text", text: "work" }],
          _meta: { claudexor: { maxSeconds: 60, timeLimitMode: "soft" } },
        });
        expect(result.stopReason).toBe("end_turn");
        expect(JSON.stringify(updates)).toContain("Soft time limit reached; work continues");
      },
    );
  });
  it("emits experimental terminal auth methods only after client opt-in", async () => {
    const method: acp.AuthMethodTerminal & { type: "terminal" } = {
      type: "terminal",
      id: "codex",
      name: "Sign in to Codex",
      args: ["auth", "login", "codex"],
    };
    await withClient(
      async () => ({}),
      async (agent) => {
        const unsupported = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        expect(unsupported.authMethods).toEqual([]);
      },
      { terminalAuthMethods: [method] },
    );
    await withClient(
      async () => ({}),
      async (agent) => {
        const supported = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        expect(supported.authMethods).toEqual([method]);
      },
      { terminalAuthMethods: [method] },
    );
    await withClient(
      async () => ({}),
      async (agent) => {
        const registryCompatible = await agent.request(acp.methods.agent.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { _meta: { "terminal-auth": true } },
        });
        expect(registryCompatible.authMethods).toEqual([method]);
      },
      { terminalAuthMethods: [method] },
    );
  });

  it("negotiates stable ACP and projects new/list/load/resume/close to daemon sessions", async () => {
    const cwd = project();
    const calls: any[] = [];
    const runner: RunnerFn = async (params) => {
      calls.push(params);
      switch (params.mode) {
        case "__acp_session_new":
          return { sessionId: "thread-1", cwd };
        case "__acp_session_list":
          return {
            sessions: [
              {
                sessionId: "thread-1",
                cwd,
                title: "ACP session",
                updatedAt: "2026-07-15T00:00:00Z",
              },
            ],
          };
        case "__acp_session_load":
          return {
            sessionId: "thread-1",
            cwd,
            turns: [
              { prompt: "the question", output: { kind: "answer", text: "restored answer" } },
            ],
          };
        case "__acp_session_resume":
        case "__acp_session_close":
          return { sessionId: "thread-1", cwd };
        default:
          throw new Error(`unexpected ${params.mode}`);
      }
    };
    await withClient(runner, async (agent, updates) => {
      // The stable ACP protocol version this server negotiates is pinned to the
      // literal 1 (docs/INTEGRATIONS.md). An SDK bump that moves the stable wire
      // version must fail here rather than silently renegotiate.
      expect(ACP_PROTOCOL_VERSION).toBe(1);
      const initialized = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentCapabilities).toMatchObject({
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      });
      const created = await agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      expect(created.sessionId).toBe("thread-1");
      const listed = await agent.request(acp.methods.agent.session.list, { cwd });
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: "thread-1", cwd, title: "ACP session" }),
      ]);
      await agent.request(acp.methods.agent.session.load, {
        sessionId: "thread-1",
        cwd,
        mcpServers: [],
      });
      expect(updates.some((item) => JSON.stringify(item).includes("restored answer"))).toBe(true);
      await agent.request(acp.methods.agent.session.resume, {
        sessionId: "thread-1",
        cwd,
        mcpServers: [],
      });
      await agent.request(acp.methods.agent.session.close, { sessionId: "thread-1" });
    });
    expect(calls.map((call) => call.mode)).toEqual([
      "__acp_session_new",
      "__acp_session_list",
      "__acp_session_load",
      "__acp_session_resume",
      "__acp_session_close",
    ]);
  });

  it("accepts a symlinked session cwd without rewriting the client spelling", async () => {
    const target = project();
    const parent = reapMk(join(tmpdir(), "claudexor-acp-symlink-"));
    const cwd = join(parent, "project-link");
    symlinkSync(target, cwd, "dir");
    let received: unknown;

    await withClient(
      async (params) => {
        received = params.repoPath;
        return { sessionId: "thread-symlink", cwd };
      },
      async (agent) => {
        const created = await agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        expect(created.sessionId).toBe("thread-symlink");
      },
    );
    expect(received).toBe(cwd);
  });

  it("session/load replays the full history as ordered user/agent pairs before responding (QA-020)", async () => {
    const cwd = project();
    const runner: RunnerFn = async (params) => {
      if (params.mode !== "__acp_session_load") throw new Error(`unexpected ${params.mode}`);
      return {
        sessionId: "thread-h",
        cwd,
        turns: [
          { prompt: "create counter lab", output: { kind: "answer", text: "created 7 files" } },
          { prompt: "what is the project name?", output: { kind: "answer", text: "Counter Lab" } },
        ],
      };
    };
    await withClient(runner, async (agent, updates) => {
      // The load request resolves ONLY after the entire conversation has been
      // streamed, so by here `updates` holds every replay notification in order.
      await agent.request(acp.methods.agent.session.load, {
        sessionId: "thread-h",
        cwd,
        mcpServers: [],
      });
      const replay = updates.map((u) => [
        u.update.sessionUpdate,
        (u.update as { content?: { text?: string } }).content?.text,
      ]);
      expect(replay).toEqual([
        ["user_message_chunk", "create counter lab"],
        ["agent_message_chunk", "created 7 files"],
        ["user_message_chunk", "what is the project name?"],
        ["agent_message_chunk", "Counter Lab"],
      ]);
    });
  });

  it("round-trips a no-project session: list emits the absolute synthetic cwd and load accepts it (QA-068)", async () => {
    // The daemon owns and materializes this canonical no-project execution root
    // at startup; ensure it here so the server's load cwd validation passes.
    const noProjectCwd = noProjectRepoRoot();
    mkdirSync(noProjectCwd, { recursive: true });
    const calls: any[] = [];
    const runner: RunnerFn = async (params) => {
      calls.push(params);
      switch (params.mode) {
        case "__acp_session_list":
          // The CLI runner maps a no-project thread's null repoRoot to this
          // canonical absolute synthetic root — never the invalid empty string.
          return { sessions: [{ sessionId: "np-1", cwd: noProjectCwd, title: "2+2?" }] };
        case "__acp_session_load":
          expect(params.repoPath).toBe(noProjectCwd);
          return { sessionId: "np-1", cwd: noProjectCwd, turns: [] };
        default:
          throw new Error(`unexpected ${params.mode}`);
      }
    };
    await withClient(runner, async (agent) => {
      const listed = await agent.request(acp.methods.agent.session.list, {});
      const row = listed.sessions[0]!;
      expect(isAbsolute(row.cwd)).toBe(true);
      expect(row.cwd).toBe(noProjectCwd);
      // The advertised row is loadable: its exact cwd passes load validation and
      // the runner's same-cwd equality check — no more `-32603` unloadable row.
      await agent.request(acp.methods.agent.session.load, {
        sessionId: row.sessionId,
        cwd: row.cwd,
        mcpServers: [],
      });
    });
    expect(calls.map((c) => c.mode)).toEqual(["__acp_session_list", "__acp_session_load"]);
  });

  it("uses the daemon thread id for prompts and exposes run/status/apply truth in response metadata", async () => {
    const cwd = project();
    const runFacts = {
      run_id: "run-2",
      outcome: { lifecycle: "succeeded" },
      receiptMarker: "exact-runner-object",
    };
    let promptCall: any;
    await withClient(
      async (params) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-2", cwd };
        promptCall = params;
        return {
          runId: "run-2",
          status: "succeeded",
          summary: "completed through daemon",
          applyEligibility: { eligible: true, state: "verified" },
          runFacts,
        };
      },
      async (agent, updates) => {
        const session = await agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "fix it" }],
          _meta: { claudexor: { mode: "agent", access: "workspace_write" } },
        });
        expect(response.stopReason).toBe("end_turn");
        expect(response._meta?.["claudexor"]).toMatchObject({
          runId: "run-2",
          status: "succeeded",
          applyEligibility: { eligible: true },
          runFacts,
        });
        expect(
          updates.some((item) => JSON.stringify(item).includes("completed through daemon")),
        ).toBe(true);
      },
    );
    expect(promptCall).toMatchObject({
      mode: "__acp_session_prompt",
      sessionId: "thread-2",
      prompt: "fix it",
      access: "workspace_write",
    });
  });

  it("renders a plan turn's open questions as TURN TEXT when readiness is needs_answers (D14/D17)", async () => {
    const cwd = project();
    await withClient(
      async (params) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-plan", cwd };
        return {
          runId: "plan-run-1",
          status: "succeeded",
          summary: "Drafted a plan.",
          applyEligibility: null,
          planReadiness: { state: "needs_answers", questionCount: 2 },
          planQuestions: [
            {
              id: "db",
              kind: "single",
              prompt: "Which database?",
              options: [
                { id: "pg", label: "Postgres" },
                { id: "sqlite", label: "SQLite" },
              ],
              allow_text: false,
            },
            {
              id: "notes",
              kind: "text",
              prompt: "Any constraints?",
              options: [],
              allow_text: true,
            },
          ],
        };
      },
      async (agent, updates) => {
        const session = await agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plan the migration" }],
          _meta: { claudexor: { mode: "plan" } },
        });
        // A plan turn that needs answers still ENDS the turn normally; the user's
        // next prompt is an ordinary follow-up plan turn.
        expect(response.stopReason).toBe("end_turn");
        const rendered = JSON.stringify(updates);
        expect(rendered).toContain("2 open questions");
        expect(rendered).toContain("Which database?");
        expect(rendered).toContain("Postgres");
        expect(rendered).toContain("(choose one)");
        expect(rendered).toContain("Any constraints?");
        expect(rendered).toContain("(free text)");
      },
    );
  });

  it("does NOT render a question block for a ready plan turn", async () => {
    const cwd = project();
    await withClient(
      async (params) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-ready", cwd };
        return {
          runId: "plan-run-2",
          status: "succeeded",
          summary: "Plan ready.",
          applyEligibility: null,
          planReadiness: { state: "ready", questionCount: 0 },
          planQuestions: [],
        };
      },
      async (agent, updates) => {
        const session = await agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plan it" }],
          _meta: { claudexor: { mode: "plan" } },
        });
        expect(response._meta?.["claudexor"]).toMatchObject({ runFacts: null });
        expect(JSON.stringify(updates)).not.toContain("open question");
      },
    );
  });

  it("presents an option-less (free-text) mid-run question as turn text, NEVER silently skipping it (D14/B5)", async () => {
    const cwd = project();
    const header = `Ticket context ${"detail ".repeat(40)}END`;
    let captured: unknown = "unset";
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-ft", cwd };
        // The engine raises a free-text question mid-run (no options).
        captured = await hooks!.onInteraction!({
          run_id: "run-ft-1",
          request: {
            interaction_id: "int-1",
            questions: [{ id: "q1", header, question: "What ticket does this fix?", options: [] }],
          },
        });
        return { runId: "run-ft-1", status: "succeeded", summary: "done", applyEligibility: null };
      },
      async (agent, updates) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
          _meta: { claudexor: { mode: "agent" } },
        });
        // No synthesized answer for a question ACP cannot answer.
        expect(captured).toBeNull();
        // The question is disclosed as turn text naming the documented remedy.
        const text = JSON.stringify(updates);
        expect(text).toContain("What ticket does this fix?");
        expect(text).toContain(header);
        expect(text).toContain("claudexor follow run-ft-1");
      },
    );
  });

  it("answers a multi-select mid-run question with MORE THAN ONE label (option iteration, B5)", async () => {
    const cwd = project();
    let captured: any = null;
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-ms", cwd };
        captured = await hooks!.onInteraction!({
          run_id: "run-ms-1",
          request: {
            interaction_id: "int-ms",
            questions: [
              {
                id: "q1",
                question: "Which platforms?",
                multi_select: true,
                options: [{ label: "macOS" }, { label: "linux" }, { label: "windows" }],
              },
            ],
          },
        });
        return { runId: "run-ms-1", status: "succeeded", summary: "done", applyEligibility: null };
      },
      async (agent) => {
        // The default test client selects options[0] ("Include …") each round,
        // so every option is included — proving the surface can return >1 label.
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
          _meta: { claudexor: { mode: "agent" } },
        });
        expect(captured?.answers?.[0]?.selected_labels).toEqual(["macOS", "linux", "windows"]);
      },
    );
  });

  /** Runs one ACP prompt whose run raises `request`; returns the hook's answer and the turn text. */
  async function answerThroughAcp(
    request: Record<string, unknown>,
    choose: Parameters<typeof withClient>[3],
    extra: Record<string, unknown> = {},
  ) {
    const cwd = project();
    let captured: unknown = "unset";
    let text = "";
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-q", cwd };
        captured = await hooks!.onInteraction!({ run_id: "run-q-1", request, ...extra });
        return { runId: "run-q-1", status: "succeeded", summary: "done", applyEligibility: null };
      },
      async (agent, updates) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
          _meta: { claudexor: { mode: "agent" } },
        });
        text = updates
          .map((note) => note.update)
          .filter((update) => update.sessionUpdate === "agent_message_chunk")
          .map((update) => (update as { content: { text?: string } }).content.text ?? "")
          .join("\n");
      },
      {},
      choose,
    );
    return { captured, text };
  }

  const skipEveryInclude: Parameters<typeof withClient>[3] = (options) =>
    options.find((option) => option.optionId === "skip")?.optionId ?? options[0]!.optionId;

  it("proposes the answered questions as a partial answer and names the skipped one it would close", async () => {
    const { captured, text } = await answerThroughAcp(
      {
        interaction_id: "int-skip",
        questions: [
          {
            id: "q1",
            question: "Which platforms?",
            multi_select: true,
            options: [{ label: "macOS" }, { label: "linux" }],
          },
          { id: "q2", question: "Which shell?", options: [{ label: "zsh" }] },
        ],
      },
      skipEveryInclude,
    );
    // No row for the skipped question: an empty row would be refused before it
    // could consume the pending interaction, so the answered one goes alone.
    // The message precedes the submission, so it states the closing effect only
    // conditionally: the answer may still fail or be refused.
    expect(captured).toEqual({
      interaction_id: "int-skip",
      answers: [{ question_id: "q2", selected_labels: ["zsh"], free_text: null }],
    });
    expect(text).toContain("The chosen answers will now be submitted as a partial answer.");
    expect(text).toContain("Once it is accepted, it closes this question set");
    expect(text).toContain("1. Which platforms? (every option skipped)");
    expect(text).toContain("can no longer be answered in this run");
    expect(text).toContain(
      "Until then the set stays pending and can be answered with `claudexor follow run-q-1`",
    );
    expect(text).not.toContain("were sent");
    expect(text).not.toContain("No answer was sent");
  });

  it("sends nothing when nothing is chosen and says the run stays paused, with its expiry", async () => {
    const { captured, text } = await answerThroughAcp(
      {
        interaction_id: "int-none",
        questions: [
          {
            id: "q1",
            question: "Which platforms?",
            multi_select: true,
            options: [{ label: "macOS" }, { label: "linux" }],
          },
          { id: "q2", question: "Which shell?", options: [{ label: "zsh" }] },
        ],
      },
      // Skip every include round and dismiss the single choice.
      (options) => (options.some((option) => option.optionId === "skip") ? "skip" : null),
      { timeoutAt: "2026-11-02T12:00:00.000Z" },
    );
    expect(captured).toBeNull();
    expect(text).toContain("No answer was sent, so this run stays paused");
    expect(text).toContain("1. Which platforms? (every option skipped)");
    expect(text).toContain("2. Which shell? (dismissed without a choice)");
    expect(text).toContain("`claudexor follow run-q-1`");
    expect(text).toContain(
      "If nobody answers by 2026-11-02T12:00:00.000Z, it is declined automatically",
    );
  });

  it("shows each question's header and option descriptions as permission prompt content", async () => {
    const prompts: acp.RequestPermissionRequest[] = [];
    const { captured } = await answerThroughAcp(
      {
        interaction_id: "int-content",
        questions: [
          {
            id: "q1",
            header: "Rollout",
            question: "Which rollout should I use?",
            options: [
              { label: "Canary", description: "Gradual traffic shift" },
              { label: "Blue-green", description: "Switch all traffic at once" },
            ],
          },
          {
            id: "q2",
            header: "Targets",
            question: "Which platforms?",
            multi_select: true,
            options: [{ label: "macOS", description: "Apple silicon only" }],
          },
        ],
      },
      (options, request) => {
        prompts.push(request);
        return options[0]!.optionId;
      },
    );
    const texts = prompts.map((request) =>
      (request.toolCall.content ?? []).map((item) =>
        item.type === "content" && item.content.type === "text" ? item.content.text : "",
      ),
    );
    expect(texts).toEqual([
      [
        "Rollout\n\nWhich rollout should I use?\n\n- Canary: Gradual traffic shift\n- Blue-green: Switch all traffic at once",
      ],
      ["Targets\n\nWhich platforms?\n\n- macOS: Apple silicon only"],
    ]);
    expect(prompts.map((request) => request.toolCall.title)).toEqual([
      "Which rollout should I use?",
      'Which platforms? — include "macOS"?',
    ]);
    expect(captured).toEqual({
      interaction_id: "int-content",
      answers: [
        { question_id: "q1", selected_labels: ["Canary"], free_text: null },
        { question_id: "q2", selected_labels: ["macOS"], free_text: null },
      ],
    });
  });

  it("maps a FAILED daemon lifecycle to refusal instead of a false normal end_turn", async () => {
    // D8: a needs-review run has a SUCCEEDED lifecycle and ends end_turn (the
    // process completed); only failed/interrupted lifecycles are a refusal.
    const cwd = project();
    const failure = {
      phase: "execute",
      category: "auth",
      code: null,
      harnessId: "claude",
      attemptId: "a01",
      safeMessage: "Authentication expired",
      rawDetailRef: "attempts/a01/failure.json",
      logRefs: ["attempts/a01/stderr.log"],
      eventRefs: ["events.jsonl#42"],
      runDir: "/tmp/run-failed",
      nextActions: ["Log in again"],
    };
    await withClient(
      async (params) =>
        params.mode === "__acp_session_new"
          ? { sessionId: "thread-blocked", cwd }
          : {
              runId: "run-failed",
              status: "failed",
              summary: "harness failed",
              failure,
              applyEligibility: { eligible: false, requiredAction: "accept_risk" },
            },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        expect(response.stopReason).toBe("refusal");
        expect(response._meta?.["claudexor"]).toMatchObject({
          status: "failed",
          failure,
        });
      },
    );
  });

  it("maps a daemon hard deadline to refusal without requiring a local abort", async () => {
    const cwd = project();
    await withClient(
      async (params) =>
        params.mode === "__acp_session_new"
          ? { sessionId: "thread-daemon-cancelled", cwd }
          : {
              runId: "run-daemon-cancelled",
              status: "cancelled",
              summary: "Time limit reached",
              outcomeFacts: {
                lifecycle: "cancelled",
                noChanges: false,
                checks: "not_configured",
                review: "not_run",
                reason: "wall_clock_exceeded",
              },
              outcomeBanner: "Time limit reached",
              applyEligibility: null,
            },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        expect(response.stopReason).toBe("refusal");
        expect(response._meta?.["claudexor"]).toMatchObject({
          status: "cancelled",
          outcomeFacts: { reason: "wall_clock_exceeded" },
          outcomeBanner: "Time limit reached",
        });
      },
    );
  });

  it("does not publish malformed legacy outcome facts as typed ACP metadata", async () => {
    const cwd = project();
    await withClient(
      async (params) =>
        params.mode === "__acp_session_new"
          ? { sessionId: "thread-malformed-facts", cwd }
          : {
              runId: "run-malformed-facts",
              status: "cancelled",
              summary: "cancelled",
              outcomeFacts: { reason: "wall_clock_exceeded" },
            },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });

        expect(response.stopReason).toBe("cancelled");
        expect(response._meta?.["claudexor"]).toMatchObject({
          status: "cancelled",
          outcomeFacts: null,
        });
      },
    );
  });

  it("routes Plan images and embedded resources through attachment descriptors, never inline paths", async () => {
    const cwd = project();
    let promptCall: any;
    await withClient(
      async (params) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-files", cwd };
        promptCall = params;
        return { runId: "run-files", status: "succeeded", summary: "ok" };
      },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "inspect" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            {
              type: "resource",
              resource: { uri: "memory://note", mimeType: "text/plain", text: "context" },
            },
          ],
          _meta: { claudexor: { mode: "plan" } },
        });
      },
    );
    expect(promptCall.attachments).toEqual([
      expect.objectContaining({ kind: "image", mime: "image/png", data: "aGVsbG8=" }),
      expect.objectContaining({ kind: "file", mime: "text/plain" }),
    ]);
    expect(promptCall.runMode).toBe("plan");
    expect(JSON.stringify(promptCall.attachments)).not.toContain("/tmp/");
  });

  it("propagates session/cancel to the active daemon prompt", async () => {
    const cwd = project();
    let aborted = false;
    let abortReason: unknown;
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-cancel", cwd };
        await new Promise<void>((resolve) => {
          hooks?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              abortReason = hooks?.signal?.reason;
              resolve();
            },
            { once: true },
          );
        });
        return { runId: "run-cancel", status: "cancelled", summary: "cancelled" };
      },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const prompt = agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "long" }],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
        expect((await prompt).stopReason).toBe("cancelled");
      },
    );
    expect(aborted).toBe(true);
    expect(abortReason).toBe("user_cancelled");
  });

  // #450: ACP v1 has two terminal tool statuses, completed ("completed
  // successfully") and failed. A command handed to a background shell, timed
  // out, or in an unknown state must not read as completed, and must still get
  // a terminal update: no later frame for that call is guaranteed to arrive.
  it("closes unconfirmed command results as failed with their typed state, never completed", async () => {
    const shell = (useId: string, extra: Record<string, unknown>) => ({
      type: "harness.event",
      payload: {
        type: "tool_result",
        tool: { name: "shell", kind: "command", use_id: useId, target: "run", ...extra },
      },
    });
    const handoff = {
      state: "backgrounded",
      background_reason: "timeout",
      timeout_ms: 30000,
      shell_id: "3",
      pid: 4242,
    };
    const updates = await withClient(
      async (_params, hooks) => {
        for (const id of ["bg", "timeout", "unknown", "exit0", "legacy", "failed"]) {
          hooks?.onEvent?.({
            type: "harness.event",
            payload: { type: "tool_call", tool: { name: "shell", kind: "command", use_id: id } },
          });
        }
        hooks?.onEvent?.(shell("bg", { status: "ok", command_outcome: handoff }));
        hooks?.onEvent?.(
          shell("timeout", {
            status: "ok",
            command_outcome: { state: "timed_out", timeout_ms: 30000 },
          }),
        );
        hooks?.onEvent?.(shell("unknown", { status: "ok", command_outcome: { state: "unknown" } }));
        hooks?.onEvent?.(
          shell("exit0", { status: "ok", exit_code: 0, command_outcome: { state: "exited" } }),
        );
        hooks?.onEvent?.(shell("legacy", { status: "ok" }));
        hooks?.onEvent?.(shell("failed", { status: "error", exit_code: 1 }));
        return { summary: "done", status: "succeeded" };
      },
      async (agent, received) => {
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: "tool-session",
          prompt: [{ type: "text", text: "work" }],
        });
        return received;
      },
    );
    const results = new Map(
      updates
        .map((note) => note.update)
        .filter((update) => update.sessionUpdate === "tool_call_update")
        .map((update) => [update.toolCallId, update] as const),
    );
    expect(results.get("bg")?.status).toBe("failed");
    expect(JSON.stringify(results.get("bg")?.content)).toContain(
      "Handed off to background after its 30s timeout; completion not observed · shell 3 · pid 4242",
    );
    expect(results.get("bg")?._meta).toEqual({ claudexor: { commandOutcome: handoff } });
    expect(results.get("timeout")?.status).toBe("failed");
    expect(JSON.stringify(results.get("timeout")?.content)).toContain(
      "Timed out after 30s · exit status unknown",
    );
    expect(results.get("unknown")?.status).toBe("failed");
    expect(JSON.stringify(results.get("unknown")?.content)).toContain(
      "Command outcome not reported",
    );
    expect(results.get("exit0")).toMatchObject({ status: "completed" });
    expect(results.get("exit0")?.content).toBeUndefined();
    expect(results.get("legacy")?.status).toBe("completed");
    expect(results.get("failed")?.status).toBe("failed");
    expect(results.get("failed")?.content).toBeUndefined();
  });

  // #546: a later `command_outcome_refined` status (the vendor reported the
  // end of a background command, without an exit code) updates the SAME closed
  // call. ACP: "All fields except the tool call ID are optional - only changed
  // fields need to be included", and `content` is "Replace the content
  // collection". `status` is omitted, so `failed` stands: never reopened, never
  // `completed`, and never a second result.
  describe("a background completion reported after the call closed", () => {
    const tool = { name: "shell", kind: "command", use_id: "bg", target: "sleep 45" };
    const handoff = { state: "backgrounded", background_reason: "requested", shell_id: "3" };
    const reported = (completion_status: string) => ({
      ...handoff,
      state: "completion_reported",
      completion_status,
    });
    const call = (useId = "bg") => ({
      type: "harness.event",
      payload: { type: "tool_call", tool: { ...tool, use_id: useId } },
    });
    const result = (extra: Record<string, unknown>, useId = "bg") => ({
      type: "harness.event",
      payload: { type: "tool_result", tool: { ...tool, use_id: useId, status: "ok", ...extra } },
    });
    const refinement = (
      commandOutcome: unknown,
      useId = "bg",
      code = "command_outcome_refined",
    ) => ({
      type: "harness.event",
      payload: {
        type: "status",
        text: "engine text",
        tool: { ...tool, use_id: useId, command_outcome: commandOutcome },
        payload: { code },
      },
    });
    const replay = async (events: unknown[]) =>
      withClient(
        async (_params, hooks) => {
          for (const event of events) hooks?.onEvent?.(event);
          return { summary: "done", status: "succeeded" };
        },
        async (agent, received) => {
          await agent.request(acp.methods.agent.session.prompt, {
            sessionId: "refined-session",
            prompt: [{ type: "text", text: "work" }],
          });
          return received;
        },
      );
    const forCall = (updates: acp.SessionNotification[], id = "bg") =>
      updates
        .map((note) => note.update)
        .filter((update) => "toolCallId" in update && update.toolCallId === id) as Array<
        Record<string, unknown>
      >;

    it.each([
      ["success", ""],
      ["error", " (error)"],
      ["aborted", " (aborted)"],
    ])("replaces its content and _meta for a %s report and keeps failed", async (status, word) => {
      const updates = await replay([
        call(),
        result({ command_outcome: handoff }),
        refinement(reported(status)),
      ]);
      const [opened, closed, refined, ...rest] = forCall(updates);
      expect(rest).toEqual([]);
      expect(opened).toMatchObject({ sessionUpdate: "tool_call", status: "in_progress" });
      expect(closed).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
      expect(JSON.stringify(closed?.["content"])).toContain(
        "Handed off to background; completion not observed · shell 3",
      );
      expect(refined).toEqual({
        sessionUpdate: "tool_call_update",
        toolCallId: "bg",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Completion reported${word}; exit code unknown · handed off to background · shell 3`,
            },
          },
        ],
        _meta: { claudexor: { commandOutcome: reported(status) } },
      });
      expect(refined).not.toHaveProperty("status");
      // What a client that applies partial updates ends up holding.
      const held = Object.assign({}, closed, refined);
      expect(held["status"]).toBe("failed");
      expect(JSON.stringify(held["content"])).not.toContain("completion not observed");
    });

    it("gives Claudexor's own ACP client no second result", async () => {
      const updates = await replay([
        call(),
        result({ command_outcome: handoff }),
        refinement(reported("success")),
      ]);
      const client = new AcpEvents("client-session");
      const events = forCall(updates).flatMap((update) => client.update(update));
      expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
      expect(events[1]?.tool?.status).toBe("error");
    });

    it("sends nothing for a report that names no handoff of this session", async () => {
      const updates = await replay([
        call("open"),
        refinement(reported("success"), "open"),
        call("exit"),
        result({ exit_code: 0, command_outcome: { state: "exited" } }, "exit"),
        refinement(reported("success"), "exit"),
        call("slow"),
        result({ command_outcome: { state: "timed_out", timeout_ms: 30000 } }, "slow"),
        refinement(reported("success"), "slow"),
        refinement(reported("success"), "never-announced"),
      ]);
      expect(forCall(updates, "open").map((u) => u["sessionUpdate"])).toEqual(["tool_call"]);
      expect(forCall(updates, "exit")).toHaveLength(2);
      expect(forCall(updates, "exit")[1]?.["status"]).toBe("completed");
      expect(forCall(updates, "slow")).toHaveLength(2);
      expect(forCall(updates, "never-announced")).toEqual([]);
    });

    it("sends one update for a duplicate and none for an exit claim or an unknown status", async () => {
      const once = await replay([
        call(),
        result({ command_outcome: handoff }),
        refinement(reported("success")),
        refinement(reported("error")),
      ]);
      expect(forCall(once)).toHaveLength(3);
      expect(JSON.stringify(forCall(once)[2]?.["_meta"])).toContain(
        '"completion_status":"success"',
      );

      const refused = await replay([
        call(),
        result({ command_outcome: handoff }),
        refinement({ state: "exited" }),
        refinement(reported("paused")),
        refinement(reported("success"), "bg", "live_input_delivered"),
      ]);
      expect(forCall(refused)).toHaveLength(2);
      expect(JSON.stringify(refused)).toContain("completion not observed");
      expect(JSON.stringify(refused)).not.toContain("Completion reported");
    });

    it("keeps each ACP session's calls apart", async () => {
      const updates = await withClient(
        async (params, hooks) => {
          if ((params as { sessionId?: string }).sessionId === "one") {
            hooks?.onEvent?.(call());
            hooks?.onEvent?.(result({ command_outcome: handoff }));
          } else {
            hooks?.onEvent?.(refinement(reported("success")));
          }
          return { summary: "done", status: "succeeded" };
        },
        async (agent, received) => {
          for (const sessionId of ["one", "two"])
            await agent.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "work" }],
            });
          return received;
        },
      );
      expect(forCall(updates)).toHaveLength(2);
      expect(JSON.stringify(updates)).not.toContain("Completion reported");
    });

    // X2: a native id is unique only within the try that issued it, while ACP
    // needs a call id unique in its session. A stored run event names its run
    // and try, so its ACP call does too, from open through close to refinement.
    const tried = (
      attempt: string,
      session: string,
      event: { payload: Record<string, unknown> },
      run = "run-1",
    ) => ({
      ...event,
      run_id: run,
      payload: { ...event.payload, attempt_id: attempt, harness_id: "cursor", session_id: session },
    });
    const callIds = (updates: acp.SessionNotification[]) => [
      ...new Set(
        updates
          .map((note) => note.update)
          .flatMap((update) => ("toolCallId" in update ? [update.toolCallId] : [])),
      ),
    ];

    it("keeps two tries that reuse a native id apart, and a report reaches only its own try", async () => {
      const first = (event: { payload: Record<string, unknown> }) => tried("a01", "ses-1", event);
      const second = (event: { payload: Record<string, unknown> }) => tried("a02", "ses-2", event);
      const updates = await replay([
        first(call()),
        second(call()),
        first(result({ command_outcome: handoff })),
        second(result({ command_outcome: { ...handoff, shell_id: "4" } })),
        // A third try that handed nothing off: its report reaches no call.
        tried("a03", "ses-3", refinement(reported("error"))),
        second(refinement({ ...reported("aborted"), shell_id: "4" })),
        first(refinement(reported("success"))),
      ]);
      expect(callIds(updates)).toEqual(["run-1/a01/ses-1/bg", "run-1/a02/ses-2/bg"]);
      const steps = (id: string) => forCall(updates, id).map((update) => update["sessionUpdate"]);
      expect(steps("run-1/a01/ses-1/bg")).toEqual([
        "tool_call",
        "tool_call_update",
        "tool_call_update",
      ]);
      expect(steps("run-1/a02/ses-2/bg")).toEqual([
        "tool_call",
        "tool_call_update",
        "tool_call_update",
      ]);
      expect(JSON.stringify(forCall(updates, "run-1/a01/ses-1/bg")[2]?.["content"])).toContain(
        "Completion reported; exit code unknown · handed off to background · shell 3",
      );
      expect(JSON.stringify(forCall(updates, "run-1/a02/ses-2/bg")[2]?.["content"])).toContain(
        "Completion reported (aborted); exit code unknown · handed off to background · shell 4",
      );
      expect(JSON.stringify(updates)).not.toContain("(error)");
    });

    it("gives each turn its own call ids and forgets a turn's handoffs when it ends", async () => {
      const turns = [
        [
          tried("a01", "ses-1", call(), "run-1"),
          tried("a01", "ses-1", result({ command_outcome: handoff }), "run-1"),
        ],
        [
          // The first turn's report, arriving after that turn ended: no call.
          tried("a01", "ses-1", refinement(reported("success")), "run-1"),
          tried("a01", "ses-2", call(), "run-2"),
          tried("a01", "ses-2", result({ command_outcome: handoff }), "run-2"),
          tried("a01", "ses-2", refinement(reported("success")), "run-2"),
        ],
      ];
      let turn = 0;
      const updates = await withClient(
        async (_params, hooks) => {
          for (const event of turns[turn++] ?? []) hooks?.onEvent?.(event);
          return { summary: "done", status: "succeeded" };
        },
        async (agent, received) => {
          for (const _turn of turns)
            await agent.request(acp.methods.agent.session.prompt, {
              sessionId: "two-turns",
              prompt: [{ type: "text", text: "work" }],
            });
          return received;
        },
      );
      expect(callIds(updates)).toEqual(["run-1/a01/ses-1/bg", "run-2/a01/ses-2/bg"]);
      const steps = (id: string) => forCall(updates, id).map((update) => update["sessionUpdate"]);
      expect(steps("run-1/a01/ses-1/bg")).toEqual(["tool_call", "tool_call_update"]);
      expect(steps("run-2/a01/ses-2/bg")).toEqual([
        "tool_call",
        "tool_call_update",
        "tool_call_update",
      ]);
    });
  });
});
