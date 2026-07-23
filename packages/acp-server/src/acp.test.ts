import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
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
});

function project(): string {
  return reapMk(join(tmpdir(), "claudexor-acp-project-"));
}

async function withClient<T>(
  runner: RunnerFn,
  op: (agent: acp.ClientContext, updates: acp.SessionNotification[]) => Promise<T>,
): Promise<T> {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const server = new AcpServer({
    runner,
    transport: { read: clientToAgent, write: agentToClient },
    version: "2.0.0-test",
  });
  const serving = server.serve();
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: "claudexor-test-client" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({
      outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "" },
    }));
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
          return { sessionId: "thread-1", cwd, turns: [{ summary: "restored answer" }] };
        case "__acp_session_resume":
        case "__acp_session_close":
          return { sessionId: "thread-1", cwd };
        default:
          throw new Error(`unexpected ${params.mode}`);
      }
    };
    await withClient(runner, async (agent, updates) => {
      const initialized = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
      });
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

  it("uses the daemon thread id for prompts and exposes run/status/apply truth in response metadata", async () => {
    const cwd = project();
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
        await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "plan it" }],
          _meta: { claudexor: { mode: "plan" } },
        });
        expect(JSON.stringify(updates)).not.toContain("open question");
      },
    );
  });

  it("presents an option-less (free-text) mid-run question as turn text, NEVER silently skipping it (D14/B5)", async () => {
    const cwd = project();
    let captured: unknown = "unset";
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-ft", cwd };
        // The engine raises a free-text question mid-run (no options).
        captured = await hooks!.onInteraction!({
          run_id: "run-ft-1",
          request: {
            interaction_id: "int-1",
            questions: [{ id: "q1", question: "What ticket does this fix?", options: [] }],
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

  it("maps a FAILED daemon lifecycle to refusal instead of a false normal end_turn", async () => {
    // D8: a needs-review run has a SUCCEEDED lifecycle and ends end_turn (the
    // process completed); only failed/interrupted lifecycles are a refusal.
    const cwd = project();
    await withClient(
      async (params) =>
        params.mode === "__acp_session_new"
          ? { sessionId: "thread-blocked", cwd }
          : {
              runId: "run-failed",
              status: "failed",
              summary: "harness failed",
              applyEligibility: { eligible: false, requiredAction: "accept_risk" },
            },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        expect(response.stopReason).toBe("refusal");
        expect(response._meta?.["claudexor"]).toMatchObject({ status: "failed" });
      },
    );
  });

  it("maps a daemon-cancelled terminal to cancelled without requiring a local abort", async () => {
    const cwd = project();
    await withClient(
      async (params) =>
        params.mode === "__acp_session_new"
          ? { sessionId: "thread-daemon-cancelled", cwd }
          : {
              runId: "run-daemon-cancelled",
              status: "cancelled",
              summary: "cancelled by daemon policy",
              applyEligibility: null,
            },
      async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        const response = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "go" }],
        });
        expect(response.stopReason).toBe("cancelled");
        expect(response._meta?.["claudexor"]).toMatchObject({ status: "cancelled" });
      },
    );
  });

  it("routes images and embedded resources through attachment descriptors, never inline paths", async () => {
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
        });
      },
    );
    expect(promptCall.attachments).toEqual([
      expect.objectContaining({ kind: "image", mime: "image/png", data: "aGVsbG8=" }),
      expect.objectContaining({ kind: "file", mime: "text/plain" }),
    ]);
    expect(JSON.stringify(promptCall.attachments)).not.toContain("/tmp/");
  });

  it("propagates session/cancel to the active daemon prompt", async () => {
    const cwd = project();
    let aborted = false;
    await withClient(
      async (params, hooks) => {
        if (params.mode === "__acp_session_new") return { sessionId: "thread-cancel", cwd };
        await new Promise<void>((resolve) => {
          hooks?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
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
  });
});
