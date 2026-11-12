import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { runCapture } from "@claudexor/core";
import {
  CURSOR_STATUS_TIMEOUT_MS,
  probeCursorNativeAuth,
  type CursorStatusObservation,
} from "./auth.js";
import { cursorProfileRunEnv } from "./profile.js";
import {
  CURSOR_PINNED_STATUS_WAIT_MS,
  CURSOR_STATUS_LAST_POSITIVE_MS,
  CURSOR_STATUS_REUSE_MS,
  createCursorStatusCoordinator,
} from "./status-cache.js";

type EnvMap = Record<string, string | null | undefined>;

const T0 = Date.parse("2026-09-28T19:52:00.000Z");
const SUPERSEDED: CursorStatusObservation = {
  kind: "unknown",
  error: "cursor-agent status answer predates a credential change; login state unknown",
};
const TIMED_OUT: CursorStatusObservation = {
  kind: "unknown",
  error: "cursor-agent status did not answer within 10s (SIGKILL); login state unknown",
  timedOut: true,
};
let root: string;
let priorRoot: string | undefined;
beforeEach(() => {
  // Row HOMEs must live under the Claudexor profiles tree (realpath: macOS tmp).
  root = realpathSync(mkdtempSync(join(tmpdir(), "claudexor-cursor-status-")));
  priorRoot = process.env.CLAUDEXOR_CONFIG_DIR;
  process.env.CLAUDEXOR_CONFIG_DIR = root;
});
afterEach(() => {
  if (priorRoot === undefined) delete process.env.CLAUDEXOR_CONFIG_DIR;
  else process.env.CLAUDEXOR_CONFIG_DIR = priorRoot;
  rmSync(root, { recursive: true, force: true });
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
const rowHome = (id: string) => join(root, "profiles", `cursor-${id}`);
const rowA = () => cursorProfileRunEnv(rowHome("a"));
const rowB = () => cursorProfileRunEnv(rowHome("b"));

function deferred() {
  let resolve!: (value: CursorStatusObservation) => void;
  const promise = new Promise<CursorStatusObservation>((r) => (resolve = r));
  return { promise, resolve };
}

/** `clock.now` is the MONOTONIC clock every age reads; `clock.wall` stamps
 * only when the vendor answered (it tracks `now` unless a test steps it). */
function harness(answers: Array<CursorStatusObservation | ReturnType<typeof deferred>>) {
  const clock = { now: T0, wallOffset: 0, mutating: false };
  const calls: EnvMap[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const budgets: number[] = [];
  const coordinator = createCursorStatusCoordinator({
    monotonicMs: () => clock.now,
    wallMs: () => clock.now + clock.wallOffset,
    mutating: () => clock.mutating,
    probe: async (env, signal, budgetMs) => {
      calls.push(env ?? {});
      signals.push(signal);
      budgets.push(budgetMs);
      const next = answers.shift() ?? { kind: "unknown", error: "no scripted answer" };
      return "promise" in next ? next.promise : next;
    },
  });
  return { coordinator, calls, signals, budgets, clock };
}

describe("Cursor status coordinator (#363)", () => {
  it("concurrent callers for one row store share ONE status child", async () => {
    const pending = deferred();
    const h = harness([pending]);
    const first = h.coordinator.status(rowA());
    // Same auth store, different lane state dir (spawn-time env): still shared.
    const second = h.coordinator.status(cursorProfileRunEnv(rowHome("a"), { HOME: "/tmp/lane" }));
    pending.resolve({ kind: "authenticated", email: "b@example.com" });
    expect(await first).toMatchObject({ kind: "authenticated", email: "b@example.com" });
    expect(await second).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(1);
    // The shared child runs under the coordinator's own signal, never a
    // single caller's, and an answered child is not stopped (#532).
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]).toBeInstanceOf(AbortSignal);
    expect(h.signals[0]?.aborted).toBe(false);
  });

  it("reuses a positive answer for the bounded window with its original instant", async () => {
    const h = harness([{ kind: "authenticated" }, { kind: "authenticated" }]);
    const fresh = await h.coordinator.status(rowA());
    expect(fresh).toEqual({ kind: "authenticated", observedAt: new Date(T0).toISOString() });
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS - 1;
    expect(await h.coordinator.status(rowA())).toEqual(fresh);
    expect(h.calls).toHaveLength(1);
    // Another row's store is never served from this row's answer.
    await h.coordinator.status(rowB());
    expect(h.calls).toHaveLength(2);
    // Past the window the store is asked again.
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    await h.coordinator.status(rowA());
    expect(h.calls).toHaveLength(3);
  });

  it("expires a fractional upper age at reuse and last-positive boundaries", async () => {
    const h = harness([{ kind: "authenticated" }, TIMED_OUT, TIMED_OUT]);
    const fresh = await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS - 1.2;
    expect(await h.coordinator.status(rowA())).toEqual(fresh);
    expect(h.calls).toHaveLength(1);
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS - 0.2;
    expect(await h.coordinator.status(rowA())).toMatchObject({
      kind: "unknown",
      lastPositive: { ageMs: CURSOR_STATUS_REUSE_MS },
    });
    expect(h.calls).toHaveLength(2);
    h.clock.now = T0 + CURSOR_STATUS_LAST_POSITIVE_MS - 0.2;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    expect(h.calls).toHaveLength(3);
  });

  it("an unanswered probe is never cached, never a logout and never a pass", async () => {
    const h = harness([TIMED_OUT, TIMED_OUT, { kind: "authenticated" }]);
    // No positive answer was ever seen: unknown is not positive proof.
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    expect(await h.coordinator.status(rowA())).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(3);
  });

  it("a timeout inside the bound stays unknown and carries the last positive with its age", async () => {
    const h = harness([{ kind: "authenticated", email: "b@example.com" }, TIMED_OUT, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    const first = await h.coordinator.status(rowA());
    expect(first).toEqual({
      ...TIMED_OUT,
      lastPositive: { observedAt: new Date(T0).toISOString(), ageMs: CURSOR_STATUS_REUSE_MS },
    });
    // A timeout never refreshes the answer it leans on: the age keeps growing.
    h.clock.now = T0 + CURSOR_STATUS_LAST_POSITIVE_MS - 1;
    expect(await h.coordinator.status(rowA())).toMatchObject({
      kind: "unknown",
      lastPositive: { ageMs: CURSOR_STATUS_LAST_POSITIVE_MS - 1 },
    });
    expect(h.calls).toHaveLength(3);
  });

  it("the last positive expires at its bound", async () => {
    const h = harness([{ kind: "authenticated" }, TIMED_OUT, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_LAST_POSITIVE_MS;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    h.clock.now = T0 + 1; // an expired entry is gone, not resurrected by a clock step
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("only a timeout leans on the last positive; another failure stays plain unknown", async () => {
    const failed: CursorStatusObservation = {
      kind: "unknown",
      error: "cursor-agent status failed (1)",
    };
    const h = harness([{ kind: "authenticated" }, failed]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    expect(await h.coordinator.status(rowA())).toEqual(failed);
  });

  it("a logged-out answer from the store revokes its last positive", async () => {
    const h = harness([{ kind: "authenticated" }, { kind: "loggedOut" }, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    expect(await h.coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    h.clock.now += 1;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("a credential mutation revokes every last positive", async () => {
    const h = harness([{ kind: "authenticated" }, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.coordinator.clear();
    h.clock.now = T0 + 1;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("another row's positive never stands in for this row", async () => {
    const h = harness([{ kind: "authenticated" }, TIMED_OUT]);
    await h.coordinator.status(rowB());
    h.clock.now = T0 + 1;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("a logged-out answer is returned as such and is not remembered", async () => {
    const h = harness([{ kind: "loggedOut" }, { kind: "authenticated" }]);
    expect(await h.coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    expect(await h.coordinator.status(rowA())).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(2);
  });

  it("clear() drops reuse and stops an in-flight probe from repopulating it", async () => {
    const inFlight = deferred();
    const h = harness([{ kind: "authenticated" }, inFlight, { kind: "loggedOut" }]);
    await h.coordinator.status(rowA());
    h.coordinator.clear();
    h.clock.now = T0 + 1;
    const racing = h.coordinator.status(rowA());
    h.coordinator.clear();
    inFlight.resolve({ kind: "authenticated" });
    expect(await racing).toEqual(SUPERSEDED);
    // The pre-mutation answer was not cached: the next call asks the store.
    expect(await h.coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    expect(h.calls).toHaveLength(3);
  });

  it("an old positive landing after a new logout answer is unknown to its waiters, never authenticated", async () => {
    const old = deferred();
    const fresh = deferred();
    const h = harness([old, fresh, { kind: "loggedOut" }]);
    // Two callers share the child that started before the logout mutation.
    const oldWaiter = h.coordinator.status(rowA());
    const oldJoiner = h.coordinator.status(
      cursorProfileRunEnv(rowHome("a"), { HOME: "/tmp/lane" }),
    );
    h.coordinator.clear();
    // A caller after the mutation gets its own child, which sees the logout.
    const newWaiter = h.coordinator.status(rowA());
    fresh.resolve({ kind: "loggedOut" });
    expect(await newWaiter).toEqual({ kind: "loggedOut" });
    old.resolve({ kind: "authenticated", email: "a@example.com" });
    expect(await oldWaiter).toEqual(SUPERSEDED);
    expect(await oldJoiner).toEqual(SUPERSEDED);
    // Nor did the old positive become reuse: the next caller asks the store.
    expect(await h.coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    expect(h.calls).toHaveLength(3);
  });

  it("an old logout landing after a login mutation is unknown too, never login advice", async () => {
    const old = deferred();
    const h = harness([old, { kind: "authenticated" }]);
    const oldWaiter = h.coordinator.status(rowA());
    h.coordinator.clear();
    old.resolve({ kind: "loggedOut" });
    expect(await oldWaiter).toEqual(SUPERSEDED);
    expect(await h.coordinator.status(rowA())).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(2);
  });

  it("a caller's abort answers that caller unknown without cancelling the shared child", async () => {
    const pending = deferred();
    const h = harness([pending]);
    const controller = new AbortController();
    const aborted = h.coordinator.status(rowA(), controller.signal);
    const patient = h.coordinator.status(rowA());
    controller.abort();
    expect(await aborted).toEqual({ kind: "unknown", error: "cursor-agent status probe aborted" });
    pending.resolve({ kind: "authenticated" });
    expect(await patient).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(1);
  });

  it("ages every answer on the monotonic clock: a wall-clock step neither keeps nor expires it", async () => {
    const h = harness([{ kind: "authenticated" }, TIMED_OUT, TIMED_OUT, { kind: "authenticated" }]);
    const fresh = await h.coordinator.status(rowA());
    // The wall clock jumps a day back, then an hour forward: reuse is unmoved.
    h.clock.wallOffset = -24 * 60 * 60_000;
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS - 1;
    expect(await h.coordinator.status(rowA())).toEqual(fresh);
    h.clock.wallOffset = 60 * 60_000;
    expect(await h.coordinator.status(rowA())).toEqual(fresh);
    expect(h.calls).toHaveLength(1);
    // The last positive keeps the instant the vendor answered (wall) and an
    // age measured on the monotonic clock, whatever the wall clock says now.
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    expect(await h.coordinator.status(rowA())).toEqual({
      ...TIMED_OUT,
      lastPositive: { observedAt: new Date(T0).toISOString(), ageMs: CURSOR_STATUS_REUSE_MS },
    });
    // A backward wall step cannot make an expired last positive young again.
    h.clock.now = T0 + CURSOR_STATUS_LAST_POSITIVE_MS;
    h.clock.wallOffset = -CURSOR_STATUS_LAST_POSITIVE_MS;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    // A new answer is stamped with the (stepped) wall instant it arrived at.
    expect(await h.coordinator.status(rowA())).toEqual({
      kind: "authenticated",
      observedAt: new Date(T0).toISOString(),
    });
  });

  it("inside a credential-mutation window answers live and keeps or leans on nothing", async () => {
    const h = harness([
      { kind: "authenticated", email: "old@example.com" },
      { kind: "authenticated", email: "mid@example.com" },
      TIMED_OUT,
      { kind: "authenticated", email: "new@example.com" },
      TIMED_OUT,
    ]);
    await h.coordinator.status(rowA()); // a positive from BEFORE the window
    h.clock.mutating = true;
    h.clock.now = T0 + 1;
    // No reuse of the pre-window answer: the store is asked live.
    expect(await h.coordinator.status(rowA())).toMatchObject({ email: "mid@example.com" });
    // A timeout inside the window never leans on any positive.
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    expect(h.calls).toHaveLength(3);
    h.clock.mutating = false;
    h.coordinator.clear(); // the lifecycle's proven-death invalidation
    h.clock.now = T0 + 2;
    // After the window: a fresh answer is asked for, then reused as usual.
    expect(await h.coordinator.status(rowA())).toMatchObject({ email: "new@example.com" });
    expect(await h.coordinator.status(rowA())).toMatchObject({ email: "new@example.com" });
    expect(h.calls).toHaveLength(4);
    // Nothing observed inside the window became a last positive.
    h.clock.now = T0 + 2 + CURSOR_STATUS_REUSE_MS;
    expect(await h.coordinator.status(rowA())).toMatchObject({
      lastPositive: { observedAt: new Date(T0 + 2).toISOString() },
    });
  });

  it("an answer that ends inside a window, or starts inside one, is never retained", async () => {
    const endsInside = deferred();
    const startsInside = deferred();
    const h = harness([endsInside, startsInside, TIMED_OUT, TIMED_OUT]);
    const before = h.coordinator.status(rowA());
    h.clock.mutating = true; // the window opens while the probe is in flight
    endsInside.resolve({ kind: "authenticated", email: "a@example.com" });
    expect(await before).toMatchObject({ kind: "authenticated" });
    const inside = h.coordinator.status(rowA());
    h.clock.mutating = false; // ...and closes (without an invalidation) before it ends
    startsInside.resolve({ kind: "authenticated", email: "a@example.com" });
    expect(await inside).toMatchObject({ kind: "authenticated" });
    // Neither answer was kept: a later timeout has no last positive to lean on.
    h.clock.now = T0 + 1;
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
    expect(h.calls).toHaveLength(3);
  });

  it("never shares an env that is not a scrubbed row file store", async () => {
    const h = harness([{ kind: "authenticated" }, { kind: "authenticated" }]);
    const hostLike = { HOME: "/Users/someone", AGENT_CLI_CREDENTIAL_STORE: "file" };
    await h.coordinator.status(hostLike);
    await h.coordinator.status(hostLike);
    expect(h.calls).toHaveLength(2);
  });
});

describe("each caller waits on its own budget; the child lives while one still waits (#532)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const PINNED = { pinned: true } as const;
  const ABORTED: CursorStatusObservation = {
    kind: "unknown",
    error: "cursor-agent status probe aborted",
  };
  const unanswered = (seconds: number): CursorStatusObservation => ({
    kind: "unknown",
    error: `cursor-agent status did not answer within ${seconds}s; login state unknown`,
    timedOut: true,
  });
  const watch = <T>(promise: Promise<T>) => {
    const state = { settled: false };
    void promise.then(() => (state.settled = true));
    return state;
  };

  it("an explicit pin keeps waiting for the same child past the ordinary budget and takes its answer", async () => {
    const pending = deferred();
    const h = harness([pending]);
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    const state = watch(pin);
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS + 1_000);
    expect(state.settled).toBe(false);
    expect(h.signals[0]?.aborted).toBe(false);
    pending.resolve({ kind: "authenticated", email: "a@example.com" });
    expect(await pin).toMatchObject({ kind: "authenticated", email: "a@example.com" });
    expect(h.calls).toHaveLength(1);
    // The shared child is bounded by the pinned wait, not by one caller.
    expect(h.budgets).toEqual([CURSOR_PINNED_STATUS_WAIT_MS]);
  });

  it("an ordinary caller still decides at the ordinary budget, with its last positive, while a pin keeps the child", async () => {
    const pending = deferred();
    const h = harness([{ kind: "authenticated" }, pending]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    const ordinary = h.coordinator.status(rowA());
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
    expect(await ordinary).toEqual({
      ...unanswered(10),
      lastPositive: { observedAt: new Date(T0).toISOString(), ageMs: CURSOR_STATUS_REUSE_MS },
    });
    expect(h.signals[1]?.aborted).toBe(false);
    pending.resolve({ kind: "authenticated" });
    expect(await pin).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(2);
  });

  it("an ordinary caller alone stops its child at the ordinary budget, as before", async () => {
    const pending = deferred();
    const h = harness([pending, { kind: "authenticated" }]);
    const ordinary = h.coordinator.status(rowA());
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS - 1);
    expect(h.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ordinary).toEqual(unanswered(10));
    expect(h.signals[0]?.aborted).toBe(true);
    // A stopped child is never shared again: the next caller asks anew.
    expect(await h.coordinator.status(rowA())).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(2);
  });

  it("a pin that is never answered gives up at the pinned bound and stops the child", async () => {
    const h = harness([deferred()]);
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    const state = watch(pin);
    await vi.advanceTimersByTimeAsync(CURSOR_PINNED_STATUS_WAIT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pin).toEqual(unanswered(120));
    expect(h.signals[0]?.aborted).toBe(true);
  });

  it("one caller's cancellation ends only its own wait; the child stops when no caller waits", async () => {
    const h = harness([deferred()]);
    const first = new AbortController();
    const second = new AbortController();
    const a = h.coordinator.status(rowA(), first.signal, PINNED);
    const b = h.coordinator.status(rowA(), second.signal, PINNED);
    await vi.advanceTimersByTimeAsync(20_000);
    first.abort();
    expect(await a).toEqual(ABORTED);
    expect(h.signals[0]?.aborted).toBe(false);
    second.abort();
    expect(await b).toEqual(ABORTED);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it("a credential mutation during a pin's wait answers it unknown at once and stops the child", async () => {
    const pending = deferred();
    const h = harness([pending, { kind: "authenticated" }]);
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    await vi.advanceTimersByTimeAsync(30_000);
    h.coordinator.clear();
    expect(await pin).toEqual(SUPERSEDED);
    expect(h.signals[0]?.aborted).toBe(true);
    // The old child's late positive is not kept: the next caller asks anew.
    pending.resolve({ kind: "authenticated", email: "old@example.com" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.coordinator.status(rowA())).toEqual({
      kind: "authenticated",
      observedAt: new Date(T0).toISOString(),
    });
    expect(h.calls).toHaveLength(2);
  });

  it("a logged-out answer during a pin's wait is the vendor's answer and revokes the last positive", async () => {
    const pending = deferred();
    const h = harness([{ kind: "authenticated" }, pending, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    await vi.advanceTimersByTimeAsync(40_000);
    pending.resolve({ kind: "loggedOut" });
    expect(await pin).toEqual({ kind: "loggedOut" });
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("an ordinary caller joining a pin's child keeps its own budget from when it asked", async () => {
    const pending = deferred();
    const h = harness([pending]);
    const pin = h.coordinator.status(rowA(), undefined, PINNED);
    await vi.advanceTimersByTimeAsync(50_000);
    const ordinary = h.coordinator.status(rowA());
    const state = watch(ordinary);
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ordinary).toEqual(unanswered(10));
    expect(h.signals[0]?.aborted).toBe(false);
    pending.resolve({ kind: "authenticated" });
    expect(await pin).toMatchObject({ kind: "authenticated" });
    expect(h.calls).toHaveLength(1);
  });

  it("an unshared env gives a pin the pinned budget on its own child", async () => {
    const h = harness([{ kind: "authenticated" }, { kind: "authenticated" }]);
    const hostLike = { HOME: "/Users/someone", AGENT_CLI_CREDENTIAL_STORE: "file" };
    const controller = new AbortController();
    await h.coordinator.status(hostLike, controller.signal, PINNED);
    await h.coordinator.status(hostLike, controller.signal);
    expect(h.budgets).toEqual([CURSOR_PINNED_STATUS_WAIT_MS, CURSOR_STATUS_TIMEOUT_MS]);
    expect(h.signals).toEqual([controller.signal, controller.signal]);
  });
});

describe("a read no caller waits for any more never repopulates the cache (#532)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const ABORTED: CursorStatusObservation = {
    kind: "unknown",
    error: "cursor-agent status probe aborted",
  };

  it("a positive that lands after its only waiter cancelled leaves a newer logged-out answer in force", async () => {
    const old = deferred();
    const h = harness([old, { kind: "loggedOut" }, { kind: "authenticated" }]);
    const cancel = new AbortController();
    const first = h.coordinator.status(rowA(), cancel.signal);
    cancel.abort();
    expect(await first).toEqual(ABORTED);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(await h.coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    old.resolve({ kind: "authenticated", email: "old@example.com" });
    await vi.advanceTimersByTimeAsync(0);
    // Nothing was kept from the abandoned read: the store is asked again.
    expect(await h.coordinator.status(rowA())).toEqual({
      kind: "authenticated",
      observedAt: new Date(T0).toISOString(),
    });
    expect(h.calls).toHaveLength(3);
  });

  it.each([
    { label: "logged out", newer: { kind: "loggedOut" } as CursorStatusObservation },
    {
      label: "signed in as another account",
      newer: { kind: "authenticated", email: "new@example.com" } as CursorStatusObservation,
    },
  ])(
    "a positive that lands after its only waiter timed out never replaces a newer read ($label)",
    async ({ newer }) => {
      const old = deferred();
      const h = harness([old, newer, TIMED_OUT]);
      const first = h.coordinator.status(rowA());
      await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
      expect(await first).toMatchObject({ kind: "unknown", timedOut: true });
      expect(h.signals[0]?.aborted).toBe(true);
      h.clock.now = T0 + 1;
      const fresh = await h.coordinator.status(rowA());
      expect(fresh).toMatchObject({ kind: newer.kind });
      old.resolve({ kind: "authenticated", email: "old@example.com" });
      await vi.advanceTimersByTimeAsync(0);
      // A newer positive is still what reuse serves; after a newer logout the
      // store is asked again and the late positive is no last positive either.
      expect(await h.coordinator.status(rowA())).toEqual(
        newer.kind === "authenticated" ? fresh : TIMED_OUT,
      );
      expect(h.calls).toHaveLength(newer.kind === "authenticated" ? 2 : 3);
    },
  );

  it("a logged-out answer that lands after its only waiter left still revokes the last positive", async () => {
    const late = deferred();
    const h = harness([{ kind: "authenticated" }, late, TIMED_OUT]);
    await h.coordinator.status(rowA());
    h.clock.now = T0 + CURSOR_STATUS_REUSE_MS;
    const first = h.coordinator.status(rowA());
    await vi.advanceTimersByTimeAsync(CURSOR_STATUS_TIMEOUT_MS);
    expect(await first).toMatchObject({
      kind: "unknown",
      lastPositive: { ageMs: CURSOR_STATUS_REUSE_MS },
    });
    late.resolve({ kind: "loggedOut" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.coordinator.status(rowA())).toEqual(TIMED_OUT);
  });

  it("through the real status probe, a vendor answer that finishes despite its cancel is not kept", async () => {
    vi.useRealTimers();
    let calls = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const capture: typeof runCapture = async (_bin, _args, opts) => {
      const call = ++calls;
      // The first read completes its answer after the coordinator stopped it.
      if (call === 1) await released;
      opts?.onExit?.(0, null);
      const verdict = call === 2 ? { authenticated: false } : { authenticated: true };
      return { code: 0, signal: null, stdout: JSON.stringify(verdict), stderr: "" };
    };
    const coordinator = createCursorStatusCoordinator({
      probe: (env, signal, budgetMs) => probeCursorNativeAuth(env, signal, capture, budgetMs),
      monotonicMs: () => T0,
      wallMs: () => T0,
      mutating: () => false,
    });
    const cancel = new AbortController();
    const first = coordinator.status(rowA(), cancel.signal);
    cancel.abort();
    expect(await first).toEqual(ABORTED);
    expect(await coordinator.status(rowA())).toEqual({ kind: "loggedOut" });
    release();
    // A macrotask boundary: the late answer's whole promise chain has settled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(await coordinator.status(rowA())).toMatchObject({ kind: "authenticated" });
    expect(calls).toBe(3);
  });
});
