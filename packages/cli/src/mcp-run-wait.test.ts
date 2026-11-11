import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpRunWaitResult } from "@claudexor/schema";
import { runWaitQuery } from "./mcp-run-wait.js";
import { connectDaemonIfRunning } from "./daemon-run.js";
import { controlApiFetch } from "./live.js";
import { mcpSurfaceRunner } from "./mcp-runner.js";

vi.mock("./daemon-run.js", () => ({ connectDaemonIfRunning: vi.fn() }));
vi.mock("./live.js", () => ({ controlApiFetch: vi.fn() }));

const interaction = {
  interactionId: "question-1",
  runId: "run-1",
  requestedAt: "2026-10-19",
  questions: [],
  timeoutAt: null,
};
const snapshot = (
  state = "running",
  lastSeq = 10,
  pendingInteractions: unknown[] = [],
  runId = "run-1",
) => ({
  summary: { jobId: "job-1", runId, state },
  lastSeq,
  pendingInteractions,
});
const event = (seq: number, text = "hello", type = "harness.event") => ({
  seq,
  ts: "2026-10-19",
  run_id: "run-1",
  task_id: "task-1",
  type,
  payload: { text },
});
const frame = (seq: number, text?: string, type = "harness.event") =>
  `id: ${seq}\r\nevent: ${type}\r\ndata: ${JSON.stringify(event(seq, text, type))}\r\n\r\n`;
const question = (seq: number) => frame(seq, "asked", "interaction.requested");

/** A chunk enqueued at once, or after a delay to model a live tail. */
type Chunk = string | { afterMs: number; text: string };

function fixture(chunks: Chunk[], before = snapshot(), after = before, close = false) {
  const cancelled = vi.fn();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (typeof chunk === "string") controller.enqueue(new TextEncoder().encode(chunk));
        else
          timers.push(
            setTimeout(() => {
              try {
                controller.enqueue(new TextEncoder().encode(chunk.text));
              } catch {
                // The observation already closed this stream.
              }
            }, chunk.afterMs),
          );
      }
      if (close) controller.close();
    },
    cancel: () => {
      for (const timer of timers) clearTimeout(timer);
      cancelled();
    },
  });
  let snapshots = 0;
  vi.mocked(controlApiFetch).mockImplementation(async (_addr, path, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    if (path.endsWith("/events"))
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    return Response.json(snapshots++ === 0 ? before : after);
  });
  return { cancelled, stream };
}

describe("bounded durable run observation", () => {
  beforeEach(() => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue({
      addr: { baseUrl: "http://local", token: "test" },
    } as never);
  });
  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it("replays sparse ids from Last-Event-ID across chunked CRLF frames", async () => {
    const bytes = frame(10) + frame(17) + frame(30);
    const { cancelled } = fixture(
      [bytes.slice(0, 27), bytes.slice(27, -2), bytes.slice(-2)],
      snapshot("running", 10, [], "run/1"),
    );
    const result = await runWaitQuery({ runId: "run/1", afterSeq: 10, wake: "event" });
    expect(result).toMatchObject({ nextSeq: 17, wakeReason: "events", status: "running" });
    // Event mode returns available events; the incomplete next frame is replayed on resume.
    expect(result.events.map((e) => e.seq)).toEqual([17]);
    expect(McpRunWaitResult.safeParse(result).success).toBe(true);
    expect(controlApiFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/runs/run%2F1/events",
      expect.objectContaining({ headers: expect.objectContaining({ "Last-Event-ID": "10" }) }),
    );
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("reports an already pending question at once on a zero wait", async () => {
    fixture([], snapshot("running", 12, [interaction]));
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 100, waitMs: 0 });
    expect(result).toMatchObject({
      wakeReason: "timeout",
      nextSeq: 100,
      pendingInteractionCount: 1,
      pendingInteractions: [expect.objectContaining({ interactionId: "question-1" })],
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["batch", "event"] as const)(
    "never ends a %s wait early just because a question is already pending",
    async (wake) => {
      fixture([": connected\n\n"], snapshot("running", 12, [interaction]));
      const started = Date.now();
      const result = await runWaitQuery({ runId: "run-1", afterSeq: 12, waitMs: 80, wake });
      expect(Date.now() - started).toBeGreaterThanOrEqual(70);
      expect(result).toMatchObject({
        wakeReason: "timeout",
        nextSeq: 12,
        events: [],
        pendingInteractionCount: 1,
        snapshotPhase: "after_wait",
      });
    },
  );

  it("never hides the backlog written before a pending question", async () => {
    const backlog = [1, 2, 3, 4, 5].map((seq) => frame(seq)).join("") + question(6);
    for (const waitMs of [25_000, 0]) {
      fixture([backlog], snapshot("running", 6, [interaction]));
      const result = await runWaitQuery({ runId: "run-1", afterSeq: 0, waitMs });
      expect(result.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result).toMatchObject({
        nextSeq: 6,
        wakeReason: "interactions",
        pendingInteractionCount: 1,
        eventOmission: null,
        snapshotPhase: waitMs ? "after_wait" : "before_wait",
      });
      vi.mocked(controlApiFetch).mockReset();
    }
  });

  it("ends a batch wait early when a question is requested while waiting", async () => {
    fixture(
      [": connected\n\n", { afterMs: 30, text: frame(11) }, { afterMs: 90, text: question(12) }],
      snapshot(),
      snapshot("running", 12, [interaction]),
    );
    const started = Date.now();
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, waitMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.events.map((e) => e.seq)).toEqual([11, 12]);
    expect(result).toMatchObject({ wakeReason: "interactions", pendingInteractionCount: 1 });
  });

  it("coalesces separate live chunks into one batch until waitMs", async () => {
    fixture([
      ": connected\n\n",
      { afterMs: 10, text: frame(11) },
      { afterMs: 40, text: frame(12) },
      { afterMs: 70, text: frame(13) },
    ]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, waitMs: 300 });
    expect(result.events.map((e) => e.seq)).toEqual([11, 12, 13]);
    expect(result).toMatchObject({ nextSeq: 13, wakeReason: "timeout", eventOmission: null });
  });

  it("returns a batch as soon as the page fills", async () => {
    fixture([
      ": connected\n\n",
      { afterMs: 10, text: frame(11) },
      { afterMs: 30, text: frame(12) },
    ]);
    const started = Date.now();
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, maxEvents: 2 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({
      nextSeq: 12,
      eventOmission: "event_limit",
      wakeReason: "events",
    });
  });

  it("returns the first available live events in event mode", async () => {
    fixture([
      ": connected\n\n",
      { afterMs: 20, text: frame(11) },
      { afterMs: 400, text: frame(12) },
    ]);
    const result = await runWaitQuery({
      runId: "run-1",
      afterSeq: 10,
      waitMs: 20_000,
      wake: "event",
    });
    expect(result.events.map((e) => e.seq)).toEqual([11]);
    expect(result).toMatchObject({ nextSeq: 11, wakeReason: "events" });
  });

  it("converges a queued job id on its bound run id and refuses foreign identities", async () => {
    fixture([], snapshot("running", 10));
    expect(await runWaitQuery({ runId: "job-1", afterSeq: 10, waitMs: 0 })).toMatchObject({
      runId: "run-1",
    });
    fixture([], snapshot("queued", 0, [], "job-1"));
    expect(await runWaitQuery({ runId: "job-1", waitMs: 0 })).toMatchObject({
      runId: "job-1",
      status: "queued",
    });
    fixture([], snapshot("running", 10));
    await expect(runWaitQuery({ runId: "run-other", waitMs: 0 })).rejects.toMatchObject({
      code: "invalid_service_response",
    });
  });

  it("treats a terminal status as no end of events: a backlog page keeps its cursor", async () => {
    const backlog = [11, 12, 13, 14, 15, 16].map((seq) => frame(seq)).join("");
    fixture([backlog], snapshot("succeeded", 16));
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, maxEvents: 3 });
    expect(result).toMatchObject({
      wakeReason: "terminal",
      nextSeq: 13,
      snapshotSeq: 16,
      eventOmission: "event_limit",
    });
  });

  it.each(["succeeded", "failed", "cancelled", "interrupted"])(
    "returns %s without requiring a terminal event",
    async (state) => {
      fixture([], snapshot(state));
      expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
        wakeReason: "terminal",
        status: state,
        nextSeq: 10,
        events: [],
      });
      expect(controlApiFetch).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds event count and resumes at the last returned durable id", async () => {
    const { cancelled } = fixture([frame(11) + frame(15) + frame(19)]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10, maxEvents: 2 });
    expect(result).toMatchObject({ nextSeq: 15, eventOmission: "event_limit" });
    expect(result.events.map((e) => e.seq)).toEqual([11, 15]);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds bytes and never advances across an unreturned oversized event", async () => {
    fixture([frame(11) + frame(12, "x".repeat(70_000))]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 10 });
    // An event no page can hold is named for the part reader, after what was returned.
    expect(result).toMatchObject({
      nextSeq: 11,
      eventOmission: "byte_limit",
      oversizedEvent: { seq: 12, type: "harness.event" },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131_072);
  });

  it("discloses a first oversized frame with an unchanged cursor", async () => {
    fixture([frame(11, "x".repeat(200_000))]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      nextSeq: 10,
      events: [],
      eventOmission: "oversized_frame",
      oversizedEvent: { seq: 11, type: "harness.event" },
      wakeReason: "events",
    });
  });

  it.each([
    [70_000, "byte_limit"],
    [200_000, "oversized_frame"],
  ] as const)(
    "wakes with interactions when the next event is a %i-character question no page holds (#651)",
    async (chars, omission) => {
      // Its body is past the pending budget too: claudexor_run_interactions returns it.
      const question = { id: "q1", question: "q".repeat(40_000), options: [], multi_select: false };
      fixture(
        [frame(11) + frame(12, "q".repeat(chars), "interaction.requested")],
        snapshot("running", 12, [{ ...interaction, questions: [question] }]),
      );
      expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
        nextSeq: 11,
        eventOmission: omission,
        oversizedEvent: { seq: 12, type: "interaction.requested" },
        wakeReason: "interactions",
        pendingInteractions: [],
        pendingInteractionCount: 1,
        omittedInteractions: 1,
      });
    },
  );

  it("names a page-sized event without advancing, and keeps a fit event below the cap unnamed", async () => {
    fixture([frame(11, "x".repeat(70_000))]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      nextSeq: 10,
      events: [],
      eventOmission: "byte_limit",
      oversizedEvent: { seq: 11, type: "harness.event" },
    });
    fixture([frame(11, "x".repeat(40_000)) + frame(12, "y".repeat(40_000))]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      nextSeq: 11,
      eventOmission: "byte_limit",
      oversizedEvent: null,
    });
  });

  it("ends a zero-wait page at its fence even before an oversized later frame", async () => {
    fixture([frame(11) + frame(12, "x".repeat(200_000))], snapshot("running", 11));
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10, waitMs: 0 })).toMatchObject({
      nextSeq: 11,
      eventOmission: null,
      oversizedEvent: null,
      wakeReason: "events",
    });
  });

  it("times out a quiet queued SSE read, closes it, and refreshes once", async () => {
    const { cancelled } = fixture([": connected\n\n"], snapshot("queued", 0));
    const result = await runWaitQuery({ runId: "run-1", waitMs: 10 });
    expect(result).toMatchObject({
      wakeReason: "timeout",
      status: "queued",
      nextSeq: 0,
      snapshotPhase: "after_wait",
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes questions and lifecycle on an SSE wake", async () => {
    fixture([frame(11)], snapshot("running", 11), snapshot("running", 12, [interaction]));
    // The page holds no question request: the refreshed pending list is reported, not the cause.
    expect(await runWaitQuery({ runId: "run-1", wake: "event" })).toMatchObject({
      wakeReason: "events",
      pendingInteractionCount: 1,
      snapshotSeq: 12,
    });
  });

  it("observes terminal state on an end frame even when its terminal event is behind the cursor", async () => {
    fixture(["event: end\ndata: {}\n\n"], snapshot(), snapshot("succeeded", 10));
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10 })).toMatchObject({
      wakeReason: "terminal",
      status: "succeeded",
      nextSeq: 10,
    });
  });

  it("names a stream that ended below the fence without serving anything, never advancing", async () => {
    // A crash tore the terminal run's last line: the fence counts it, the stream withholds it.
    const end = "event: end\ndata: {}\n\n";
    fixture([frame(1) + frame(2) + frame(3) + end], snapshot("failed", 4));
    const first = await runWaitQuery({ runId: "run-1", afterSeq: 0 });
    // Events were served, so the next read decides; the stream may end at a terminal event.
    expect(first).toMatchObject({ wakeReason: "terminal", nextSeq: 3, eventOmission: null });
    fixture([end], snapshot("failed", 4));
    const again = await runWaitQuery({ runId: "run-1", afterSeq: 3 });
    expect(again).toMatchObject({
      wakeReason: "terminal",
      snapshotSeq: 4,
      nextSeq: 3,
      events: [],
      eventOmission: "stream_ended",
      oversizedEvent: null,
    });
    expect(McpRunWaitResult.safeParse(again).success).toBe(true);
  });

  it("reports a disconnect honestly without retries or worker control", async () => {
    fixture([": connected\n\n"], snapshot(), snapshot(), true);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "disconnected",
      status: "running",
      nextSeq: 0,
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(3);
  });

  it("honors host abort and closes the reader without cancelling the worker", async () => {
    const host = new AbortController();
    const { cancelled } = fixture([": connected\n\n"]);
    const pending = runWaitQuery({ runId: "run-1" }, false, host.signal);
    await vi.waitFor(() => expect(controlApiFetch).toHaveBeenCalledTimes(2));
    host.abort();
    expect(await pending).toMatchObject({ wakeReason: "aborted", snapshotPhase: "before_wait" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controlApiFetch).toHaveBeenCalledTimes(2);
  });

  it("zero wait with nothing unread is snapshot-only and leaves the cursor untouched", async () => {
    fixture([]);
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 10, waitMs: 0 })).toMatchObject({
      nextSeq: 10,
      snapshotSeq: 10,
      events: [],
      wakeReason: "timeout",
    });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("zero wait returns the already available page up to its fence without waiting", async () => {
    fixture([frame(5) + frame(10) + frame(12)]);
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 3, waitMs: 0 });
    expect(result.events.map((e) => e.seq)).toEqual([5, 10]);
    expect(result).toMatchObject({
      nextSeq: 10,
      snapshotSeq: 10,
      snapshotPhase: "before_wait",
      wakeReason: "events",
    });
    // One snapshot and one replay: no live wait, no second snapshot.
    expect(controlApiFetch).toHaveBeenCalledTimes(2);
  });

  it("discloses omitted interaction bodies and keeps their exact total", async () => {
    const large = { ...interaction, sourceTool: "x".repeat(40_000) };
    fixture([], snapshot("running", 20, [large, interaction]));
    const result = await runWaitQuery({ runId: "run-1", afterSeq: 20, waitMs: 0 });
    expect(result).toMatchObject({
      wakeReason: "timeout",
      pendingInteractionCount: 2,
      omittedInteractions: 2,
      pendingInteractions: [],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131_072);
  });

  it("preserves returned events when the final snapshot fails and labels freshness", async () => {
    fixture([frame(11)]);
    vi.mocked(controlApiFetch)
      .mockImplementationOnce(async () => Response.json(snapshot()))
      .mockImplementationOnce(
        async () => new Response(frame(11), { headers: { "content-type": "text/event-stream" } }),
      )
      .mockImplementationOnce(async () => {
        throw new Error("lost");
      });
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      nextSeq: 11,
      snapshotPhase: "before_wait",
      snapshotProblem: "snapshot_unavailable",
    });
  });

  it.each([
    {},
    { runId: " " },
    { runId: "r", afterSeq: -1 },
    { runId: "r", waitMs: 50001 },
    { runId: "r", maxEvents: 0 },
    { runId: "r", afterSeq: Number.MAX_SAFE_INTEGER + 1 },
    { runId: "r", waitMs: 1.2 },
    { runId: "r", extra: true },
    { runId: "r", wake: "first" },
  ])("rejects malformed input before connection: %j", async (input) => {
    await expect(runWaitQuery(input)).rejects.toBeDefined();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("keeps the privileged belt closed before connection", async () => {
    await expect(runWaitQuery({ runId: "r" }, true)).rejects.toMatchObject({
      code: "delegation_forbidden",
    });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("does not start a missing daemon", async () => {
    vi.mocked(connectDaemonIfRunning).mockResolvedValue(null);
    await expect(runWaitQuery({ runId: "r" })).rejects.toMatchObject({
      code: "daemon_unavailable",
    });
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("preserves a missing-run refusal", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ code: "not_found", message: "no such run" }, { status: 404 }),
    );
    await expect(runWaitQuery({ runId: "r" })).rejects.toMatchObject({ code: "not_found" });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("replays unread events of an already terminal run", async () => {
    fixture([frame(7) + frame(10)], snapshot("succeeded", 10));
    expect(await runWaitQuery({ runId: "run-1", afterSeq: 5 })).toMatchObject({
      wakeReason: "terminal",
      nextSeq: 10,
      events: [{ seq: 7 }, { seq: 10 }],
    });
  });

  it("resumes a bounded prefix without skipping the unreturned tail", async () => {
    fixture([frame(7) + frame(10) + frame(20)]);
    const first = await runWaitQuery({ runId: "run-1", maxEvents: 1 });
    fixture([frame(10) + frame(20)]);
    const resumed = await runWaitQuery({ runId: "run-1", afterSeq: first.nextSeq });
    expect([...first.events, ...resumed.events].map((e) => e.seq)).toEqual([7, 10, 20]);
    expect(resumed.nextSeq).toBe(20);
  });

  it.each([
    "id: 11\ndata: nope\n\n",
    `id: 11\ndata: ${JSON.stringify(event(12))}\n\n`,
    `id: 9007199254740992\ndata: ${JSON.stringify(event(11))}\n\n`,
    "data: {}\n\n",
  ])("does not advance across a malformed frame: %s", async (bad) => {
    const { cancelled } = fixture([frame(7) + bad + frame(20)]);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "events",
      nextSeq: 7,
      eventOmission: "invalid_event",
      events: [{ seq: 7 }],
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("counts UTF-8 bytes rather than characters", async () => {
    fixture([frame(7, "😀".repeat(17_000))]);
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      nextSeq: 0,
      events: [],
      eventOmission: "byte_limit",
      oversizedEvent: { seq: 7, type: "harness.event" },
    });
  });

  it("does not invent an empty interaction list from malformed snapshots", async () => {
    vi.mocked(controlApiFetch).mockResolvedValue(
      Response.json({ summary: { state: "running" }, lastSeq: 0 }),
    );
    await expect(runWaitQuery({ runId: "run-1" })).rejects.toBeDefined();
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("handles a stream read error with a native error code as a disconnect", async () => {
    let snapshots = 0;
    vi.mocked(controlApiFetch).mockImplementation(async (_addr, path) => {
      if (!path.endsWith("/events")) return Response.json(snapshot("running", snapshots++));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(await runWaitQuery({ runId: "run-1" })).toMatchObject({
      wakeReason: "disconnected",
      nextSeq: 0,
    });
  });

  it("removes host listeners on every completed read", async () => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    fixture([frame(11)]);
    await runWaitQuery({ runId: "run-1" }, false, signal);
    expect(add.mock.calls.length).toBeGreaterThan(0);
    for (const [name, listener] of add.mock.calls) {
      expect(remove).toHaveBeenCalledWith(name, listener);
    }
  });

  it("dispatches the public observation with its host signal and never reaches cancel bridging", async () => {
    fixture([]);
    const signal = new AbortController().signal;
    expect(
      await mcpSurfaceRunner()(
        { mode: "__run_wait", runId: "run-1", afterSeq: 10, waitMs: 0 },
        { signal },
      ),
    ).toMatchObject({ wakeReason: "timeout", status: "running" });
    expect(controlApiFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks raw wait mode on a lineage-bound runner", async () => {
    await expect(
      mcpSurfaceRunner({ delegationParentRunId: "parent" })({ mode: "__run_wait", runId: "run-1" }),
    ).rejects.toMatchObject({ code: "delegation_forbidden" });
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("rejects an already aborted host before discovery", async () => {
    const host = new AbortController();
    host.abort();
    await expect(runWaitQuery({ runId: "run-1" }, false, host.signal)).rejects.toBeDefined();
    expect(connectDaemonIfRunning).not.toHaveBeenCalled();
  });

  it("honors host abort while discovery is still pending", async () => {
    const host = new AbortController();
    vi.mocked(connectDaemonIfRunning).mockReturnValue(new Promise(() => {}));
    const pending = runWaitQuery({ runId: "run-1" }, false, host.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    host.abort();
    await rejected;
    expect(controlApiFetch).not.toHaveBeenCalled();
  });

  it("bounds stalled discovery separately from SSE waiting", async () => {
    vi.useFakeTimers();
    vi.mocked(connectDaemonIfRunning).mockReturnValue(new Promise(() => {}));
    const pending = runWaitQuery({ runId: "run-1" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "run_observation_timeout" });
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(controlApiFetch).not.toHaveBeenCalled();
  });
});
