/**
 * A blocking question parks the agent, never the run's observer.
 *
 * The production route: the server `claudexor acp serve` builds (its session
 * runner and interaction bridge) behind a real ACP SDK client on an in-memory
 * JSON-RPC wire; and the MCP surface runner's terminal wait. Both poll the real
 * Control API over HTTP, which reads the daemon's InteractionRegistry over the
 * SQL engine store, and the question is raised through the orchestrator's
 * interaction channel. Scripted: the harness run, and the thread and run-start
 * routes the fixture's Control API does not own. No live vendor or editor.
 *
 * The SDK's `cancellationSignal` only sends `$/cancel_request`: the request
 * stays open until the peer replies. So the editors here decide for themselves:
 * the stale ones never reply, and the run still has to be collected.
 */
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent, InteractionRequest } from "@claudexor/schema";
import { acpBridgeServer } from "../../cli/src/bridge-serve.js";
import * as daemonRun from "../../cli/src/daemon-run.js";
import * as live from "../../cli/src/live.js";
import { mcpSurfaceRunner } from "../../cli/src/mcp-runner.js";
import { afterEachClosed } from "../../cli/src/test-support/after-each-closed.js";
import { startInteractionDaemon } from "../../cli/src/test-support/interaction-daemon.js";

type Cleanup = () => void | Promise<void>;
type Fixture = Awaited<ReturnType<typeof startInteractionDaemon>>;
type ExecuteRun = Parameters<Parameters<typeof startInteractionDaemon>[0]["execute"]>[0];
type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

const cleanups: Cleanup[] = [];
const removals: Array<() => void> = [];
afterEachClosed(async () => {
  const ownedRemovals = removals.splice(0).reverse();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  return () => {
    for (const remove of ownedRemovals) remove();
  };
});

const THREAD = "thread-question";
const WAIT_MS = 10_000;
/** A window long enough for the first poll to open the prompt before it expires. */
const EXPIRY_MS = 3_000;

const question = (
  interaction_id: string,
  delivery: "blocking" | "async" = "blocking",
): InteractionRequest => ({
  interaction_id,
  source_tool: "AskUserQuestion",
  delivery,
  questions: [
    {
      id: "q1",
      header: "Deploy",
      question: `Ship ${interaction_id}?`,
      options: [
        { label: "Yes", description: null },
        { label: "No", description: null },
      ],
      multi_select: false,
    },
  ],
});
const BLOCKING = question("blocking-1");
const ANSWER_YES = { answers: [{ questionId: "q1", selectedLabels: ["Yes"] }] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function ended(signal: AbortSignal): Promise<void> {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((done) => signal.addEventListener("abort", () => done(), { once: true }));
}

/** The result of a call that must return without anyone answering the stale prompt. */
async function within<T>(call: Promise<T>): Promise<Settled<T> | "still_open"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call.then(
        (value): Settled<T> => ({ status: "fulfilled", value }),
        (reason: unknown): Settled<T> => ({ status: "rejected", reason }),
      ),
      new Promise<"still_open">((done) => {
        timer = setTimeout(() => done("still_open"), WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A run holding one blocking question until the question resolves and the test lets go. */
async function questionDaemon(
  execute: (run: ExecuteRun, resolved: unknown[]) => Promise<HarnessEvent[]>,
) {
  const resolved: unknown[] = [];
  const f = await startInteractionDaemon({
    cleanups,
    removals,
    harnessId: "claude",
    prompt: "work",
    waitMs: WAIT_MS,
    execute: (run) => execute(run, resolved),
  });
  const started: Array<Awaited<ReturnType<Fixture["started"]>>> = [];
  const connection = (await daemonRun.connectDaemonIfRunning())!;
  vi.spyOn(daemonRun, "ensureDaemon").mockResolvedValue(connection as never);
  let runParams: Record<string, unknown> = {};
  const bridgePosts: unknown[] = [];
  const realFetch = live.controlApiFetch;
  const start = async () => {
    const run = await f.started(runParams);
    started.push(run);
    return Response.json({ jobId: run.id, runId: run.runId, runDir: run.runDir });
  };
  // The routes this Control API has no owner for; every other request is real.
  vi.spyOn(live, "controlApiFetch").mockImplementation(async (addr, path, init) => {
    if (path === `/threads/${THREAD}`)
      return Response.json({ thread: { id: THREAD, repoRoot: f.workspace } });
    if (path === `/threads/${THREAD}/turns`) return start();
    if (path === "/projects") return Response.json({});
    if (path === "/runs" && init?.method === "POST") return start();
    if (path.endsWith("/events")) return new Response("event: end\ndata: {}\n\n");
    if (path.endsWith("/answer")) bridgePosts.push(JSON.parse(String(init?.body)));
    return realFetch(addr, path, init);
  });
  return {
    ...f,
    resolved,
    started,
    /** Answers this surface posted, unlike the other surface's HTTP answer. */
    bridgePosts,
    withParams(params: Record<string, unknown>) {
      runParams = params;
    },
    /** The one run this test started, once its question is pending. */
    async asked(count = 1) {
      await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: WAIT_MS, interval: 10 });
      const run = started[0]!;
      return { run, pending: await f.pending(run.runId, count) };
    },
    answerElsewhere: (runId: string, interactionId = "blocking-1") =>
      f.http("POST", `/runs/${runId}/interactions/${interactionId}/answer`, ANSWER_YES),
  };
}

type Permission = {
  params: acp.RequestPermissionRequest;
  signal: AbortSignal;
};

/** A real ACP client against the server `claudexor acp serve` builds. */
function acpEditor(
  decide: (permission: Permission) => acp.RequestPermissionResponse | Promise<never>,
) {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const serving = acpBridgeServer({ read: clientToAgent, write: agentToClient }).serve();
  const updates: Array<Record<string, any>> = [];
  const permissions: Permission[] = [];
  const client = acp
    .client({ name: "question-observer-editor" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => {
      const permission = { params, signal };
      permissions.push(permission);
      return decide(permission);
    });
  const stream = acp.ndJsonStream(
    Writable.toWeb(clientToAgent) as globalThis.WritableStream<Uint8Array>,
    Readable.toWeb(agentToClient) as globalThis.ReadableStream<Uint8Array>,
  );
  return {
    updates,
    permissions,
    /** One prompt on the session, handed to the test while it is open. */
    async prompt<T>(
      op: (prompt: Promise<acp.PromptResponse>, agent: acp.ClientContext) => Promise<T>,
    ) {
      try {
        return await client.connectWith(stream, (agent) =>
          op(
            agent.request(acp.methods.agent.session.prompt, {
              sessionId: THREAD,
              prompt: [{ type: "text", text: "work" }],
            }),
            agent,
          ),
        );
      } finally {
        clientToAgent.end();
        await within(serving);
      }
    },
    /** The question's tool call as the editor saw it: its statuses, in order. */
    callStatuses: (toolCallId: string) =>
      updates.filter((update) => update["toolCallId"] === toolCallId).map((u) => u["status"]),
  };
}

const neverReplies = (): Promise<never> => new Promise<never>(() => undefined);
const CALL = "blocking-1:q1";

async function parkOnQuestion(
  run: ExecuteRun,
  resolved: unknown[],
  release: Promise<void>,
): Promise<HarnessEvent[]> {
  resolved.push(await run.channel.request(BLOCKING, run.signal));
  await Promise.race([release, ended(run.signal)]);
  return [];
}

describe("ACP: a stale blocking question never holds the prompt", () => {
  it("polls while the agent is parked, without answering or unparking it", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const editor = acpEditor(neverReplies);
    await editor.prompt(async (prompt) => {
      const { run, pending } = await f.asked();
      expect(pending[0]).toMatchObject({ interactionId: "blocking-1", delivery: "blocking" });
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      expect(JSON.stringify(editor.permissions[0]!.params.toolCall.content)).not.toContain(
        "keeps working",
      );
      // Parked: the daemon keeps answering polls and nothing answered or declined it.
      const held = await f.pending(run.runId, 1);
      expect(held[0]).toMatchObject({ interactionId: "blocking-1", delivery: "blocking" });
      const detail = await f.http("GET", `/runs/${encodeURIComponent(run.runId)}`);
      expect(detail.body.summary).toMatchObject({ waitingOnUser: true, asyncQuestionsOnly: false });
      expect(f.resolved).toEqual([]);
      expect(f.bridgePosts).toEqual([]);
      expect((await f.answerElsewhere(run.runId)).status).toBe(200);
      release.resolve();
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
    });
  }, 30_000);

  it("withdraws the prompt when another surface answers, while the run keeps working", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const editor = acpEditor(neverReplies);
    await editor.prompt(async (prompt) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      expect((await f.answerElsewhere(run.runId)).status).toBe(200);
      await f.pending(run.runId, 0);
      // The stale prompt closes on the wire and as a tool call, with the run still going.
      await vi.waitFor(() => expect(editor.permissions[0]!.signal.aborted).toBe(true), {
        timeout: WAIT_MS,
        interval: 10,
      });
      await vi.waitFor(() => expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]), {
        timeout: WAIT_MS,
        interval: 10,
      });
      expect(f.resolved).toEqual([
        expect.objectContaining({
          answers: [expect.objectContaining({ selected_labels: ["Yes"] })],
        }),
      ]);
      expect(f.bridgePosts).toEqual([]);
      release.resolve();
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect((await f.terminal(run.id)).state).toBe("succeeded");
    });
  }, 30_000);

  it("discards an editor's pick that crosses the withdrawal: nothing is approved", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    let reply!: (response: acp.RequestPermissionResponse) => void;
    const editor = acpEditor(
      () =>
        new Promise<never>((resolve) => {
          reply = resolve as never;
        }),
    );
    await editor.prompt(async (prompt) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      expect((await f.answerElsewhere(run.runId)).status).toBe(200);
      await vi.waitFor(() => expect(editor.permissions[0]!.signal.aborted).toBe(true), {
        timeout: WAIT_MS,
        interval: 10,
      });
      reply({ outcome: { outcome: "selected", optionId: "opt-2" } });
      release.resolve();
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]);
      expect(f.bridgePosts).toEqual([]);
      expect(f.resolved).toEqual([
        expect.objectContaining({
          answers: [expect.objectContaining({ selected_labels: ["Yes"] })],
        }),
      ]);
    });
  }, 30_000);

  it("withdraws the prompt when the question expires, sending nothing for it", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    f.withParams({ interactionTimeoutMs: EXPIRY_MS });
    const editor = acpEditor(neverReplies);
    await editor.prompt(async (prompt) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      await vi.waitFor(() => expect(f.resolved).toEqual([null]), {
        timeout: WAIT_MS,
        interval: 10,
      });
      await vi.waitFor(() => expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]), {
        timeout: WAIT_MS,
        interval: 10,
      });
      expect(f.bridgePosts).toEqual([]);
      release.resolve();
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect((await f.terminal(run.id)).state).toBe("succeeded");
    });
  }, 30_000);

  it("collects the terminal of a run that ended with its question still open", async () => {
    const release = deferred();
    const f = await questionDaemon(async (run) => {
      void run.channel.request(BLOCKING, run.signal).catch(() => undefined);
      await Promise.race([release.promise, ended(run.signal)]);
      return [];
    });
    const editor = acpEditor(neverReplies);
    await editor.prompt(async (prompt) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      release.resolve();
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect((await f.terminal(run.id)).state).toBe("succeeded");
      expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]);
    });
  }, 30_000);

  it("carries session/cancel to the run and closes the prompt without the editor replying", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const editor = acpEditor(neverReplies);
    await editor.prompt(async (prompt, agent) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      await agent.notify(acp.methods.agent.session.cancel, { sessionId: THREAD });
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "cancelled" }),
      });
      expect((await f.terminal(run.id)).state).toBe("cancelled");
      expect(editor.permissions[0]!.signal.aborted).toBe(true);
      expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]);
      expect(f.bridgePosts).toEqual([]);
    });
    release.resolve();
  }, 30_000);

  it("reports a cancelled turn truthfully to an editor that answers `cancelled` as ACP asks", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    let cancelled!: (response: acp.RequestPermissionResponse) => void;
    const editor = acpEditor(
      () =>
        new Promise<never>((resolve) => {
          cancelled = resolve as never;
        }),
    );
    await editor.prompt(async (prompt, agent) => {
      const { run } = await f.asked();
      await vi.waitFor(() => expect(editor.permissions).toHaveLength(1), { timeout: WAIT_MS });
      await agent.notify(acp.methods.agent.session.cancel, { sessionId: THREAD });
      // An ACP client answers its open permission requests `cancelled` right after session/cancel.
      cancelled({ outcome: { outcome: "cancelled" } });
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "cancelled" }),
      });
      expect((await f.terminal(run.id)).state).toBe("cancelled");
      const said = editor.updates
        .filter((update) => update["sessionUpdate"] === "agent_message_chunk")
        .map((update) => update["content"]["text"] as string);
      expect(said.join("\n")).not.toContain("stays paused");
    });
    release.resolve();
  }, 30_000);
});

describe("ACP: the ordinary blocking question still works", () => {
  it("posts the editor's answer, unparks the agent and completes the call", async () => {
    const release = deferred();
    release.resolve();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const editor = acpEditor(({ params }) => ({
      outcome: { outcome: "selected", optionId: params.options[0]!.optionId },
    }));
    await editor.prompt(async (prompt) => {
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect(f.resolved).toEqual([
        expect.objectContaining({
          answers: [expect.objectContaining({ selected_labels: ["Yes"] })],
        }),
      ]);
      expect(editor.callStatuses(CALL)).toEqual(["pending", "completed"]);
      expect(editor.permissions[0]!.signal.aborted).toBe(false);
      expect(f.bridgePosts).toEqual([ANSWER_YES]);
    });
  }, 30_000);

  it("fails the turn when the permission request fails, and never answers for the user", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const editor = acpEditor(() => {
      throw new Error("editor refused the prompt");
    });
    await editor.prompt(async (prompt) => {
      const { run } = await f.asked();
      const outcome = await within(prompt);
      expect(outcome).toMatchObject({ status: "rejected" });
      expect(String((outcome as { reason: unknown }).reason)).toMatch(/Internal error|refused/);
      expect(f.resolved).toEqual([]);
      // The agent is still held on the question for another surface to answer.
      expect(await f.pending(run.runId, 1)).toHaveLength(1);
      expect(editor.callStatuses(CALL)).toEqual(["pending", "failed"]);
      expect((await f.answerElsewhere(run.runId)).status).toBe(200);
    });
    release.resolve();
  }, 30_000);

  it("asks blocking questions one at a time, then the async one, which holds no later blocking one back", async () => {
    const release = deferred();
    const raiseLater = deferred();
    const f = await questionDaemon(async (run) => {
      const ask = (id: string, delivery?: "async") =>
        void run.channel.request(question(id, delivery), run.signal).catch(() => undefined);
      ask("async-1", "async");
      ask("blocking-1");
      ask("blocking-2");
      await Promise.race([raiseLater.promise, ended(run.signal)]);
      ask("blocking-3");
      await Promise.race([release.promise, ended(run.signal)]);
      return [];
    });
    const answers: Array<(response: acp.RequestPermissionResponse) => void> = [];
    const editor = acpEditor(
      () =>
        new Promise<never>((resolve) => {
          answers.push(resolve as never);
        }),
    );
    const titles = () => editor.permissions.map((permission) => permission.params.toolCall.title);
    const waitFor = (expected: string[]) =>
      vi.waitFor(() => expect(titles()).toEqual(expected), { timeout: WAIT_MS, interval: 10 });
    const pick = (index: number) =>
      answers[index]!({ outcome: { outcome: "selected", optionId: "opt-1" } });
    await editor.prompt(async (prompt) => {
      await f.asked(3);
      // The async question was raised first and still waits behind the open blocking prompt.
      await waitFor(["Ship blocking-1?"]);
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(titles()).toEqual(["Ship blocking-1?"]);
      pick(0);
      await waitFor(["Ship blocking-1?", "Ship blocking-2?"]);
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(titles()).toEqual(["Ship blocking-1?", "Ship blocking-2?"]);
      pick(1);
      await waitFor(["Ship blocking-1?", "Ship blocking-2?", "Ship async-1?"]);
      // The async prompt stays open, unanswered, and a new blocking question goes past it.
      raiseLater.resolve();
      await waitFor(["Ship blocking-1?", "Ship blocking-2?", "Ship async-1?", "Ship blocking-3?"]);
      expect(editor.permissions[2]!.signal.aborted).toBe(false);
      release.resolve();
      // Both prompts left open close with the run.
      expect(await within(prompt)).toEqual({
        status: "fulfilled",
        value: expect.objectContaining({ stopReason: "end_turn" }),
      });
      expect(editor.callStatuses("async-1:q1")).toEqual(["pending", "failed"]);
      expect(editor.callStatuses("blocking-3:q1")).toEqual(["pending", "failed"]);
    });
  }, 30_000);
});

describe("MCP surface runner: a hook that ignores its signal never holds the wait", () => {
  const hookThatNeverSettles = () => new Promise<null>(() => undefined);
  const runMcp = (hooks: Parameters<ReturnType<typeof mcpSurfaceRunner>>[1]) => {
    const out = mcpSurfaceRunner({ requireExistingDaemon: true })(
      { mode: "agent", prompt: "work" },
      hooks,
    );
    out.catch(() => undefined); // read through within(); a failure may land before that
    return out;
  };

  it("returns the run's own terminal after another surface answers", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const signals: AbortSignal[] = [];
    const out = runMcp({
      onInteraction: (ctx) => {
        signals.push(ctx.signal);
        return hookThatNeverSettles();
      },
    });
    const { run } = await f.asked();
    await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: WAIT_MS, interval: 10 });
    expect((await f.answerElsewhere(run.runId)).status).toBe(200);
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), {
      timeout: WAIT_MS,
      interval: 10,
    });
    release.resolve();
    expect(await within(out)).toMatchObject({
      status: "fulfilled",
      value: { runId: run.runId, status: "succeeded" },
    });
  }, 30_000);

  it("returns after expiry and sends nothing for the question", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    f.withParams({ interactionTimeoutMs: EXPIRY_MS });
    const signals: AbortSignal[] = [];
    const out = runMcp({
      onInteraction: (ctx) => {
        signals.push(ctx.signal);
        return hookThatNeverSettles();
      },
    });
    await f.asked();
    await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: WAIT_MS, interval: 10 });
    await vi.waitFor(() => expect(f.resolved).toEqual([null]), { timeout: WAIT_MS, interval: 10 });
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true), {
      timeout: WAIT_MS,
      interval: 10,
    });
    release.resolve();
    expect(await within(out)).toMatchObject({
      status: "fulfilled",
      value: { status: "succeeded" },
    });
  }, 30_000);

  it("carries the caller's cancellation to the run", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const out = runMcp({
      signal: controller.signal,
      onInteraction: (ctx) => {
        signals.push(ctx.signal);
        return hookThatNeverSettles();
      },
    });
    const { run } = await f.asked();
    await vi.waitFor(() => expect(signals).toHaveLength(1), { timeout: WAIT_MS, interval: 10 });
    controller.abort("user_cancelled");
    expect(signals[0]?.aborted).toBe(true);
    expect(await within(out)).toMatchObject({
      status: "fulfilled",
      value: { status: "cancelled" },
    });
    expect((await f.terminal(run.id)).state).toBe("cancelled");
    release.resolve();
  }, 30_000);

  it("still fails the wait with a blocking hook's own error", async () => {
    const release = deferred();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const out = runMcp({
      onInteraction: async () => {
        throw new Error("hook failed");
      },
    });
    const { run } = await f.asked();
    const outcome = await within(out);
    expect(outcome).toMatchObject({ status: "rejected" });
    expect(String((outcome as { reason: unknown }).reason)).toContain("hook failed");
    expect(f.resolved).toEqual([]);
    expect((await f.answerElsewhere(run.runId)).status).toBe(200);
    release.resolve();
  }, 30_000);

  it("posts a blocking hook's answer", async () => {
    const release = deferred();
    release.resolve();
    const f = await questionDaemon((run, resolved) =>
      parkOnQuestion(run, resolved, release.promise),
    );
    const out = runMcp({
      onInteraction: async () => ({
        answers: [{ question_id: "q1", selected_labels: ["Yes"], free_text: null }],
      }),
    });
    expect(await within(out)).toMatchObject({
      status: "fulfilled",
      value: { status: "succeeded" },
    });
    expect(f.resolved).toEqual([
      expect.objectContaining({ answers: [expect.objectContaining({ selected_labels: ["Yes"] })] }),
    ]);
  }, 30_000);
});
