import { InteractionStore } from "./store/test-support/fixtures/legacy/daemon/interactions.js";
import { legacyInteractionPort } from "./store/test-support/legacy-interaction-port.js";
import { getEventListeners } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { InteractionRegistry } from "./interactions.js";

const roots: string[] = [];

function storeAndRegistry() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-disabled-interaction-"));
  roots.push(root);
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = legacyInteractionPort(new InteractionStore(journal));
  const registry = new InteractionRegistry({ forRequest: () => store, forRun: () => store });
  return { journal, store, registry };
}

function context(timeoutAt: string | null) {
  return {
    runId: "run-1",
    taskId: "task-1",
    attemptId: "a01",
    harnessId: "claude",
    request: {
      interaction_id: "int-1",
      source_tool: "AskUserQuestion",
      delivery: "blocking" as const,
      questions: [],
    },
    requestedAt: new Date().toISOString(),
    timeoutAt,
  };
}

const TWO_QUESTIONS = {
  interaction_id: "int-1",
  source_tool: "AskUserQuestion",
  delivery: "blocking" as const,
  questions: [
    {
      id: "q1",
      question: "Pick one",
      header: null,
      options: [
        { label: "A", description: null },
        { label: "B", description: null },
      ],
      multi_select: false,
    },
    { id: "q2", question: "Why?", header: null, options: [], multi_select: false },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)

describe("InteractionRegistry disabled expiry", () => {
  it("resolves an aborted request without ending its run or leaving a pending row", async () => {
    const { journal, registry } = storeAndRegistry();
    const controller = new AbortController();
    const pending = registry.register({ ...context(null), signal: controller.signal }, {});
    expect(registry.pendingForRun("run-1")).toHaveLength(1);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "released", reason: "interrupted" });
    expect(registry.pendingForRun("run-1")).toEqual([]);
    expect(registry.answer("run-1", "int-1", { interaction_id: "int-1", answers: [] }).status).toBe(
      "already_resolved",
    );
    journal.close();
  });

  it("never hands an answer to a withdrawn request when recording the withdrawal fails", async () => {
    const { journal, store, registry } = storeAndRegistry();
    const controller = new AbortController();
    const waiting = registry.register(
      { ...context(null), request: TWO_QUESTIONS, signal: controller.signal },
      {},
    );
    const storeFailure = new Error("database or disk is full");
    const resolve = vi.spyOn(store, "resolve").mockImplementationOnce(() => {
      throw storeFailure;
    });
    // The failure stays inside the abort dispatch, where a throw would be the
    // daemon's uncaught exception; the waiter receives it instead of a release.
    controller.abort();
    await expect(waiting).rejects.toBe(storeFailure);
    resolve.mockRestore();
    // The row is still pending, but no live session waits for it: an answer is
    // refused as such and releases it, never reported delivered.
    const answers = {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A"] }],
    };
    expect(registry.answer("run-1", "int-1", answers)).toEqual({
      status: "not_found",
      message: expect.stringContaining("no live session"),
    });
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });

  it("retires an ended run's waiters when recording its terminal release fails, and never delivers a later answer", async () => {
    const { journal, store, registry } = storeAndRegistry();
    const controller = new AbortController();
    const ended = [
      registry.register(
        { ...context(null), request: TWO_QUESTIONS, signal: controller.signal },
        {},
      ),
      registry.register(
        { ...context(null), request: { ...TWO_QUESTIONS, interaction_id: "int-2" } },
        {},
      ),
    ];
    // Another run's waiter is no part of this run's end.
    const other = registry.register(
      { ...context(null), runId: "run-2", request: TWO_QUESTIONS },
      {},
    );
    const storeFailure = new Error("database or disk is full");
    const resolveRun = vi.spyOn(store, "resolveRun").mockImplementationOnce(() => {
      throw storeFailure;
    });
    // The failed record stays the caller's error, and the run's waiters are
    // released as its end all the same.
    expect(() => registry.dropForRun("run-1")).toThrow(storeFailure);
    resolveRun.mockRestore();
    await expect(Promise.all(ended)).resolves.toEqual([
      { kind: "released", reason: "run_terminal" },
      { kind: "released", reason: "run_terminal" },
    ]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    // The rows were not recorded as resolved, but nothing waits for them: an
    // answer is refused as no live session and releases its row.
    const answers = {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }],
    };
    expect(registry.answer("run-1", "int-1", answers)).toEqual({
      status: "not_found",
      message: expect.stringContaining("no live session"),
    });
    expect(registry.answer("run-1", "int-1", answers).status).toBe("already_resolved");
    expect(registry.answer("run-2", "int-1", answers)).toEqual({ status: "delivered" });
    await expect(other).resolves.toEqual(answers);
    journal.close();
  });

  it("does not persist a request whose signal was already aborted", async () => {
    const { journal, registry } = storeAndRegistry();
    const controller = new AbortController();
    controller.abort();
    const pending = registry.register({ ...context(null), signal: controller.signal }, {});
    await expect(pending).resolves.toEqual({ kind: "released", reason: "interrupted" });
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });

  it("does not prune a null expiry and still releases it on run terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const { journal, registry } = storeAndRegistry();
    const pending = registry.register(context(null), {});
    expect(registry.pendingForRun("run-1")[0]?.timeoutAt).toBeNull();

    vi.setSystemTime(new Date("2036-07-28T00:00:00.000Z"));
    expect(registry.pendingForRun("run-1")).toHaveLength(1);

    registry.dropForRun("run-1");
    await expect(pending).resolves.toEqual({ kind: "released", reason: "run_terminal" });
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });

  it("continues to prune finite expiries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const { journal, registry } = storeAndRegistry();
    const pending = registry.register(context("2026-07-28T00:00:01.000Z"), {});
    vi.setSystemTime(new Date("2026-07-28T00:00:02.000Z"));
    expect(registry.pendingForRun("run-1")).toEqual([]);
    await expect(pending).resolves.toEqual({ kind: "released", reason: "timeout" });
    journal.close();
  });

  it("does not resurrect a disabled pending interaction after restart", () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "claudexor-disabled-restart-"));
    roots.push(root);
    const journalRoot = join(root, "journal");
    const firstJournal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    const first = new InteractionStore(firstJournal);
    first.request(context(null));
    firstJournal.close();

    const secondJournal = new DurableJournal({ rootDir: journalRoot, partition: "global" });
    const second = new InteractionStore(secondJournal);
    second.recoverAfterStartup();
    expect(second.pendingForRun("run-1")).toEqual([]);
    expect(second.status("run-1", "int-1")).toBe("resolved");
    secondJournal.close();
  });

  it("refuses unknown, duplicate and empty answers without consuming the pending question", async () => {
    const { journal, registry } = storeAndRegistry();
    let settled: unknown = "waiting";
    const waiting = registry.register({ ...context(null), request: TWO_QUESTIONS }, {});
    void waiting.then((value) => (settled = value));
    const refused = [
      { interaction_id: "int-1", answers: [{ question_id: "q9", selected_labels: ["A"] }] },
      {
        interaction_id: "int-1",
        answers: [
          { question_id: "q1", selected_labels: ["A"] },
          { question_id: "q1", selected_labels: ["B"] },
        ],
      },
      { interaction_id: "int-1", answers: [{ question_id: "q2", free_text: null }] },
      {
        interaction_id: "int-1",
        answers: [{ question_id: "q2", selected_labels: [" "], free_text: " \n" }],
      },
      {
        interaction_id: "int-1",
        answers: [{ question_id: "q1", selected_labels: ["A"] }, { question_id: "q2" }],
      },
      { interaction_id: "int-2", answers: [{ question_id: "q1", selected_labels: ["A"] }] },
    ];
    for (const answers of refused) {
      expect(registry.answer("run-1", "int-1", answers), JSON.stringify(answers)).toEqual({
        status: "rejected",
        message: expect.any(String),
      });
      expect(registry.pendingForRun("run-1")).toHaveLength(1);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe("waiting");
    // A legitimate partial answer (one of two questions) still ends the wait,
    // and the waiter receives the exact rows, free text untouched.
    const partial = {
      interaction_id: "int-1",
      answers: [{ question_id: "q2", selected_labels: [], free_text: "\n  exact text \n" }],
    };
    expect(registry.answer("run-1", "int-1", partial)).toEqual({ status: "delivered" });
    await expect(waiting).resolves.toEqual(partial);
    expect(registry.pendingForRun("run-1")).toEqual([]);
    expect(registry.answer("run-1", "int-1", partial).status).toBe("already_resolved");
    journal.close();
  });

  it("never reports delivered when no live session waits for a pending question", () => {
    const { journal, store, registry } = storeAndRegistry();
    // A durable pending row this daemon process holds no live waiter for.
    store.request({ ...context(null), request: TWO_QUESTIONS });
    const resolve = vi.spyOn(store, "resolve");
    const answers = {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A"] }],
    };
    expect(registry.answer("run-1", "int-1", answers)).toEqual({
      status: "not_found",
      message: expect.stringContaining("no live session"),
    });
    expect(resolve.mock.calls).toEqual([["run-1", "int-1", "interrupted"]]);
    expect(registry.pendingForRun("run-1")).toEqual([]);
    expect(registry.answer("run-1", "int-1", answers).status).toBe("already_resolved");
    journal.close();
  });

  it("keeps an empty answer set as the caller's explicit decline", async () => {
    const { journal, registry } = storeAndRegistry();
    const waiting = registry.register({ ...context(null), request: TWO_QUESTIONS }, {});
    const decline = { interaction_id: "int-1", answers: [] };
    expect(registry.answer("run-1", "int-1", decline)).toEqual({ status: "delivered" });
    // The waiter receives no rows; the orchestrator and adapters treat that as
    // their benign decline, as before.
    await expect(waiting).resolves.toEqual(decline);
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });

  it("forwards selected labels as given, leaving their meaning to the harness", async () => {
    const { journal, registry } = storeAndRegistry();
    const waiting = registry.register({ ...context(null), request: TWO_QUESTIONS }, {});
    // Not an option label, and two labels on a single-choice question: the
    // documented Codex relay declines such answers; it is not a refusal here.
    const answers = {
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A", "not an option"], free_text: null }],
    };
    expect(registry.answer("run-1", "int-1", answers)).toEqual({ status: "delivered" });
    await expect(waiting).resolves.toEqual(answers);
    journal.close();
  });

  it("rejects an invalid internal deadline before appending durable pending state", () => {
    const { journal, registry } = storeAndRegistry();
    expect(() => registry.register(context("not-a-date"), {})).toThrow(
      "invalid interaction timeoutAt",
    );
    expect(registry.pendingForRun("run-1")).toEqual([]);
    journal.close();
  });
});
