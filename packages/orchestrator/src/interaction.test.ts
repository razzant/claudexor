import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionChannelError } from "@claudexor/core";
import { EventLog } from "@claudexor/event-log";
import {
  INTERACTION_TIMEOUT_MAX_MS,
  type InteractionHandlerResult,
  type RunEvent,
} from "@claudexor/schema";
import { orderedAppender } from "@claudexor/util";
import { interactionChannelFor } from "./interaction.js";

type CapturedEvent = { type: string; payload: Record<string, unknown> };

/** An inline log: a line is captured when emitted (aside too), and `emitLanded`
 * settles at once. */
function eventLog(events: CapturedEvent[]) {
  const emit = (type: string, payload: Record<string, unknown>) => {
    events.push({ type, payload });
  };
  return {
    emit,
    emitAside: emit,
    emitLanded: async (type: string, payload: Record<string, unknown>) => emit(type, payload),
  };
}

function request() {
  return {
    interaction_id: "int-1",
    source_tool: "AskUserQuestion",
    questions: [],
  };
}

afterEach(() => vi.useRealTimers());

describe("interactionChannelFor finite-or-disabled policy", () => {
  it("releases only the aborted request while the run remains active", async () => {
    const events: CapturedEvent[] = [];
    const requestAbort = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let resolveAnswer!: (value: null) => void;
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: (ctx) => {
          seenSignal = ctx.signal;
          return new Promise((resolve) => {
            resolveAnswer = resolve;
          });
        },
      },
      eventLog(events) as never,
      "run-live",
      "task-live",
      "a01",
      "codex",
      true,
    );

    const pending = channel!.request(request() as never, requestAbort.signal);
    expect(channel!.pendingCount!()).toBe(1);
    // The surface's signal follows the request's own withdrawal.
    expect(seenSignal?.aborted).toBe(false);
    requestAbort.abort();
    expect(seenSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(channel!.pendingCount!()).toBe(0);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    expect(events.filter((event) => event.type === "interaction.withdrawn")).toEqual([
      {
        type: "interaction.withdrawn",
        payload: {
          interaction_id: "int-1",
          attempt_id: "a01",
          harness_id: "codex",
          delivery: "blocking",
        },
      },
    ]);
    resolveAnswer(null);
    await Promise.resolve();
    expect(events.some((event) => event.type === "interaction.answer_discarded")).toBe(false);
  });

  it("announces one withdrawal when the registry's interrupted release wins the race", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async () => ({ kind: "released", reason: "interrupted" }),
      },
      eventLog(events) as never,
      "run-release",
      "task-release",
      "a01",
      "codex",
      true,
    );

    await expect(
      channel!.request(request() as never, new AbortController().signal),
    ).resolves.toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      "interaction.requested",
      "interaction.withdrawn",
    ]);
  });

  it("discloses an answer accepted in the same tick as the withdrawal", async () => {
    const events: CapturedEvent[] = [];
    const requestAbort = new AbortController();
    let resolveAnswer!: (value: InteractionHandlerResult) => void;
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: () =>
          new Promise((resolve) => {
            resolveAnswer = resolve;
          }),
      },
      eventLog(events) as never,
      "run-answer-race",
      "task-answer-race",
      "a01",
      "codex",
      true,
    );

    const pending = channel!.request(request() as never, requestAbort.signal);
    resolveAnswer({
      interaction_id: "int-1",
      answers: [{ question_id: "approval", selected_labels: ["Approve once"], free_text: null }],
    });
    requestAbort.abort();
    await expect(pending).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(
        events.find((event) => event.type === "interaction.answer_discarded")?.payload,
      ).toMatchObject({ interaction_id: "int-1", reason: "request_withdrawn", answer_count: 1 }),
    );
    expect(events.some((event) => event.type === "interaction.answered")).toBe(false);
    expect(events.filter((event) => event.type === "interaction.withdrawn")).toHaveLength(1);
  });

  it("keeps ordinary answers, run cancellation and terminal release out of withdrawal", async () => {
    const events: CapturedEvent[] = [];
    const run = new AbortController();
    let release: (() => void) | undefined;
    const outcomes = [
      async () => ({
        interaction_id: "int-1",
        answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }],
      }),
      async () => ({ kind: "released" as const, reason: "run_terminal" as const }),
      () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
    ];
    let next = 0;
    const channel = interactionChannelFor(
      { interactionTimeoutMs: null, signal: run.signal, onInteraction: () => outcomes[next++]!() },
      eventLog(events) as never,
      "run-controls",
      "task-controls",
      "a01",
      "claude",
      true,
    );

    await expect(channel!.request(request() as never)).resolves.toMatchObject({
      interaction_id: "int-1",
    });
    await expect(channel!.request(request() as never)).resolves.toBeNull();
    const cancelled = channel!.request(request() as never, new AbortController().signal);
    run.abort();
    await expect(cancelled).resolves.toBeNull();
    release?.();
    expect(events.filter((event) => event.type === "interaction.answered")).toHaveLength(1);
    expect(events.some((event) => event.type === "interaction.withdrawn")).toBe(false);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("emits a nullable deadline and never age-expires a disabled interaction", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const controller = new AbortController();
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        signal: controller.signal,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-1",
      "task-1",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(900_001);

    expect(settled).toBe(false);
    expect(
      events.find((event) => event.type === "interaction.requested")?.payload["timeout_at"],
    ).toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);

    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(channel!.pendingCount!()).toBe(0);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("discloses an answer that loses the cancellation race without emitting a timeout", async () => {
    const events: CapturedEvent[] = [];
    const controller = new AbortController();
    let resolveAnswer!: (value: {
      interaction_id: string;
      answers: Array<{
        question_id: string;
        selected_labels: string[];
        free_text: string | null;
      }>;
    }) => void;
    const answer = new Promise<{
      interaction_id: string;
      answers: Array<{
        question_id: string;
        selected_labels: string[];
        free_text: string | null;
      }>;
    }>((resolve) => {
      resolveAnswer = resolve;
    });
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        signal: controller.signal,
        onInteraction: () => answer,
      },
      eventLog(events) as never,
      "run-cancel-race",
      "task-cancel-race",
      "a01",
      "claude",
      true,
      900_000,
    );

    const pending = channel!.request(request() as never);
    controller.abort();
    await expect(pending).resolves.toBeNull();
    resolveAnswer({
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }],
    });
    await answer;
    await Promise.resolve();

    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    expect(
      events.find((event) => event.type === "interaction.answer_discarded")?.payload,
    ).toMatchObject({ interaction_id: "int-1", reason: "run_cancelled", answer_count: 1 });
  });

  it("keeps the finite policy and emits one benign automatic timeout", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 50,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-2",
      "task-2",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeNull();
    const requested = events.find((event) => event.type === "interaction.requested");
    expect(typeof requested?.payload["timeout_at"]).toBe("string");
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("releases a disabled wait when its live answer owner terminates", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async () => null,
      },
      eventLog(events) as never,
      "run-3",
      "task-3",
      "a01",
      "claude",
      true,
      900_000,
    );
    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(channel!.pendingCount!()).toBe(0);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("preserves a daemon-owned timeout disposition and emits exactly one timeout", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 50,
        onInteraction: async () => ({ kind: "released", reason: "timeout" }),
      },
      eventLog(events) as never,
      "run-daemon-timeout",
      "task-daemon-timeout",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("does not relabel a daemon terminal release as a timeout", async () => {
    // This is an ordering assertion, not a scheduler-speed benchmark. A real
    // 1 ms wall-clock timer races the immediate handler under loaded Node 20 CI.
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 1,
        onInteraction: async () => ({ kind: "released", reason: "run_terminal" }),
      },
      eventLog(events) as never,
      "run-terminal-release",
      "task-terminal-release",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("does not let a tagged release invent expiry under a disabled policy", async () => {
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async () => ({ kind: "released", reason: "timeout" }),
      },
      eventLog(events) as never,
      "run-disabled-release",
      "task-disabled-release",
      "a01",
      "claude",
      true,
      900_000,
    );

    await expect(channel!.request(request() as never)).resolves.toBeNull();
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
  });

  it("chunks a finite timeout above Node's single-timer ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00.000Z"));
    const events: CapturedEvent[] = [];
    const timeoutMs = 2_147_483_647 + 5_000;
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: timeoutMs,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-large",
      "task-large",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);

    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBeNull();
    expect(events.filter((event) => event.type === "interaction.timeout")).toHaveLength(1);
  });

  it("accepts the schema maximum and materializes the first question deadline", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-28T00:00:00.000Z");
    vi.setSystemTime(now);
    const events: CapturedEvent[] = [];
    const controller = new AbortController();
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: INTERACTION_TIMEOUT_MAX_MS,
        signal: controller.signal,
        onInteraction: () => new Promise(() => undefined),
      },
      eventLog(events) as never,
      "run-max",
      "task-max",
      "a01",
      "claude",
      true,
      900_000,
    );
    const pending = channel!.request(request() as never);
    await vi.advanceTimersByTimeAsync(1);

    expect(
      events.find((event) => event.type === "interaction.requested")?.payload["timeout_at"],
    ).toBe(new Date(now.getTime() + INTERACTION_TIMEOUT_MAX_MS).toISOString());
    expect(events.some((event) => event.type === "interaction.timeout")).toBe(false);

    controller.abort();
    await expect(pending).resolves.toBeNull();
  });

  it("rejects a duration outside the schema-owned finite domain", () => {
    expect(() =>
      interactionChannelFor(
        {
          interactionTimeoutMs: 8_640_000_000_000_000,
          onInteraction: () => new Promise(() => undefined),
        },
        eventLog([]) as never,
        "run-too-large",
        "task-too-large",
        "a01",
        "claude",
        true,
        900_000,
      ),
    ).toThrow("interaction timeout exceeds the supported maximum");
  });
});

describe("interactionChannelFor delivery", () => {
  function channelWith(
    events: CapturedEvent[],
    onInteraction: () => Promise<InteractionHandlerResult>,
  ) {
    return interactionChannelFor(
      { interactionTimeoutMs: null, onInteraction },
      eventLog(events) as never,
      "run-delivery",
      "task-delivery",
      "a01",
      "codex",
      true,
    )!;
  }

  it("keeps the inactivity watchdog armed while an async question waits", async () => {
    const events: CapturedEvent[] = [];
    let answer!: (value: InteractionHandlerResult) => void;
    const channel = channelWith(
      events,
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const version = channel.suspensionVersion!();
    const pending = channel.request({ ...request(), delivery: "async" } as never);
    // The agent keeps working: an async question is not legitimate silence.
    expect(channel.pendingCount!()).toBe(0);
    expect(channel.suspensionVersion!()).toBe(version);
    expect(events.find((event) => event.type === "interaction.requested")?.payload).toMatchObject({
      interaction_id: "int-1",
      delivery: "async",
    });
    answer({
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: [], free_text: "Customers" }],
    });
    await expect(pending).resolves.toMatchObject({ interaction_id: "int-1" });
    expect(channel.suspensionVersion!()).toBe(version);
    expect(events.find((event) => event.type === "interaction.answered")?.payload).toMatchObject({
      delivery: "async",
      answer_count: 1,
    });
  });

  it("still suspends for a blocking question raised beside a pending async one", async () => {
    const events: CapturedEvent[] = [];
    const answers: Array<(value: InteractionHandlerResult) => void> = [];
    const channel = channelWith(
      events,
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    const asyncPending = channel.request({
      ...request(),
      interaction_id: "async-1",
      delivery: "async",
    } as never);
    const blockingPending = channel.request({
      ...request(),
      interaction_id: "blocking-1",
      delivery: "blocking",
    } as never);
    expect(channel.pendingCount!()).toBe(1);
    answers[1]!(null);
    await expect(blockingPending).resolves.toBeNull();
    expect(channel.pendingCount!()).toBe(0);
    answers[0]!(null);
    await expect(asyncPending).resolves.toBeNull();
    expect(channel.pendingCount!()).toBe(0);
    expect(
      events
        .filter((event) => event.type === "interaction.requested")
        .map((event) => [event.payload["interaction_id"], event.payload["delivery"]]),
    ).toEqual([
      ["async-1", "async"],
      ["blocking-1", "blocking"],
    ]);
  });

  it("states blocking delivery when a caller omits it", async () => {
    const events: CapturedEvent[] = [];
    const channel = channelWith(events, async () => null);
    const { delivery: _omitted, ...legacy } = { ...request(), delivery: undefined };
    await expect(channel.request(legacy as never)).resolves.toBeNull();
    expect(
      events.find((event) => event.type === "interaction.requested")?.payload["delivery"],
    ).toBe("blocking");
  });

  it("expires an async question without answering it and says which kind expired", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      { interactionTimeoutMs: 50, onInteraction: () => new Promise(() => undefined) },
      eventLog(events) as never,
      "run-async-expiry",
      "task-async-expiry",
      "a01",
      "codex",
      true,
    )!;
    const pending = channel.request({ ...request(), delivery: "async" } as never);
    await vi.advanceTimersByTimeAsync(50);
    // Expiry is never consent: the adapter receives no answer to send.
    await expect(pending).resolves.toBeNull();
    expect(events.find((event) => event.type === "interaction.timeout")?.payload).toMatchObject({
      delivery: "async",
    });
    expect(events.some((event) => event.type === "interaction.answered")).toBe(false);
  });
});

describe("interactionChannelFor answer-surface failure (#622 class)", () => {
  function failing(
    events: CapturedEvent[],
    onInteraction: () => Promise<InteractionHandlerResult>,
    signal?: AbortSignal,
  ) {
    return interactionChannelFor(
      { interactionTimeoutMs: 60_000, onInteraction, ...(signal ? { signal } : {}) },
      eventLog(events) as never,
      "run-failure",
      "task-failure",
      "a01",
      "claude",
      true,
    )!;
  }

  it("rejects with the surface's cause when it throws, announcing no question it never registered", async () => {
    const events: CapturedEvent[] = [];
    const cause = new Error("interaction store unavailable");
    const channel = failing(events, () => {
      throw cause;
    });
    const before = channel.suspensionVersion!();
    const outcome = channel.request(request() as never).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const error = await outcome;
    expect(error).toBeInstanceOf(InteractionChannelError);
    expect(error).toMatchObject({
      code: "answer_channel_failed",
      message: "interaction store unavailable",
      cause,
    });
    // Nothing was registered, so nothing may claim a question is pending.
    expect(events).toEqual([]);
    expect(channel.pendingCount!()).toBe(0);
    expect(channel.suspensionVersion!()).toBe(before + 2);
  });

  it("rejects after an announced question whose surface later fails, with every wait cleaned up", async () => {
    vi.useFakeTimers();
    const events: CapturedEvent[] = [];
    const run = new AbortController();
    const requestAbort = new AbortController();
    let fail!: (error: unknown) => void;
    const channel = failing(
      events,
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      run.signal,
    );
    const outcome = channel.request(request() as never, requestAbort.signal).then(
      () => "resolved",
      (error: unknown) => error,
    );
    expect(channel.pendingCount!()).toBe(1);
    // The wait, and its listener on the run, begins once the announcement landed.
    await vi.advanceTimersByTimeAsync(0);
    expect(getEventListeners(run.signal, "abort")).toHaveLength(1);
    fail("bridge lost");
    const error = await outcome;
    expect(error).toBeInstanceOf(InteractionChannelError);
    expect(error).toMatchObject({ message: "bridge lost", cause: "bridge lost" });
    expect(channel.pendingCount!()).toBe(0);
    expect(getEventListeners(run.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(requestAbort.signal, "abort")).toHaveLength(0);
    // The expiry timer is gone too: no timeout ever follows the failure.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events.map((event) => event.type)).toEqual(["interaction.requested"]);
  });

  it("withdraws what the surface registered when the journal refuses the announcement, failing with the journal's own error", async () => {
    const appendFailure = new Error("journal append failed");
    const requestAbort = new AbortController();
    let surfaceSignal: AbortSignal | undefined;
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: 60_000,
        onInteraction: (ctx) => {
          surfaceSignal = ctx.signal;
          return new Promise(() => undefined);
        },
      },
      {
        // The journal refuses the announcement when its line lands.
        emitLanded: () => Promise.reject(appendFailure),
      } as never,
      "run-failure",
      "task-failure",
      "a01",
      "codex",
      true,
    )!;
    const before = channel.suspensionVersion!();
    await expect(channel.request(request() as never, requestAbort.signal)).rejects.toBe(
      appendFailure,
    );
    // The registration is released through the request signal the surface
    // was handed; the asking harness's own signal is neither aborted nor held.
    expect(surfaceSignal?.aborted).toBe(true);
    expect(requestAbort.signal.aborted).toBe(false);
    expect(getEventListeners(requestAbort.signal, "abort")).toHaveLength(0);
    expect(channel.pendingCount!()).toBe(0);
    expect(channel.suspensionVersion!()).toBe(before + 2);
  });

  it("leaves an answered, expired or cancelled question's registration to its own owner", async () => {
    vi.useFakeTimers();
    const signals: Record<string, AbortSignal | undefined> = {};
    const scenario = async (
      name: string,
      onInteraction: () => Promise<InteractionHandlerResult>,
      act: (run: AbortController) => Promise<void> = async () => undefined,
    ) => {
      const run = new AbortController();
      const channel = interactionChannelFor(
        {
          interactionTimeoutMs: 50,
          onInteraction: (ctx) => {
            signals[name] = ctx.signal;
            return onInteraction();
          },
          signal: run.signal,
        },
        eventLog([]) as never,
        `run-${name}`,
        `task-${name}`,
        "a01",
        "claude",
        true,
      )!;
      const pending = channel.request(request() as never);
      await act(run);
      await pending;
    };
    await scenario("answered", async () => ({
      interaction_id: "int-1",
      answers: [{ question_id: "q1", selected_labels: ["A"], free_text: null }],
    }));
    await scenario(
      "expired",
      () => new Promise(() => undefined),
      async () => {
        await vi.advanceTimersByTimeAsync(50);
      },
    );
    await scenario(
      "cancelled",
      () => new Promise(() => undefined),
      async (run) => run.abort(),
    );
    // Its expiry and the run's terminal release keep their own dispositions;
    // the surface is never told the request was withdrawn.
    expect(Object.keys(signals)).toEqual(["answered", "expired", "cancelled"]);
    for (const signal of Object.values(signals)) expect(signal?.aborted).not.toBe(true);
  });

  it("keeps a run cancellation's truth when the surface fails while the run is being cancelled", async () => {
    const events: CapturedEvent[] = [];
    const run = new AbortController();
    let fail!: (error: unknown) => void;
    const channel = failing(
      events,
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      run.signal,
    );
    const pending = channel.request(request() as never);
    run.abort();
    fail(new Error("late failure"));
    await expect(pending).resolves.toBeNull();
    expect(events.map((event) => event.type)).toEqual(["interaction.requested"]);
  });

  it("still resolves null for a decline, an expiry, a withdrawal and the run's end, each with its own record", async () => {
    vi.useFakeTimers();
    const outcomes: Record<string, string[]> = {};
    const scenario = async (
      name: string,
      onInteraction: () => Promise<InteractionHandlerResult>,
      act: (abort: AbortController) => Promise<void> = async () => undefined,
    ) => {
      const events: CapturedEvent[] = [];
      const abort = new AbortController();
      const channel = interactionChannelFor(
        { interactionTimeoutMs: 50, onInteraction },
        eventLog(events) as never,
        `run-${name}`,
        `task-${name}`,
        "a01",
        "claude",
        true,
      )!;
      const pending = channel.request(request() as never, abort.signal);
      await act(abort);
      await expect(pending).resolves.toBeNull();
      outcomes[name] = events.map((event) => event.type);
    };
    await scenario("declined", async () => ({ interaction_id: "int-1", answers: [] }));
    await scenario(
      "expired",
      () => new Promise(() => undefined),
      async () => {
        await vi.advanceTimersByTimeAsync(50);
      },
    );
    await scenario(
      "withdrawn",
      () => new Promise(() => undefined),
      async (abort) => abort.abort(),
    );
    await scenario("run_end", async () => ({ kind: "released", reason: "run_terminal" }));
    expect(outcomes).toEqual({
      declined: ["interaction.requested"],
      expired: ["interaction.requested", "interaction.timeout"],
      withdrawn: ["interaction.requested", "interaction.withdrawn"],
      run_end: ["interaction.requested"],
    });
  });

  it("hands the answer surface the delivery it announces", async () => {
    const seen: unknown[] = [];
    const events: CapturedEvent[] = [];
    const channel = interactionChannelFor(
      {
        interactionTimeoutMs: null,
        onInteraction: async (ctx) => {
          seen.push(ctx.request.delivery);
          return null;
        },
      },
      eventLog(events) as never,
      "run-normalized",
      "task-normalized",
      "a01",
      "claude",
      true,
    )!;
    await channel.request(request() as never);
    await channel.request({ ...request(), delivery: "async" } as never);
    expect(seen).toEqual(["blocking", "async"]);
    expect(events.map((event) => event.payload["delivery"])).toEqual(["blocking", "async"]);
  });
});

describe("interactionChannelFor on a run's queued log", () => {
  const ANSWERS = {
    interaction_id: "int-1",
    answers: [{ question_id: "q1", selected_labels: ["Yes"], free_text: null }],
  };

  it("waits on an answer only once the announcement has landed, and withdraws a question whose landing the journal refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "claudexor-interaction-landing-"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const order: string[] = [];
      const refusal = new Error("journal refused interaction.requested");
      let refuse = false;
      const log = new EventLog(
        join(root, "events.jsonl"),
        "run-q",
        "task-q",
        (event: RunEvent) => {
          order.push(`persist:${event.type}`);
          if (refuse && event.type === "interaction.requested") throw refusal;
        },
        undefined,
        undefined,
        { queued: true },
      );
      let surfaceSignal: AbortSignal | undefined;
      const channel = interactionChannelFor(
        {
          interactionTimeoutMs: 60_000,
          onInteraction: (ctx) => {
            order.push("registered");
            surfaceSignal = ctx.signal;
            // An immediate answer: the request still waits for its announcement.
            return refuse ? new Promise(() => undefined) : Promise.resolve(ANSWERS);
          },
        },
        log,
        "run-q",
        "task-q",
        "a01",
        "claude",
        true,
      )!;

      await expect(channel.request(request() as never)).resolves.toEqual(ANSWERS);
      order.push("answered");
      expect(order).toEqual(["registered", "persist:interaction.requested", "answered"]);
      // `interaction.answered` needs no wait; it lands after the answer returns.
      await orderedAppender.settled(join(root, "events.jsonl"));

      refuse = true;
      order.length = 0;
      const before = channel.suspensionVersion!();
      await expect(channel.request(request() as never)).rejects.toBe(refusal);
      // Registered, refused at landing, and withdrawn through the surface's signal.
      expect(order).toEqual(["registered", "persist:interaction.requested"]);
      expect(surfaceSignal?.aborted).toBe(true);
      expect(channel.pendingCount!()).toBe(0);
      expect(channel.suspensionVersion!()).toBe(before + 2);
      // The refusal was the request's alone: the log goes on and terminalizes.
      expect(() => log.emit("output.ready", { kind: "summary" })).not.toThrow();
      await expect(log.emitTerminal("run.completed", {})).resolves.toMatchObject({
        type: "run.completed",
      });
      const types = readFileSync(join(root, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as RunEvent).type);
      expect(types).toEqual([
        "interaction.requested",
        "interaction.answered",
        "interaction.requested",
        "output.ready",
        "run.completed",
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([true, false])(
    "discloses a discarded answer aside: another line's failure stays the run's, its own is dropped (another line lost: %s)",
    async (otherLost) => {
      const root = mkdtempSync(join(tmpdir(), "claudexor-interaction-discarded-"));
      const path = join(root, "events.jsonl");
      try {
        const log = new EventLog(
          path,
          "run-d",
          "task-d",
          (event: RunEvent) => {
            const refused = otherLost
              ? event.payload["text"] === "lost"
              : event.type === "interaction.answer_discarded";
            if (refused) throw new Error(`journal refused ${event.type}`);
          },
          undefined,
          undefined,
          { queued: true },
        );
        const cancel = new AbortController();
        let answer!: (value: InteractionHandlerResult) => void;
        const channel = interactionChannelFor(
          {
            interactionTimeoutMs: null,
            signal: cancel.signal,
            onInteraction: () => new Promise((resolve) => (answer = resolve)),
          },
          log,
          "run-d",
          "task-d",
          "a01",
          "claude",
          true,
        )!;
        const pending = channel.request(request() as never);
        // The question is announced and waiting.
        await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("requested"));
        if (otherLost) {
          log.emit("harness.event", { text: "lost" });
          await orderedAppender.drained(path);
        }
        // The run is cancelled; an answer the registry accepted meanwhile is discarded.
        cancel.abort();
        await expect(pending).resolves.toBeNull();
        answer(ANSWERS);
        await vi.waitFor(() =>
          expect(
            log.readAll().events.some((event) => event.type === "interaction.answer_discarded"),
          ).toBe(true),
        );
        await orderedAppender.drained(path);
        const next = () => log.emit("output.ready", { kind: "summary" });
        // Direction 1: the other line's failure is still the run's, at its next emit.
        if (otherLost) expect(next).toThrow("journal refused harness.event");
        // Direction 2: the disclosure's own failure was dropped, never held for the run.
        else expect(next).not.toThrow();
      } finally {
        await orderedAppender.settledUnder(root).catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
