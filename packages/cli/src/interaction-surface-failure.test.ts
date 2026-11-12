/**
 * A failing answer surface is never a user's decline (#622 class, #628).
 *
 * The real route, without a channel mock: the orchestrator's interaction
 * channel, the daemon's InteractionRegistry over its SQL store as the answer
 * surface, and the Claude adapter's control-request handler. Two failures of
 * that route: the registry refuses to register a question whose id is already
 * pending for the run (a synchronous throw), so nobody can answer it; and the
 * run's journal refuses the channel's `interaction.requested` append after the
 * registry accepted the question, so nobody was told about it. A third is the
 * store failing to record the run's end: no answer may then reach that run.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { InteractionChannelError, type ChildStdin, type InteractionChannel } from "@claudexor/core";
import {
  EngineStore,
  createPartition,
  createSqlDaemonServices,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import type { HarnessEvent } from "@claudexor/schema";
import {
  DECLINE_MESSAGE,
  handleControlRequestFrame,
} from "../../harness-claude/src/interactive.js";
import { unavailableDenyMessage } from "../../harness-claude/src/question-outcome.js";
import { interactionChannelFor } from "../../orchestrator/src/interaction.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";

const closers: Array<() => void | Promise<void>> = [];
afterEachClosed(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function sqlRegistry() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-surface-failure-")));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
  const store = await EngineStore.open({
    daemonDir: root,
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  closers.push(() => store.close());
  store.transaction(() => {
    const generation = createPartition(store, "global");
    setGlobalGenerationInTx(store, generation.pid);
  });
  const graph = createSqlDaemonServices(store, { purgeFiles: async () => [root] });
  closers.push(() => graph.close());
  return {
    registry: graph.interactions,
    /** Each of the run's questions as its store holds it: `pending`, or the
     * terminal its recorded resolution names. */
    terminals: (runId: string) =>
      (
        store
          .prepare("SELECT state, resolution FROM interaction WHERE run_id = ? ORDER BY rowid")
          .all(runId) as { state: string; resolution: Uint8Array | null }[]
      ).map((row) =>
        row.state === "pending"
          ? "pending"
          : (JSON.parse(Buffer.from(row.resolution!).toString("utf8")) as { terminal: string })
              .terminal,
      ),
    /** Until restored, every resolution the store writes fails inside SQLite,
     * as a full disk would, and rolls back. */
    failResolutions: () =>
      store.exec(
        "CREATE TEMP TRIGGER cx_fail_resolution BEFORE UPDATE ON interaction BEGIN SELECT RAISE(ABORT, 'resolution write failed (injected)'); END",
      ),
    restoreResolutions: () => store.exec("DROP TRIGGER temp.cx_fail_resolution"),
  };
}

const QUESTIONS = [
  {
    question: "Which fixture should the test use?",
    header: "Fixture",
    options: [
      { label: "Shared", description: "The shared module" },
      { label: "Local", description: "A new helper" },
    ],
    multiSelect: false,
  },
];

type Settlement = { kind: "resolved"; value: unknown } | { kind: "rejected"; error: unknown };

/** Claude's AskUserQuestion permission request, handled by the adapter over
 * the real channel; the settlement the adapter receives is observed. */
async function askThroughClaude(channel: InteractionChannel) {
  const settlements: Settlement[] = [];
  const observed: InteractionChannel = {
    request: (request, signal) => {
      const settled = channel.request(request, signal);
      settled.then(
        (value) => settlements.push({ kind: "resolved", value }),
        (error: unknown) => settlements.push({ kind: "rejected", error }),
      );
      return settled;
    },
    pendingCount: () => channel.pendingCount!(),
    suspensionVersion: () => channel.suspensionVersion!(),
  };
  const writes: string[] = [];
  // Both forms the adapter may answer through: a plain write, and the run
  // loop's `send`, which reports an accepted frame as written.
  const io = {
    write: (line: string) => void writes.push(line),
    send: async (line: string) => {
      writes.push(line);
      return { outcome: "written" as const };
    },
    end: () => undefined,
    closed: new Promise<void>(() => undefined),
  } as ChildStdin;
  const yielded: HarnessEvent[] = [];
  for await (const event of handleControlRequestFrame(
    {
      type: "control_request",
      request_id: "ask-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: QUESTIONS },
        tool_use_id: "toolu-ask",
      },
    },
    io,
    "session-1",
    observed,
  ))
    yielded.push(event);
  return { settlements, writes, yielded };
}

/** #622 as integrated: the adapter's one record that the answer channel
 * failed, keyed by the native ids and carrying the surface's actual cause, and
 * the one deny that tells the model it was not the user's decision. */
function expectChannelFailureRecorded(
  asked: Awaited<ReturnType<typeof askThroughClaude>>,
  cause: string,
) {
  // Soft, so a regression shows every way the record and the deny differ.
  expect
    .soft(asked.yielded.map((event) => event.type))
    .toEqual(["interaction_requested", "status"]);
  expect.soft(asked.yielded[0]?.interaction).toMatchObject({
    interaction_id: "ask-1",
    delivery: "blocking",
  });
  expect.soft(asked.yielded[1]).toMatchObject({
    type: "status",
    text: "AskUserQuestion ask-1 could not be answered: the answer channel failed",
    payload: {
      code: "interaction_answer_unavailable",
      reason: "answer_channel_failed",
      interaction_id: "ask-1",
      tool_use_id: "toolu-ask",
      error: cause,
    },
  });
  // The adapter still answers the native request exactly once, so the model is
  // never left waiting, and never with the benign decline's words.
  expect.soft(asked.writes.map((line) => JSON.parse(line))).toEqual([
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "ask-1",
        response: {
          behavior: "deny",
          message: unavailableDenyMessage("answer_channel_failed"),
          interrupt: false,
        },
      },
    },
  ]);
  expect.soft(asked.writes[0]).not.toContain(DECLINE_MESSAGE);
}

const ANSWER = {
  interaction_id: "ask-1",
  answers: [{ question_id: "q1", selected_labels: ["Shared"], free_text: null }],
};

it("rejects the Claude adapter's request with the registry's cause instead of a decline-shaped null", async () => {
  const { registry } = await sqlRegistry();
  const runId = "run-surface-failure";
  // The question id the native process is about to reuse is already pending.
  const earlier = registry.register(
    {
      runId,
      taskId: "task",
      attemptId: "a01",
      harnessId: "claude",
      request: {
        interaction_id: "ask-1",
        source_tool: "AskUserQuestion",
        delivery: "blocking",
        questions: [],
      },
      requestedAt: new Date().toISOString(),
      timeoutAt: null,
    },
    {},
  );
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const channel = interactionChannelFor(
    {
      interactionTimeoutMs: null,
      onInteraction: (ctx) => registry.register(ctx, {}),
    },
    {
      emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
    } as never,
    runId,
    "task",
    "a01",
    "claude",
    true,
  )!;
  const asked = await askThroughClaude(channel);
  // What the adapter records and tells the model (#622).
  expectChannelFailureRecorded(asked, `duplicate interaction 'ask-1' for run '${runId}'`);

  expect(asked.settlements).toHaveLength(1);
  const settlement = asked.settlements[0]!;
  expect(settlement.kind).toBe("rejected");
  const error = (settlement as { error: unknown }).error;
  expect(error).toBeInstanceOf(InteractionChannelError);
  expect(error).toMatchObject({
    code: "answer_channel_failed",
    message: `duplicate interaction 'ask-1' for run '${runId}'`,
  });
  // Nothing new was registered or announced, and the watchdog was released.
  expect(events).toEqual([]);
  expect(registry.pendingForRun(runId).map((pending) => pending.interactionId)).toEqual(["ask-1"]);
  expect(channel.pendingCount!()).toBe(0);
  expect(channel.suspensionVersion!() % 2).toBe(0);
  registry.dropForRun(runId);
  await expect(earlier).resolves.toEqual({ kind: "released", reason: "run_terminal" });
}, 30_000);

it("withdraws a registered question whose announcement the journal refused, so no answer is ever delivered to it", async () => {
  const { registry, terminals } = await sqlRegistry();
  const runId = "run-announce-failure";
  const appendFailure = new Error("journal append failed: no space left on device");
  const appended: string[] = [];
  const channel = interactionChannelFor(
    {
      interactionTimeoutMs: null,
      // The daemon's own wiring: the registry registers durably, synchronously.
      onInteraction: (ctx) => registry.register(ctx, {}),
    },
    {
      // The journal refuses the announcement when its line lands.
      emitLanded: async (type: string) => {
        appended.push(type);
        if (type === "interaction.requested") throw appendFailure;
      },
    } as never,
    runId,
    "task",
    "a01",
    "claude",
    true,
  )!;
  const asked = await askThroughClaude(channel);
  // What the adapter records and tells the model (#622).
  expectChannelFailureRecorded(asked, appendFailure.message);

  // The failure to record the question stays this request's failure, itself.
  expect(asked.settlements).toEqual([{ kind: "rejected", error: appendFailure }]);
  expect(appended).toEqual(["interaction.requested"]);
  // The registry had accepted the question before the append failed. Nothing
  // will read an answer to it, so it is withdrawn: not pending, durably
  // interrupted, and an answer is refused instead of reported delivered.
  expect.soft(registry.pendingForRun(runId)).toEqual([]);
  expect.soft(terminals(runId)).toEqual(["interrupted"]);
  expect.soft(registry.answer(runId, "ask-1", ANSWER)).toEqual({ status: "already_resolved" });
  expect(channel.pendingCount!()).toBe(0);
  expect(channel.suspensionVersion!() % 2).toBe(0);
}, 30_000);

/** The typed question Claude's adapter maps QUESTIONS to. */
const REQUEST = {
  interaction_id: "ask-1",
  source_tool: "AskUserQuestion",
  delivery: "blocking" as const,
  questions: [
    {
      id: "q1",
      question: "Which fixture should the test use?",
      header: "Fixture",
      options: [
        { label: "Shared", description: "The shared module" },
        { label: "Local", description: "A new helper" },
      ],
      multi_select: false,
    },
  ],
};

it("retires an ended run's waiter when the store cannot record the run's end, so a later answer is never delivered", async () => {
  const { registry, terminals, failResolutions, restoreResolutions } = await sqlRegistry();
  const runId = "run-terminal-failure";
  const run = new AbortController();
  const events: string[] = [];
  const channel = interactionChannelFor(
    {
      interactionTimeoutMs: null,
      onInteraction: (ctx) => registry.register(ctx, {}),
      signal: run.signal,
    },
    {
      emit: (type: string) => events.push(type),
      emitLanded: async (type: string) => events.push(type),
    } as never,
    runId,
    "task",
    "a01",
    "claude",
    true,
  )!;
  const asked = channel.request(REQUEST);
  // Stop ends the wait at once; the daemon's terminal cleanup then releases the
  // registration, and that record fails.
  run.abort();
  await expect(asked).resolves.toBeNull();
  failResolutions();
  expect(() => registry.dropForRun(runId)).toThrow(/resolution write failed \(injected\)/);
  restoreResolutions();
  // Not recorded, but no waiter is left: an answer is refused as no live
  // session and releases the row. It never reaches the ended run.
  expect.soft(terminals(runId)).toEqual(["pending"]);
  expect.soft(registry.answer(runId, "ask-1", ANSWER)).toEqual({
    status: "not_found",
    message: expect.stringContaining("no live session"),
  });
  expect.soft(terminals(runId)).toEqual(["interrupted"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["interaction.requested"]);
}, 30_000);

it("records the run's end, a withdrawal and an expiry each as its own release", async () => {
  const { registry, terminals } = await sqlRegistry();
  const context = (runId: string, timeoutAt: string | null = null) => ({
    runId,
    taskId: "task",
    attemptId: "a01",
    harnessId: "claude",
    request: REQUEST,
    requestedAt: new Date().toISOString(),
    timeoutAt,
  });
  const ended = registry.register(context("run-ended"), {});
  registry.dropForRun("run-ended");
  await expect(ended).resolves.toEqual({ kind: "released", reason: "run_terminal" });

  const withdraw = new AbortController();
  const withdrawn = registry.register({ ...context("run-withdrawn"), signal: withdraw.signal }, {});
  withdraw.abort();
  await expect(withdrawn).resolves.toEqual({ kind: "released", reason: "interrupted" });

  const expiring = registry.register(
    context("run-expired", new Date(Date.now() + 25).toISOString()),
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(registry.pendingForRun("run-expired")).toEqual([]);
  await expect(expiring).resolves.toEqual({ kind: "released", reason: "timeout" });

  const runs = ["run-ended", "run-withdrawn", "run-expired"];
  expect(runs.map((runId) => terminals(runId))).toEqual([
    ["run_terminal"],
    ["interrupted"],
    ["timeout"],
  ]);
  for (const runId of runs)
    expect(registry.answer(runId, "ask-1", ANSWER)).toEqual({ status: "already_resolved" });
}, 30_000);
