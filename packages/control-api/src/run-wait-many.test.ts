import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RunWaitManyInput,
  RunWaitManyResult,
  type ControlRunState,
  type RunObservationRecord,
  type RunWaitManySummary,
} from "@claudexor/schema";
import { digestPendingIdentities } from "../../daemon/src/interactions.js";
import { readRunObservations } from "../../daemon/src/run-observation.js";
import { StoreBusyError } from "../../daemon/src/store/errors.js";
import { observeRunAttention, type RunObservationListener } from "./run-wait-many.js";

const controllers: AbortController[] = [];
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const controller of controllers.splice(0)) controller.abort();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function controller() {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  releases.push(resolve);
  return { promise, resolve };
}

const unknown = (
  problem: "not_found" | "snapshot_unavailable" | "not_observed",
): RunWaitManySummary => ({
  status: null,
  pending: null,
  token: null,
  problem,
});

/** Only storage facts and timing are controlled. Tokens/aliases/attention use production owners.
 * A host with commit notices is never polled; pass `pollMs` for a host without them. */
function fixture(pollMs?: number) {
  const records = new Map<string, RunObservationRecord>();
  const questions = new Map<string, string[] | Error>();
  /** Runs whose pending questions are all async; any other pending run blocks. */
  const asyncOnly = new Set<string>();
  const listeners = new Set<RunObservationListener>();
  const subscribe = vi.fn((listener: RunObservationListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const read = (
    ids: readonly string[],
    signal?: AbortSignal,
    options?: { includeBlocking: true },
  ) =>
    readRunObservations(
      {
        observationRecords: (requested) =>
          [...records.values()].filter(
            (record) =>
              requested.includes(record.jobId) ||
              (record.runId !== null && requested.includes(record.runId)),
          ),
      },
      {
        snapshotPendingIdentities: async (ids) =>
          new Map<string, Error | ReturnType<typeof digestPendingIdentities>>(
            ids.map((id) => {
              const value = questions.get(id) ?? [];
              if (value instanceof Error) return [id, value] as const;
              const digest = digestPendingIdentities(value);
              return [id, asyncOnly.has(id) ? { ...digest, blocking: false } : digest] as const;
            }),
          ),
      },
      "11111111-1111-4111-8111-111111111111",
      ids,
      signal,
      options,
    );
  const snapshot = vi.fn(read);
  const host = pollMs === undefined ? { snapshot, subscribe } : { snapshot, pollMs };
  function seed(
    jobId: string,
    status: ControlRunState = "running",
    runId: string | null = `run-${jobId}`,
  ) {
    records.set(jobId, {
      jobId,
      runId,
      state: status,
      partition: "global",
      epoch: "epoch-one",
      createdAt: "2026-10-22T00:00:00.000Z",
    });
  }
  /** A committed write of these jobs: production notices name the job and its run. */
  function notice(...jobIds: string[]) {
    const keys = new Set(jobIds.flatMap((id) => [id, `run-${id}`]));
    for (const listener of listeners) listener(keys);
  }
  /** The served view moved: anything may have changed. */
  function noticeAll() {
    for (const listener of listeners) listener();
  }
  function begin(
    targets: Array<{ runId: string; seen?: string | null }>,
    waitMs?: number,
    signal = controller().signal,
  ) {
    const work = observeRunAttention(
      RunWaitManyInput.parse({ targets, ...(waitMs === undefined ? {} : { waitMs }) }),
      host,
      signal,
    );
    // Keep a deliberately failing implementation from generating an unhandled rejection before assertion.
    void work.catch(() => {});
    return work;
  }
  /** The same wait asking for the blocking fact. */
  function beginBlocking(
    targets: Array<{ runId: string; seen?: string | null }>,
    waitMs?: number,
    includeBlocking = true,
  ) {
    const work = observeRunAttention(
      RunWaitManyInput.parse({
        targets,
        includeBlocking,
        ...(waitMs === undefined ? {} : { waitMs }),
      }),
      host,
      controller().signal,
    );
    void work.catch(() => {});
    return work;
  }
  return {
    records,
    questions,
    asyncOnly,
    beginBlocking,
    listeners,
    snapshot,
    subscribe,
    host,
    seed,
    notice,
    noticeAll,
    read,
    begin,
  };
}

function clean(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  expect(f.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  if (signal) expect(getEventListeners(signal, "abort")).toHaveLength(0);
}

describe("observeRunAttention includeBlocking opt-in (#628)", () => {
  it("passes the opt-in to the snapshot owner, and otherwise calls it exactly as before", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    f.questions.set("run-a", ["question-a"]);
    f.asyncOnly.add("run-a");
    const targets = [{ runId: "a" }, { runId: "b" }];
    const plain = await f.begin(targets, 0);
    expect(f.snapshot.mock.calls.map((call) => call.length)).toEqual([2]);
    expect(JSON.stringify(plain)).not.toContain("blocking");
    f.snapshot.mockClear();
    const unasked = await f.beginBlocking(targets, 0, false);
    expect(f.snapshot.mock.calls.map((call) => call.length)).toEqual([2]);
    expect(JSON.stringify(unasked)).toBe(JSON.stringify(plain));
    f.snapshot.mockClear();
    const marked = await f.beginBlocking(targets, 0);
    expect(f.snapshot.mock.calls.map((call) => call[2])).toEqual([{ includeBlocking: true }]);
    expect(marked).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: [{ ...plain.summaries[0], blocking: false }, plain.summaries[1]],
    });
    clean(f);
  });

  it("keeps the opt-in on notice-driven re-reads and wakes on an async question like any other", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    const [a, b] = await f.read(["a", "b"]);
    const work = f.beginBlocking(
      [
        { runId: "a", seen: a!.token! },
        { runId: "b", seen: b!.token! },
      ],
      1000,
    );
    await vi.advanceTimersByTimeAsync(0);
    f.questions.set("run-b", ["question-b"]);
    f.asyncOnly.add("run-b");
    f.notice("b");
    await vi.advanceTimersByTimeAsync(0);
    const woke = await work;
    expect(woke).toMatchObject({ wakeReason: "attention", attention: [1] });
    expect(woke.summaries[1]).toMatchObject({ pending: true, blocking: false });
    expect(woke.summaries[0]).not.toHaveProperty("blocking");
    expect(f.snapshot.mock.calls.map(([ids, , options]) => [ids, options])).toEqual([
      [["a", "b"], { includeBlocking: true }],
      [["b"], { includeBlocking: true }],
    ]);
    // Echoing the async row's token acknowledges it exactly as a blocking one.
    expect(
      await f.beginBlocking(
        [
          { runId: "a", seen: a!.token! },
          { runId: "b", seen: woke.summaries[1]!.token },
        ],
        0,
      ),
    ).toMatchObject({ wakeReason: "timeout", attention: [] });
    clean(f);
  });
});

describe("observeRunAttention", () => {
  it.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
    "wakes for unseen %s, while echoing its token acknowledges only that summary",
    async (state) => {
      const f = fixture();
      f.seed("a", state);
      const first = RunWaitManyResult.parse(await f.begin([{ runId: "a" }], 0));
      expect(first).toEqual({
        wakeReason: "attention",
        attention: [0],
        summaries: await f.read(["a"]),
      });
      const token = first.summaries[0]!.token!;
      expect(await f.begin([{ runId: "a", seen: token }], 0)).toEqual({
        wakeReason: "timeout",
        attention: [],
        summaries: first.summaries,
      });
      expect(await f.begin([{ runId: "a", seen: "x".repeat(43) }], 0)).toEqual(first);
      clean(f);
    },
  );

  it("acknowledges a question without answering it; replacement at the same count wakes", async () => {
    const f = fixture();
    f.seed("a");
    f.questions.set("run-a", ["question-a"]);
    const first = await f.begin([{ runId: "a" }], 0);
    expect(first.attention).toEqual([0]);
    const seen = first.summaries[0]!.token!;
    expect(await f.begin([{ runId: "a", seen }], 0)).toMatchObject({
      wakeReason: "timeout",
      attention: [],
    });
    expect(f.questions.get("run-a")).toEqual(["question-a"]);
    f.questions.set("run-a", ["question-b"]);
    const replaced = await f.begin([{ runId: "a", seen }], 0);
    expect(replaced).toMatchObject({ wakeReason: "attention", attention: [0] });
    expect(replaced.summaries[0]!.token).not.toBe(seen);
    expect(replaced.summaries[0]!.pending).toBe(true);
    clean(f);
  });

  it.each(["terminal", "question"] as const)(
    "an acknowledged %s member does not starve another member",
    async (kind) => {
      const f = fixture();
      f.seed("a", kind === "terminal" ? "succeeded" : "running");
      if (kind === "question") f.questions.set("run-a", ["question-a"]);
      f.seed("b");
      const [a] = await f.read(["a"]);
      const work = f.begin([{ runId: "a", seen: a!.token! }, { runId: "b" }], 1000);
      let settled = false;
      void work.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      f.questions.set("run-b", ["question-b"]);
      f.notice("b");
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toEqual({
        wakeReason: "attention",
        attention: [1],
        summaries: await f.read(["a", "b"]),
      });
      clean(f);
    },
  );

  it("returns all simultaneous original indexes including aliases/duplicates, with healthy attention before problems", async () => {
    const f = fixture();
    f.seed("z", "succeeded");
    f.seed("a");
    f.questions.set("run-a", ["question-a"]);
    f.seed("broken");
    f.questions.set("run-broken", new Error("pending identities unreadable"));
    const ids = ["z", "run-a", "missing", "run-z", "a", "broken", "run-a"];
    expect(
      await f.begin(
        ids.map((runId) => ({ runId })),
        0,
      ),
    ).toEqual({
      wakeReason: "attention",
      attention: [0, 1, 3, 4, 6],
      summaries: await f.read(ids),
    });
    const summaries = await f.read(ids);
    expect(summaries[2]).toEqual(unknown("not_found"));
    expect(summaries[5]).toEqual(unknown("snapshot_unavailable"));
    clean(f);
  });

  it("returns problems immediately when no healthy row needs attention", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("broken");
    f.questions.set("run-broken", new Error("pending identities unavailable"));
    const ids = ["a", "missing", "broken"];
    expect(
      await f.begin(
        ids.map((runId) => ({ runId })),
        1000,
      ),
    ).toEqual({
      wakeReason: "problems",
      attention: [],
      summaries: await f.read(ids),
    });
    clean(f);
  });

  it("applies seen independently at duplicate/alias positions of the same terminal summary", async () => {
    const f = fixture();
    f.seed("a", "succeeded");
    const [row] = await f.read(["a"]);
    const targets = [
      { runId: "a", seen: row!.token! },
      { runId: "run-a" },
      { runId: "a", seen: "x".repeat(43) },
      { runId: "run-a", seen: row!.token! },
    ];
    expect(await f.begin(targets, 0)).toEqual({
      wakeReason: "attention",
      attention: [1, 2],
      summaries: [row, row, row, row],
    });
    clean(f);
  });

  it("performs exactly one snapshot for zero wait", async () => {
    const f = fixture();
    f.seed("a");
    expect(await f.begin([{ runId: "a" }], 0)).toEqual({
      wakeReason: "timeout",
      attention: [],
      summaries: await f.read(["a"]),
    });
    expect(f.snapshot).toHaveBeenCalledOnce();
    clean(f);
  });

  it("uses the default 25000ms absolute deadline, without extending it for progress", async () => {
    const f = fixture();
    f.seed("a", "queued", null);
    const work = f.begin([{ runId: "a" }]);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(24_999);
    f.seed("a"); // Binding changes the real token, but is not attention.
    f.notice("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await work).toEqual({
      wakeReason: "timeout",
      attention: [],
      summaries: await f.read(["a"]),
    });
    clean(f);
  });

  it("polls a host without commit notices across binding, then wakes for real attention", async () => {
    const f = fixture(37);
    f.seed("a", "queued", null);
    const work = f.begin([{ runId: "a" }], 500);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    f.seed("a");
    await vi.advanceTimersByTimeAsync(36);
    expect(f.snapshot).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    f.questions.set("run-a", ["question-a"]);
    await vi.advanceTimersByTimeAsync(37);
    expect(await work).toMatchObject({ wakeReason: "attention", attention: [0] });
    clean(f);
  });

  it("subscribes before reading and latches a notification during the snapshot before sleeping", async () => {
    const f = fixture();
    f.seed("a");
    const release = deferred();
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      expect(f.listeners.size).toBe(1);
      const stale = await f.read(ids, signal);
      await release.promise;
      return stale;
    });
    const work = f.begin([{ runId: "a" }], 1000);
    await vi.advanceTimersByTimeAsync(0);
    f.seed("a", "succeeded");
    f.notice("a");
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: await f.read(["a"]),
    });
    expect(f.subscribe).toHaveBeenCalledOnce();
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    clean(f);
  });

  it("coalesces repeated notices while a read is pending; unrelated notices never read", async () => {
    const f = fixture();
    f.seed("a");
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const rows = await f.read(ids, signal);
      await release.promise;
      active--;
      return rows;
    });
    const abort = controller();
    const work = f.begin([{ runId: "a" }], 1000, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) f.notice(i % 2 ? "unrelated" : "a");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.snapshot.mock.calls.length).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(1);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const reads = f.snapshot.mock.calls.length;
    for (let i = 0; i < 100; i++) f.notice("unrelated");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.snapshot).toHaveBeenCalledTimes(reads);
    abort.abort();
    expect((await work).wakeReason).toBe("aborted");
    clean(f, abort.signal);
    const calls = f.snapshot.mock.calls.length;
    f.noticeAll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.snapshot).toHaveBeenCalledTimes(calls);
    clean(f);
  });

  it("propagates a typed store-wide failure instead of inventing per-target problems", async () => {
    const f = fixture();
    const error = new StoreBusyError("fixture store busy");
    f.snapshot.mockRejectedValueOnce(error);
    const abort = controller();
    await expect(f.begin([{ runId: "a" }, { runId: "b" }], 1000, abort.signal)).rejects.toBe(error);
    clean(f, abort.signal);
  });

  it("repeated waits and wake bursts restore the same caller signal/listener/timer baseline", async () => {
    const f = fixture();
    const abort = controller();
    for (let pass = 0; pass < 10; pass++) {
      f.seed("a");
      const work = f.begin([{ runId: "a" }], 1000, abort.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.listeners.size).toBe(1);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
      f.seed("a", "succeeded");
      for (let wake = 0; wake < 50; wake++) f.notice("a");
      await vi.advanceTimersByTimeAsync(0);
      expect(await work).toMatchObject({ wakeReason: "attention", attention: [0] });
      clean(f, abort.signal);
    }
    expect(f.subscribe).toHaveBeenCalledTimes(10);
  });

  it("reports completed snapshot facts without replaying historical transient attention", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    const release = deferred();
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      const rows = await f.read(ids, signal);
      await release.promise;
      return rows;
    });
    const work = f.begin([{ runId: "a" }, { runId: "b" }], 1000);
    await vi.advanceTimersByTimeAsync(0);
    f.questions.set("run-a", ["transient-question"]);
    f.notice("a");
    f.questions.delete("run-a");
    f.seed("b", "succeeded");
    f.notice("b");
    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The pass is positional current evidence, without a global atomicity or event-history promise.
    expect(await work).toEqual({
      wakeReason: "attention",
      attention: [1],
      summaries: await f.read(["a", "b"]),
    });
    clean(f);
  });

  it("abort cancels an in-flight cooperative read and leaves no read/listener/timer", async () => {
    const f = fixture();
    const abort = controller();
    let active = 0;
    const signals: AbortSignal[] = [];
    f.snapshot.mockImplementationOnce(async (_ids, signal) => {
      expect(signal).toBeDefined();
      signals.push(signal!);
      active++;
      try {
        await new Promise<void>((resolve) => {
          if (signal!.aborted) return resolve();
          signal!.addEventListener("abort", () => resolve(), { once: true });
        });
        return [unknown("not_observed"), unknown("not_observed")];
      } finally {
        active--;
      }
    });
    const work = f.begin([{ runId: "a" }, { runId: "b" }], 50, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(1);
    abort.abort();
    expect(await work).toEqual({
      wakeReason: "aborted",
      attention: [],
      summaries: [unknown("not_observed"), unknown("not_observed")],
    });
    expect(signals[0]!.aborted).toBe(true);
    expect(active).toBe(0);
    clean(f, abort.signal);
  });

  it("lets the deadline wait for a started pass and answers its facts and attention", async () => {
    const f = fixture();
    f.seed("a", "succeeded");
    f.seed("b");
    const release = deferred();
    const signals: AbortSignal[] = [];
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      signals.push(signal!);
      await release.promise;
      return f.read(ids);
    });
    const work = f.begin([{ runId: "a" }, { runId: "b" }], 5);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    expect(signals[0]!.aborted).toBe(false);
    release.resolve();
    expect(await work).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: await f.read(["a", "b"]),
    });
    expect(f.snapshot).toHaveBeenCalledOnce();
    clean(f);
  });

  it("answers a positive wait shorter than one pass with that complete pass", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b", "queued", null);
    const release = deferred();
    f.snapshot.mockImplementationOnce(async (ids) => {
      await release.promise;
      return f.read(ids);
    });
    const work = f.begin([{ runId: "a" }, { runId: "b" }], 1);
    await vi.advanceTimersByTimeAsync(10);
    release.resolve();
    expect(await work).toEqual({
      wakeReason: "timeout",
      attention: [],
      summaries: await f.read(["a", "b"]),
    });
    expect((await work).summaries.every((row) => row.problem === null)).toBe(true);
    clean(f);
  });

  it("acknowledges a problem row by its echoed null token and waits for the healthy members", async () => {
    const f = fixture();
    f.seed("a");
    const first = await f.begin([{ runId: "a" }, { runId: "gone" }], 1000);
    expect(first).toMatchObject({ wakeReason: "problems", attention: [] });
    const echoed = [
      { runId: "a", seen: first.summaries[0]!.token },
      { runId: "gone", seen: first.summaries[1]!.token },
    ];
    expect(echoed[1]!.seen).toBeNull();
    const work = f.begin(echoed, 1000);
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    f.seed("a", "succeeded");
    f.notice("a");
    expect(await work).toEqual({
      wakeReason: "attention",
      attention: [0],
      summaries: await f.read(["a", "gone"]),
    });
    // A string seen on a problem row is not an acknowledgement of it.
    expect(
      await f.begin(
        [
          { runId: "a", seen: (await f.read(["a"]))[0]!.token },
          { runId: "gone", seen: "x".repeat(43) },
        ],
        1000,
      ),
    ).toMatchObject({ wakeReason: "problems" });
    clean(f);
  });

  it("re-reads only the handles a notice names, and every handle before a timeout", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    const work = f.begin([{ runId: "a" }, { runId: "b" }, { runId: "a" }], 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.snapshot.mock.calls.map(([ids]) => ids)).toEqual([["a", "b"]]);
    f.notice("b");
    await vi.advanceTimersByTimeAsync(0);
    f.notice("unrelated");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.snapshot.mock.calls.map(([ids]) => ids)).toEqual([["a", "b"], ["b"]]);
    f.noticeAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.snapshot.mock.calls.at(-1)![0]).toEqual(["a", "b"]);
    f.notice("a");
    await vi.advanceTimersByTimeAsync(0);
    const beforeDeadline = f.snapshot.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(await work).toMatchObject({ wakeReason: "timeout", attention: [] });
    // The answer after the deadline rests on a full pass.
    expect(f.snapshot.mock.calls.length).toBe(beforeDeadline + 1);
    expect(f.snapshot.mock.calls.at(-1)![0]).toEqual(["a", "b"]);
    clean(f);
  });

  it("answers after the deadline only from a full pass, even when the deadline fires during a dirty pass", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    const reads = () => f.snapshot.mock.calls.map(([ids]) => ids);
    const work = f.begin([{ runId: "a" }, { runId: "b" }], 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toEqual([["a", "b"]]);
    const release = deferred();
    f.snapshot.mockImplementationOnce(async (ids, signal) => {
      await release.promise;
      return f.read(ids, signal);
    });
    f.notice("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toEqual([["a", "b"], ["a"]]);
    await vi.advanceTimersByTimeAsync(200); // The deadline passes while the dirty pass reads.
    release.resolve();
    expect(await work).toMatchObject({ wakeReason: "timeout", attention: [] });
    expect(reads()).toEqual([["a", "b"], ["a"], ["a", "b"]]);
    clean(f);
  });

  it("gives abort precedence over attention and publishes nothing from the aborted pass", async () => {
    const f = fixture();
    f.seed("a", "succeeded");
    const [done] = await f.read(["a"]);
    const abort = controller();
    f.snapshot.mockImplementationOnce(async () => {
      abort.abort();
      return [done!, unknown("not_observed")];
    });
    expect(await f.begin([{ runId: "a" }, { runId: "b" }], 1000, abort.signal)).toEqual({
      wakeReason: "aborted",
      attention: [],
      summaries: [unknown("not_observed"), unknown("not_observed")],
    });
    clean(f, abort.signal);
  });

  it("treats a read that rejects because the caller aborted as the abort, and keeps other read failures", async () => {
    const f = fixture();
    const abort = controller();
    f.snapshot.mockImplementationOnce(
      (_ids, signal) =>
        new Promise<never>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        ),
    );
    const work = f.begin([{ runId: "a" }], 1000, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect(await work).toMatchObject({ wakeReason: "aborted", attention: [] });
    clean(f, abort.signal);
    const failure = new Error("fixture read failed");
    f.snapshot.mockRejectedValueOnce(failure);
    await expect(f.begin([{ runId: "a" }], 1000)).rejects.toBe(failure);
    clean(f);
  });

  it("an already aborted wait does no discovery or subscription", async () => {
    const f = fixture();
    const abort = controller();
    abort.abort();
    expect(await f.begin([{ runId: "a" }], 1000, abort.signal)).toEqual({
      wakeReason: "aborted",
      attention: [],
      summaries: [unknown("not_observed")],
    });
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.subscribe).not.toHaveBeenCalled();
    clean(f, abort.signal);
  });

  it("retains the 1000-row production result bound and every attention index", async () => {
    const f = fixture();
    const targets = Array.from({ length: 1000 }, (_, i) => {
      f.seed(`job-${i}`, "interrupted");
      return { runId: `job-${i}` };
    });
    const result = RunWaitManyResult.parse(await f.begin(targets, 0));
    expect(result.wakeReason).toBe("attention");
    expect(result.attention).toEqual(targets.map((_, i) => i));
    expect(result.summaries).toHaveLength(1000);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(113_944);
    clean(f);
  });
});
