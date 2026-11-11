import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "@claudexor/schema";
import {
  countsAsAgentProgress,
  HarnessInactivityTimeoutError,
  withInactivityWatchdog,
} from "./inactivity.js";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());

/**
 * A source that models the runCliHarness/spawnProcess shape: it yields one
 * normal event, then blocks (silent — trips the inactivity watchdog). When the
 * watchdog aborts the child (its onTimeout), the source's pending next()
 * resolves — mirroring spawnProcess's requestCancel — takes `cleanupDelayMs` to
 * run its whole-tree "reap", THEN yields a typed terminal fact (mirroring
 * runCliHarness's post-abort termination_unconfirmed + completed) before
 * completing. The delay lets us prove the watchdog drains past the old 2000ms
 * grace and surfaces the terminal fact rather than dropping it.
 */
function reapingSource(cleanupDelayMs: number, signal: AbortSignal): AsyncGenerator<string> {
  async function* gen(): AsyncGenerator<string> {
    yield "live-event";
    // Block until the watchdog aborts us — mirrors spawnProcess's pending
    // iterator.next() resolving when the abort triggers requestCancel/reap.
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // The "reap" — proving whole-tree death takes real time.
    await tick(cleanupDelayMs);
    // The typed terminal fact the existing plumbing emits (survivor group),
    // then the source completes (done) exactly like runCliHarness's post-abort
    // termination_unconfirmed + completed sequence.
    yield "termination_unconfirmed";
  }
  return gen();
}

describe("withInactivityWatchdog death-proof drain (QA-027)", () => {
  it("waits past the old grace for a >2s reap and surfaces the terminal fact before throwing", async () => {
    const cleanupDelayMs = 3000; // exceeds the retired 2000ms grace
    const controller = new AbortController();
    const source = reapingSource(cleanupDelayMs, controller.signal);
    let aborted = false;
    const started = Date.now();

    const watched = withInactivityWatchdog(source, {
      timeoutMs: 50,
      countsAsProgress: () => true,
      onTimeout: () => {
        aborted = true;
        controller.abort();
      },
      cleanupDeadlineMs: 8000,
    });

    const seen: string[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of watched) seen.push(ev);
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;

    // The watchdog fired and aborted the child.
    expect(aborted).toBe(true);
    // No terminal was surfaced before the reap deadline: the drain held the
    // caller in the loop until the source finished its reap (>= cleanupDelayMs).
    expect(elapsed).toBeGreaterThanOrEqual(cleanupDelayMs);
    // The typed termination_unconfirmed terminal fact reached the caller (it was
    // NOT cut off by an early iterator.return that drops the disclosure).
    expect(seen).toContain("termination_unconfirmed");
    expect(seen).toContain("live-event");
    // The timeout is still signaled to the caller after the drain completes.
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  }, 15000);

  it("bounds the drain by the reap deadline for a source that never proves death", async () => {
    // A source whose cleanup never yields a terminal and never resolves: the
    // watchdog must not park the run forever — it gives up at cleanupDeadlineMs.
    async function* wedged(): AsyncGenerator<string> {
      try {
        yield "live-event";
        await new Promise<void>(() => {});
      } finally {
        await new Promise<void>(() => {}); // never resolves
      }
    }
    const started = Date.now();
    const watched = withInactivityWatchdog(wedged(), {
      timeoutMs: 50,
      countsAsProgress: () => true,
      onTimeout: () => {},
      cleanupDeadlineMs: 400,
    });
    let thrown: unknown = null;
    try {
      for await (const _ev of watched) void _ev;
    } catch (err) {
      thrown = err;
    }
    const elapsed = Date.now() - started;
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
    // Bounded: it did not hang; it returned within a small multiple of the
    // 400ms cleanup deadline (the drain deadline plus the finally return grace).
    expect(elapsed).toBeLessThan(4000);
  }, 15000);

  it("keeps inactivity as the terminal cause when abort rejects the pending source read", async () => {
    const controller = new AbortController();
    let timeoutCalls = 0;
    async function* abortRejecting(): AsyncGenerator<string> {
      yield "live-event";
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("native abort rejection")),
          { once: true },
        );
      });
    }

    let thrown: unknown = null;
    try {
      for await (const _event of withInactivityWatchdog(abortRejecting(), {
        timeoutMs: 20,
        countsAsProgress: () => true,
        onTimeout: () => {
          timeoutCalls += 1;
          controller.abort();
        },
        cleanupDeadlineMs: 100,
      })) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }

    expect(timeoutCalls).toBe(1);
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  });

  it("preserves a source failure that happens before inactivity fires", async () => {
    async function* failsEarly(): AsyncGenerator<string> {
      yield "live-event";
      throw new Error("native failure");
    }

    let thrown: unknown = null;
    try {
      for await (const _event of withInactivityWatchdog(failsEarly(), {
        timeoutMs: 1_000,
        countsAsProgress: () => true,
        onTimeout: () => {},
        cleanupDeadlineMs: 100,
      })) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(new Error("native failure"));
  });
});

describe("countsAsAgentProgress", () => {
  const event = (value: Partial<HarnessEvent> & Pick<HarnessEvent, "type">): HarnessEvent =>
    ({ session_id: "ses_progress", ts: "2026-07-28T00:00:00.000Z", ...value }) as HarnessEvent;

  it.each([
    ["started", event({ type: "started" }), false],
    ["non-empty thinking", event({ type: "thinking", text: "working" }), true],
    ["blank thinking", event({ type: "thinking", text: "  " }), false],
    ["non-empty message", event({ type: "message", text: "delta" }), true],
    ["blank message", event({ type: "message", text: "" }), false],
    ["tool call", event({ type: "tool_call" }), true],
    ["tool result", event({ type: "tool_result" }), true],
    ["interaction", event({ type: "interaction_requested" }), false],
    ["file change", event({ type: "file_change" }), true],
    ["patch", event({ type: "patch_produced" }), true],
    ["usage", event({ type: "usage", usage: { output_tokens: 1 } }), false],
    [
      "transient error",
      event({ type: "error", transient: { kind: "timeout", retry_delay_ms: null } }),
      false,
    ],
    ["retry status", event({ type: "status", status: { kind: "api_retry", attempt: 2 } }), false],
    ["plan change", event({ type: "message", plan_progress: { items: [] } }), true],
    [
      "context completion",
      event({
        type: "context",
        context: {
          kind: "compaction_completed",
          cause: "unknown",
          native_code: null,
          trigger: null,
          pre_tokens: null,
        },
      }),
      true,
    ],
    [
      "context start",
      event({
        type: "context",
        context: {
          kind: "compaction_started",
          cause: "unknown",
          native_code: null,
          trigger: null,
          pre_tokens: null,
        },
      }),
      false,
    ],
    [
      "context exhaustion",
      event({
        type: "context",
        context: {
          kind: "capacity_exhausted",
          cause: "unknown",
          native_code: null,
          trigger: null,
          pre_tokens: null,
        },
      }),
      false,
    ],
    ["completed", event({ type: "completed" }), false],
  ] as const)("classifies %s", (_name, input, expected) => {
    expect(countsAsAgentProgress(input)).toBe(expected);
  });

  it("defaults an unknown future event kind to non-progress", () => {
    expect(countsAsAgentProgress(event({ type: "vendor_keepalive" as HarnessEvent["type"] }))).toBe(
      false,
    );
  });
});

describe("withInactivityWatchdog useful-progress window", () => {
  it("allows a silent source to finish when the inactivity window is disabled", async () => {
    async function* quiet(): AsyncGenerator<string> {
      yield "started";
      await tick(40);
      yield "finished";
    }
    const seen: string[] = [];
    let timeouts = 0;
    for await (const value of withInactivityWatchdog(quiet(), {
      timeoutMs: null,
      countsAsProgress: () => {
        throw new Error("progress policy should not run without a timer");
      },
      onTimeout: () => {
        timeouts += 1;
      },
      isSuspended: () => {
        throw new Error("suspension policy should not run without a timer");
      },
      suspensionVersion: () => {
        throw new Error("suspension version should not run without a timer");
      },
    }))
      seen.push(value);

    expect(seen).toEqual(["started", "finished"]);
    expect(timeouts).toBe(0);
  });

  it("still awaits source cleanup when the caller breaks with timing disabled", async () => {
    let cleaned = false;
    async function* source(): AsyncGenerator<string> {
      try {
        yield "first";
        yield "second";
      } finally {
        await tick(10);
        cleaned = true;
      }
    }

    const seen: string[] = [];
    for await (const value of withInactivityWatchdog(source(), {
      timeoutMs: null,
      countsAsProgress: () => false,
      onTimeout: () => {
        throw new Error("unexpected timeout");
      },
    })) {
      seen.push(value);
      break;
    }
    expect(seen).toEqual(["first"]);
    expect(cleaned).toBe(true);
  });

  it("preserves source cancellation and cleanup with timing disabled", async () => {
    const controller = new AbortController();
    let cleaned = false;
    async function* source(): AsyncGenerator<string> {
      try {
        yield "started";
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        cleaned = true;
      }
    }

    const seen: string[] = [];
    for await (const value of withInactivityWatchdog(source(), {
      timeoutMs: null,
      countsAsProgress: () => false,
      onTimeout: () => {
        throw new Error("unexpected timeout");
      },
    })) {
      seen.push(value);
      controller.abort();
    }
    expect(seen).toEqual(["started"]);
    expect(cleaned).toBe(true);
  });

  it("preserves source errors and cleanup with timing disabled", async () => {
    let cleaned = false;
    async function* source(): AsyncGenerator<string> {
      try {
        yield "started";
        throw new Error("source failed");
      } finally {
        cleaned = true;
      }
    }

    const seen: string[] = [];
    let thrown: unknown;
    try {
      for await (const value of withInactivityWatchdog(source(), {
        timeoutMs: null,
        countsAsProgress: () => false,
        onTimeout: () => {
          throw new Error("unexpected timeout");
        },
      }))
        seen.push(value);
    } catch (error) {
      thrown = error;
    }
    expect(seen).toEqual(["started"]);
    expect(thrown).toEqual(new Error("source failed"));
    expect(cleaned).toBe(true);
  });

  it("drains what a stopped source reports during teardown when the caller keeps consuming", async () => {
    const stop = new AbortController();
    async function* source(): AsyncGenerator<string> {
      yield "started";
      await new Promise<void>((resolve) => {
        if (stop.signal.aborted) resolve();
        else stop.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield "teardown-warning";
      yield "completed";
    }

    const seen: string[] = [];
    for await (const value of withInactivityWatchdog(source(), {
      timeoutMs: null,
      countsAsProgress: () => false,
      onTimeout: () => {
        throw new Error("unexpected timeout");
      },
      stopSignal: stop.signal,
    })) {
      seen.push(value);
      stop.abort();
    }
    expect(seen).toEqual(["started", "teardown-warning", "completed"]);
  });

  it("bounds the Stop drain by the cleanup deadline even with timing disabled", async () => {
    const stop = new AbortController();
    async function* wedged(): AsyncGenerator<string> {
      try {
        yield "started";
        yield "teardown-warning";
        await new Promise<void>(() => {});
      } finally {
        await new Promise<void>(() => {});
      }
    }

    const seen: string[] = [];
    let stoppedAt = 0;
    for await (const value of withInactivityWatchdog(wedged(), {
      timeoutMs: null,
      countsAsProgress: () => false,
      onTimeout: () => {
        throw new Error("unexpected timeout");
      },
      stopSignal: stop.signal,
      cleanupDeadlineMs: 400,
    })) {
      seen.push(value);
      if (!stop.signal.aborted) stoppedAt = performance.now();
      stop.abort();
    }
    expect(seen).toEqual(["started", "teardown-warning"]);
    // ONE cleanup allowance across the drain and the wedged return(), not a
    // drain deadline followed by a second full return grace.
    const elapsed = performance.now() - stoppedAt;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(750);
  });

  it("preserves a configured window longer than one Node timer delay", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    async function* source(): AsyncGenerator<string> {
      yield "started";
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    const timeoutMs = 2_147_483_647 + 1_000;
    let timeouts = 0;
    let thrown: unknown;
    const consumed = (async () => {
      try {
        for await (const _value of withInactivityWatchdog(source(), {
          timeoutMs,
          countsAsProgress: () => true,
          onTimeout: () => {
            timeouts += 1;
            controller.abort();
          },
          cleanupDeadlineMs: 10,
        })) {
          // drain
        }
      } catch (error) {
        thrown = error;
      }
    })();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(timeouts).toBe(0);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1_001);
    expect(timeouts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(timeouts).toBe(1);
    await vi.runAllTimersAsync();
    await consumed;
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
    expect((thrown as HarnessInactivityTimeoutError).timeoutMs).toBe(timeoutMs);
  });

  it("keeps zero as an active inactivity window", async () => {
    const controller = new AbortController();
    async function* source(): AsyncGenerator<string> {
      yield "started";
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    let timeouts = 0;
    let thrown: unknown;
    try {
      for await (const _value of withInactivityWatchdog(source(), {
        timeoutMs: 0,
        countsAsProgress: () => true,
        onTimeout: () => {
          timeouts += 1;
          controller.abort();
        },
        cleanupDeadlineMs: 100,
      })) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }
    expect(timeouts).toBe(1);
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  });

  it("times out retry chatter even while the source keeps emitting it", async () => {
    const controller = new AbortController();
    async function* chatter(): AsyncGenerator<HarnessEvent> {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await tick(15);
        if (controller.signal.aborted) return;
        yield {
          type: "status",
          session_id: "ses_chatter",
          ts: new Date().toISOString(),
          status: { kind: "api_retry", attempt, max_retries: 5 },
        };
      }
    }
    const seen: HarnessEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const value of withInactivityWatchdog(chatter(), {
        timeoutMs: 25,
        countsAsProgress: countsAsAgentProgress,
        onTimeout: () => controller.abort(),
        cleanupDeadlineMs: 100,
      })) {
        seen.push(value);
      }
    } catch (error) {
      thrown = error;
    }
    expect(seen).toHaveLength(1);
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  });

  it("re-arms for a genuine message delta", async () => {
    const controller = new AbortController();
    async function* progressing(): AsyncGenerator<HarnessEvent> {
      await tick(20);
      yield {
        type: "message",
        session_id: "ses_progressing",
        ts: new Date().toISOString(),
        text: "real delta",
      };
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    const started = Date.now();
    let thrown: unknown = null;
    try {
      for await (const _value of withInactivityWatchdog(progressing(), {
        timeoutMs: 30,
        countsAsProgress: countsAsAgentProgress,
        onTimeout: () => controller.abort(),
        cleanupDeadlineMs: 100,
      })) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
  });

  it("starts a full inactivity window after an interaction answer", async () => {
    const controller = new AbortController();
    let suspended = false;
    let suspensionVersion = 0;
    let resumedAt = 0;
    async function* awaitingAnswer(): AsyncGenerator<HarnessEvent> {
      yield {
        type: "interaction_requested",
        session_id: "ses_interaction",
        ts: new Date().toISOString(),
        interaction: {
          interaction_id: "i1",
          source_tool: "AskUserQuestion",
          delivery: "blocking",
          questions: [],
        },
      } as HarnessEvent;
      // Production ordering: the adapter emits interaction_requested first;
      // only the following iterator.next() enters channel.request(). The whole
      // wait may therefore begin and end between watchdog timer polls.
      suspended = true;
      suspensionVersion += 1;
      await tick(45);
      suspended = false;
      suspensionVersion += 1;
      resumedAt = Date.now();
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    const timeoutMs = 60;
    let timedOutAt = 0;
    let thrown: unknown = null;
    try {
      for await (const _value of withInactivityWatchdog(awaitingAnswer(), {
        timeoutMs,
        countsAsProgress: countsAsAgentProgress,
        isSuspended: () => suspended,
        suspensionVersion: () => suspensionVersion,
        onTimeout: () => {
          timedOutAt = Date.now();
          controller.abort();
        },
        cleanupDeadlineMs: 100,
      })) {
        // drain
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessInactivityTimeoutError);
    expect(resumedAt).toBeGreaterThan(0);
    expect(timedOutAt - resumedAt).toBeGreaterThanOrEqual(timeoutMs - 15);
  });
});
