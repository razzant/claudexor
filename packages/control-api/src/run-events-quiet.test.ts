import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "@claudexor/event-log";
import type { RunWaitManySummary } from "@claudexor/schema";
import { readEventReplayBatch } from "./event-replay-batch.js";
import type { DaemonRunRecord } from "./run-record.js";
import { streamRunEvents, type StreamEventsCtx } from "./run-events-stream.js";
import type { RunObservationListener } from "./run-wait-many.js";

const POLL_MS = 7;
const dirs: string[] = [];
const logs: EventLog[] = [];
const streams: EventEmitter[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.emit("close");
  for (const log of logs.splice(0)) log.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class Response extends EventEmitter {
  body = "";
  ended = false;
  writableEnded = false;
  writeHead() {}
  write(chunk: string) {
    this.body += chunk;
    return true;
  }
  end() {
    this.ended = true;
    this.writableEnded = true;
    this.emit("close");
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const seqs = (body: string) => [...body.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]));
const observed = (status: string): RunWaitManySummary =>
  ({ status, pending: false, token: "token", problem: null }) as RunWaitManySummary;

/** The stream's poll timer, ticked by hand: every tick is one deterministic wake. */
function manualPollTimer() {
  const polls: Array<() => void> = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== POLL_MS) return real(callback, ms);
    polls.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  return async (count: number) => {
    for (let i = 0; i < count; i++) {
      for (const poll of polls) poll();
      await settle();
    }
  };
}

function fixture(options: { runDir?: boolean; notices?: boolean } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), "claudexor-sse-quiet-"));
  dirs.push(runDir);
  const path = join(runDir, "events.jsonl");
  const record: DaemonRunRecord = {
    id: "job-x",
    runId: "run-x",
    state: options.runDir === false ? "queued" : "running",
    ...(options.runDir === false ? {} : { runDir }),
  };
  const busListeners = new Set<(event: { run_id?: string }) => void>();
  const noticeListeners = new Set<RunObservationListener>();
  const counts = { replays: 0, statuses: 0, observations: 0 };
  let lifecycle = "running";
  const res = new Response();
  const req = new EventEmitter();
  streams.push(res);
  const ctx: StreamEventsCtx = {
    findRun: async () => structuredClone(record),
    json() {},
    readBatch: async (input) => {
      counts.replays += 1;
      return readEventReplayBatch(input);
    },
    opts: {
      daemon: {
        status: async () => {
          counts.statuses += 1;
          return structuredClone(record);
        },
      },
      bus: {
        subscribe(fn) {
          busListeners.add(fn);
          return () => busListeners.delete(fn);
        },
      },
      runObservations: async (ids) => {
        counts.observations += 1;
        return ids.map(() => observed(lifecycle));
      },
      ...(options.notices === false
        ? {}
        : {
            runObservationChanges: (listener: RunObservationListener) => {
              noticeListeners.add(listener);
              return () => noticeListeners.delete(listener);
            },
          }),
      pollMs: POLL_MS,
      heartbeatMs: 100_000,
    },
    sseClients: new Set(),
  };
  /** The run's live writer; its bus publication is the daemon's (claudexord.ts). */
  const writer = () => {
    const log = new EventLog(path, "run-x", "task-x", undefined, undefined, (event) => {
      for (const listener of busListeners) listener(event);
    });
    logs.push(log);
    return log;
  };
  const notice = (ids?: string[]) => {
    for (const listener of noticeListeners) listener(ids ? new Set(ids) : undefined);
  };
  const setLifecycle = (state: string) => {
    lifecycle = state;
    record.state = state;
  };
  const open = (lastEventId = 0) =>
    streamRunEvents(ctx, "job-x", lastEventId, req as never, res as never);
  return { runDir, path, record, ctx, res, counts, writer, notice, setLifecycle, open };
}

describe("quiet run event stream", () => {
  it("enqueues no replay and hydrates no command while the live seq and lifecycle are unchanged", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    const log = f.writer();
    log.emit("run.created");
    await f.open();
    expect(seqs(f.res.body)).toEqual([1]);
    expect(f.counts).toEqual({ replays: 1, statuses: 0, observations: 1 });

    await tick(25);
    expect(f.counts).toEqual({ replays: 1, statuses: 0, observations: 1 });

    // A new event moves the live seq: exactly one replay delivers it.
    log.emit("harness.event", { text: "progress" });
    await settle();
    await tick(10);
    expect(seqs(f.res.body)).toEqual([1, 2]);
    expect(f.counts).toEqual({ replays: 2, statuses: 0, observations: 1 });

    // The terminal disposes the live writer: the file read ends the stream.
    log.emit("run.completed", { lifecycle: "succeeded" });
    await settle();
    await vi.waitFor(() => expect(f.res.ended).toBe(true));
    expect(seqs(f.res.body)).toEqual([1, 2, 3]);
    expect(f.res.body.trimEnd().endsWith("event: end\ndata: {}")).toBe(true);
    expect(f.counts.statuses).toBe(0);
  });

  it("re-reads the lifecycle body-free after a notice and ends a terminal without new output", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    f.writer().emit("run.created");
    await f.open();
    expect(f.counts).toEqual({ replays: 1, statuses: 0, observations: 1 });

    // Another job's commit is not this stream's lifecycle.
    f.notice(["job-other", "run-other"]);
    await settle();
    await tick(5);
    expect(f.counts).toEqual({ replays: 1, statuses: 0, observations: 1 });

    // The job is cancelled while the live writer still holds the log: the state
    // read sees the terminal and one confirming file read ends the stream.
    f.setLifecycle("cancelled");
    f.notice(["job-x"]);
    await vi.waitFor(() => expect(f.res.ended).toBe(true));
    expect(f.res.body).toContain("event: end\n");
    expect(f.counts).toEqual({ replays: 2, statuses: 0, observations: 2 });
  });

  it("keeps reading the lifecycle each pass without notices, still without a replay", async () => {
    const tick = manualPollTimer();
    const f = fixture({ notices: false });
    f.writer().emit("run.created");
    await f.open();
    await tick(6);
    expect(f.counts.replays).toBe(1);
    expect(f.counts.statuses).toBe(0);
    expect(f.counts.observations).toBe(7);

    f.setLifecycle("failed");
    await tick(1);
    expect(f.res.ended).toBe(true);
    expect(f.counts.statuses).toBe(0);
  });

  it("falls back to the addressed status when the observation cannot answer", async () => {
    const f = fixture();
    f.ctx.opts.runObservations = async (ids) =>
      ids.map(
        () =>
          ({
            status: null,
            pending: null,
            token: null,
            problem: "not_found",
          }) as RunWaitManySummary,
      );
    f.writer().emit("run.created");
    f.setLifecycle("succeeded");
    await f.open();
    expect(f.counts.statuses).toBe(1);
    expect(f.res.ended).toBe(true);
  });

  it("binds a queued job's run directory after a notice instead of polling its status", async () => {
    const tick = manualPollTimer();
    const f = fixture({ runDir: false });
    await f.open();
    expect(f.counts).toEqual({ replays: 0, statuses: 1, observations: 0 });
    await tick(20);
    expect(f.counts).toEqual({ replays: 0, statuses: 1, observations: 0 });

    // The run starts: its writer owns the log and the job row gains the dir.
    f.writer().emit("run.created");
    f.record.runDir = f.runDir;
    f.setLifecycle("running");
    f.notice(["job-x", "run-x"]);
    await vi.waitFor(() => expect(seqs(f.res.body)).toEqual([1]));
    await tick(20);
    // The binding status read is the fresh lifecycle; nothing else is read.
    expect(f.counts).toEqual({ replays: 1, statuses: 2, observations: 0 });
  });

  it("reads the lifecycle again when a commit lands during the read", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    const observe = f.ctx.opts.runObservations!;
    let first = true;
    f.ctx.opts.runObservations = async (ids, signal) => {
      if (first) {
        // The job's row commits while this read is in flight.
        first = false;
        f.notice(["run-x"]);
      }
      return observe(ids, signal);
    };
    f.writer().emit("run.created");
    await f.open();
    await tick(3);
    expect(f.counts).toEqual({ replays: 1, statuses: 0, observations: 2 });
  });
  it("resumes from the client's cursor through the live seq without re-reading", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    const log = f.writer();
    log.emit("run.created");
    log.emit("harness.event", { text: "one" });
    log.emit("harness.event", { text: "two" });
    await f.open(2);
    expect(seqs(f.res.body)).toEqual([3]);
    const caughtUp = f.counts.replays;
    await tick(10);
    expect(f.counts.replays).toBe(caughtUp);

    log.emit("harness.event", { text: "three" });
    await settle();
    await tick(5);
    expect(seqs(f.res.body)).toEqual([3, 4]);
    expect(f.counts.replays).toBe(caughtUp + 1);
    expect(f.counts.statuses).toBe(0);
  });

  it("asks for the lifecycle again when no source answered the notice's read", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    f.writer().emit("run.created");
    await f.open();
    const observe = f.ctx.opts.runObservations!;
    const status = f.ctx.opts.daemon.status;
    let failing = true;
    f.ctx.opts.runObservations = async (ids, signal) => {
      if (failing) throw new Error("observation unavailable");
      return observe(ids, signal);
    };
    f.ctx.opts.daemon.status = async (id) => {
      if (!failing) return status(id);
      failing = false;
      throw new Error("status unavailable");
    };
    // Cancelled with no new output; both reads at its notice fail once.
    f.setLifecycle("cancelled");
    f.notice(["job-x"]);
    await settle();
    expect(f.res.ended).toBe(false);
    await tick(1);
    expect(f.res.ended).toBe(true);
    expect(f.res.body).toContain("event: end\n");
  });

  it("reads a missing log only on change and ends its terminal job with the retryable error", async () => {
    const tick = manualPollTimer();
    const f = fixture();
    await f.open();
    expect(f.counts.replays).toBe(1);
    await tick(20);
    expect(f.counts.replays).toBe(1);
    expect(f.res.ended).toBe(false);

    f.setLifecycle("cancelled");
    f.notice(["job-x"]);
    await vi.waitFor(() => expect(f.res.ended).toBe(true));
    expect(f.res.body).toContain("event: error\n");
    expect(f.res.body).toContain('"code":"run_event_not_found"');
    expect(f.res.body).toContain('"retryable":true');
    expect(f.res.body).not.toContain("event: end\n");
  });

  it("names retention when a reclaimed run's stream cannot deliver its terminal", async () => {
    const f = fixture();
    writeFileSync(
      join(f.runDir, "tombstone.yaml"),
      "run_id: run-x\ndeleted_at: 2026-11-01T00:00:00.000Z\nreason: retention\n",
    );
    f.setLifecycle("succeeded");
    await f.open();
    expect(f.res.ended).toBe(true);
    expect(f.res.body).toContain('"code":"run_expired_by_retention"');
    expect(f.res.body).not.toContain("event: end\n");
  });
});
