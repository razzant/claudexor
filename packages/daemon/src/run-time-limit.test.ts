import { afterEach, describe, expect, it, vi } from "vitest";
import { RunTimeLimit } from "./run-time-limit.js";

afterEach(() => vi.useRealTimers());
const setup = (seconds?: number, mode?: "soft" | "hard") => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  const events: string[] = [];
  const timer = new RunTimeLimit({
    seconds,
    mode,
    onChange: (action) => {
      events.push(action);
    },
  });
  return { timer, events };
};

describe("live run time limit", () => {
  it("observes an elapsed deadline before its delayed callback runs", () => {
    const { timer, events } = setup(1);
    vi.setSystemTime(new Date("2026-10-15T12:00:02Z"));
    expect(timer.control({ action: "read" })).toMatchObject({
      state: "reached",
      revision: 1,
    });
    expect(timer.signal.aborted).toBe(true);
    expect(events).toEqual(["reached"]);
    timer.dispose();
  });
  it("has no implicit deadline", async () => {
    const { timer, events } = setup();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(timer.snapshot().state).toBe("disabled");
    expect(timer.signal.aborted).toBe(false);
    expect(events).toEqual([]);
    timer.dispose();
  });
  it("preserves legacy hard limit and refuses resurrection after expiry", async () => {
    const { timer } = setup(10);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timer.signal.aborted).toBe(true);
    expect(timer.signal.reason).toBe("wall_clock_exceeded");
    expect(() =>
      timer.control({ action: "extend", seconds: 10, expectedRevision: timer.snapshot().revision }),
    ).toThrow(/expired|closed/);
    timer.dispose();
  });
  it("soft expiry notifies once without cancelling, and can be extended", async () => {
    const { timer, events } = setup(10, "soft");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timer.signal.aborted).toBe(false);
    expect(timer.snapshot().state).toBe("reached");
    expect(events).toEqual(["reached"]);
    timer.control({ action: "extend", seconds: 20, expectedRevision: timer.snapshot().revision });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(events).toEqual(["reached", "extend"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(["reached", "extend", "reached"]);
    timer.dispose();
  });
  it("extends the same stable signal and revokes the old deadline", async () => {
    const { timer } = setup(10);
    const signal = timer.signal;
    await vi.advanceTimersByTimeAsync(5000);
    const old = timer.snapshot();
    const next = timer.control({ action: "extend", seconds: 20, expectedRevision: old.revision });
    expect(next.deadlineAt).toBe("2026-10-15T12:00:30.000Z");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(timer.signal).toBe(signal);
    timer.dispose();
  });
  it("disable clears the clock and stale/replayed mutations never apply twice", async () => {
    const { timer } = setup(10);
    const revision = timer.snapshot().revision;
    timer.control({ action: "disable", expectedRevision: revision });
    expect(() =>
      timer.control({ action: "extend", seconds: 10, expectedRevision: revision }),
    ).toThrow(/revision/);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(timer.signal.aborted).toBe(false);
    expect(() =>
      timer.control({ action: "extend", seconds: 10, expectedRevision: timer.snapshot().revision }),
    ).toThrow(/disabled/);
    timer.dispose();
  });
  it("set measures from now and keeps an unclocked run's soft mode", async () => {
    const { timer } = setup();
    expect(timer.snapshot()).toMatchObject({ state: "disabled", mode: "soft", revision: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(timer.control({ action: "set", seconds: 10, expectedRevision: 0 })).toMatchObject({
      mode: "soft",
      deadlineAt: "2026-10-15T12:00:15.000Z",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timer.signal.aborted).toBe(false);
    timer.dispose();
  });
  it("set without mode never downgrades a hard limit, even after disable", async () => {
    const { timer } = setup(600);
    const reset = timer.control({ action: "set", seconds: 10, expectedRevision: 0 });
    expect(reset).toMatchObject({ mode: "hard", revision: 1 });
    const disabled = timer.control({ action: "disable", expectedRevision: reset.revision });
    expect(disabled).toMatchObject({ state: "disabled", mode: "hard" });
    expect(
      timer.control({ action: "set", seconds: 10, expectedRevision: disabled.revision }),
    ).toMatchObject({ state: "armed", mode: "hard" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timer.signal.reason).toBe("wall_clock_exceeded");
    timer.dispose();
  });
  it("changes mode only when set names one", async () => {
    const { timer } = setup(600);
    const soft = timer.control({ action: "set", seconds: 10, mode: "soft", expectedRevision: 0 });
    expect(soft).toMatchObject({ mode: "soft" });
    const extended = timer.control({
      action: "extend",
      seconds: 5,
      expectedRevision: soft.revision,
    });
    expect(extended).toMatchObject({ mode: "soft", deadlineAt: "2026-10-15T12:00:15.000Z" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(timer.signal.aborted).toBe(false);
    expect(timer.snapshot()).toMatchObject({ state: "reached", mode: "soft" });
    const hard = timer.control({
      action: "set",
      seconds: 1,
      mode: "hard",
      expectedRevision: timer.snapshot().revision,
    });
    expect(hard).toMatchObject({ state: "armed", mode: "hard" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(timer.signal.aborted).toBe(true);
    timer.dispose();
  });
  it("disposal cancels callbacks but does not forge a user abort", async () => {
    const { timer, events } = setup(10);
    timer.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([]);
    expect(timer.signal.aborted).toBe(false);
    expect(() => timer.control({ action: "set", seconds: 10, expectedRevision: 0 })).toThrow(
      /closed/,
    );
  });
  it("a failed notification cannot turn a soft limit into cancellation or prevent a hard stop", async () => {
    vi.useFakeTimers();
    const soft = new RunTimeLimit({
      seconds: 1,
      mode: "soft",
      onChange: () => {
        throw new Error("observer down");
      },
    });
    const hard = new RunTimeLimit({
      seconds: 1,
      onChange: () => {
        throw new Error("observer down");
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(soft.signal.aborted).toBe(false);
    expect(hard.signal.aborted).toBe(true);
    soft.dispose();
    hard.dispose();
  });
  it("rejects invalid bounds and totals without changing the deadline", () => {
    const { timer } = setup(604_800);
    const before = timer.snapshot();
    expect(() => timer.control({ action: "extend", seconds: 1, expectedRevision: 0 })).toThrow();
    expect(() => timer.control({ action: "set", seconds: 0, expectedRevision: 0 })).toThrow();
    expect(timer.snapshot()).toEqual(before);
    timer.dispose();
  });
});
