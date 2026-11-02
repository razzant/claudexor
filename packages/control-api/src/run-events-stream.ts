import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { liveRunEventSeq } from "@claudexor/event-log";
import type { DaemonRunRecord } from "./run-record.js";
import { TERMINAL_STATES } from "./sse-shared.js";
import type {
  EventReplayCursor,
  EventReplayRequest,
  EventReplayResult,
} from "./event-replay-batch.js";
import { thrownProblemCode } from "./problem-response.js";
import { requestGone } from "./request-liveness.js";
import { readRunTombstone } from "./run-tombstone.js";
import type { RunWaitManyHost } from "./run-wait-many.js";

export interface StreamEventsCtx {
  findRun(id: string): Promise<DaemonRunRecord | null | undefined>;
  json(res: ServerResponse, status: number, value: unknown): void;
  readBatch(request: EventReplayRequest, signal: AbortSignal): Promise<EventReplayResult>;
  opts: {
    daemon: { status(id: string): Promise<DaemonRunRecord> };
    bus?: { subscribe(fn: (event: { run_id?: string }) => void): () => void } | undefined;
    /** Body-free lifecycle reads (the wait-many observation): state, never the command body. */
    runObservations?: RunWaitManyHost["snapshot"];
    /** Post-commit notices naming changed job/run ids: the lifecycle wake-up. */
    runObservationChanges?: RunWaitManyHost["subscribe"];
    pollMs?: number;
    heartbeatMs?: number;
    /** SQL composition supplies the existing terminal-files obligation fact. */
    terminalFilesPending?: (runIdOrCommandId: string) => boolean;
  };
  sseClients: Set<ServerResponse>;
}

/**
 * GET /runs/:id/events — replay + live tail of the run's events.jsonl as SSE
 * (snapshot-then-subscribe with durable seq cursors, drain-await
 * backpressure, and a single re-entrancy flag across the queued-phase
 * status await). Live stream ownership stays here; finite file/read/redact
 * batches run on the server's shared bulk executor.
 *
 * A quiet tail costs no I/O: a batch is read only while the live writer's
 * in-memory seq is ahead of what this client holds (or no live writer owns the
 * log, or a terminal is in view), and the lifecycle is re-read only after a
 * post-commit notice for this run, body-free. Bus pushes and notices wake the
 * tailer; the poll timer is the backstop and the heartbeat detects dead peers.
 */
export async function streamRunEvents(
  ctx: StreamEventsCtx,
  id: string,
  lastEventId: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rec = await ctx.findRun(id);
  if (!rec) return ctx.json(res, 404, { error: "no such run" });
  // A QUEUED job has no runDir yet — that is a wait, not a 404:
  // the stream opens with heartbeats and binds the events file once the
  // run starts, so `follow <jobId>` works from enqueue time. 404 stays for
  // truly unknown ids only.
  let eventsPath = rec.runDir ? join(rec.runDir, "events.jsonl") : null;
  // A queued job learns its run id when the run binds its dir.
  let runId = rec.runId;
  let cursor: EventReplayCursor | undefined;
  let closed = false;
  let terminalSeen = false;
  // A bound run's log exists from `run.created` on: one found missing was
  // removed (retention, or by hand). It is read again only after a change: its
  // live writer moved past the seq it held at the miss, or a bus push or notice
  // for this run arrived.
  let logMissing = false;
  let missedAt = 0;
  // The highest seq this client holds: its resume cursor, then every frame sent.
  let sent = lastEventId;
  const lifetime = new AbortController();
  const pendingTerminalFiles = () => ctx.opts.terminalFilesPending?.(rec.runId ?? rec.id) === true;
  let unsubscribe: (() => void) | undefined;
  let unobserve: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    clearInterval(timer);
    clearInterval(heartbeat);
    unsubscribe?.();
    unobserve?.();
    ctx.sseClients.delete(res);
  };
  req.on("close", () => {
    if (requestGone(req, res)) cleanup();
  });
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  const readBatch = () =>
    ctx.readBatch({ path: eventsPath!, lastEventId, cursor }, lifetime.signal);
  // A first-job failure can still return the executor's typed HTTP problem.
  let nextBatch = eventsPath ? await readBatch() : undefined;
  if (closed || res.writableEnded || res.destroyed) return cleanup();
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ctx.sseClients.add(res);
  // Heartbeat: a quiet harness phase (long tool call, slow model) must not be
  // indistinguishable from a dead connection — clients and proxies need bytes.
  heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, ctx.opts.heartbeatMs ?? 15_000);
  heartbeat.unref?.();
  let draining = false;
  // Lost-wakeup latch (QA-018 / backlog C2): a bus push or poll tick that
  // arrives while a drain pass already holds `draining` must not be dropped as
  // a no-op — it records a pending re-check the drain loop honors before it
  // concludes. The durable file stays the single ordered source; this bit only
  // guarantees the tailer looks again.
  let pending = false;
  // The lifecycle (job state) is re-read only when it may have changed: before
  // the first look, after a notice for this run, on every pass for a host
  // without notices, and while a terminal waits for its files (that clearing
  // publishes no notice). A read claims the notices before it awaits.
  const notices = ctx.opts.runObservationChanges;
  let lifecycleDirty = true;
  const claimLifecycle = () => {
    lifecycleDirty = !notices;
  };
  // The job state, or null when no source answered (the next pass asks again);
  // a terminal state seen at open stays an answer, because it is final.
  const readLifecycle = async (): Promise<string | null> => {
    if (ctx.opts.runObservations) {
      try {
        const [row] = await ctx.opts.runObservations([rec.id], lifetime.signal);
        if (row && row.problem === null) return row.status;
      } catch {
        // No body-free answer: the addressed status below decides.
      }
      if (closed) return null;
    }
    try {
      return (await ctx.opts.daemon.status(rec.id)).state;
    } catch {
      return TERMINAL_STATES.has(rec.state) ? rec.state : null;
    }
  };
  // A terminal whose log is gone cannot be delivered: say why, retryably.
  const unreadableLog = () =>
    Object.assign(new Error("run event log is not available"), {
      code: readRunTombstone(dirname(eventsPath!))
        ? "run_expired_by_retention"
        : "run_event_not_found",
    });
  const writeAvailable = async () => {
    if (closed) return;
    if (draining) {
      pending = true;
      return;
    }
    // The re-entrancy guard must cover the QUEUED-phase status await too:
    // with drain-await backpressure in the replay loop, two triggers (poll
    // timer + bus push) passing this point concurrently could interleave
    // out-of-order seq writes. One flag spans the whole invocation.
    draining = true;
    try {
      // Drain-until-stable: re-read the file after every productive pass and
      // after any pending wakeup, so a terminal tail appended between a read and
      // the status probe is never left undelivered.
      for (;;) {
        pending = false;
        if (!eventsPath) {
          // Still queued: re-read the job when it may have changed until the
          // run binds its dir (then tail it) or the job goes terminal without
          // one (validation failure — a run that never materialized ends the
          // stream honestly).
          if (!lifecycleDirty) return;
          claimLifecycle();
          let latest = rec;
          try {
            latest = await ctx.opts.daemon.status(rec.id);
          } catch {
            lifecycleDirty = true;
          }
          if (closed || res.writableEnded || res.destroyed) return cleanup();
          if (TERMINAL_STATES.has(latest.state)) lifecycleDirty = true;
          runId ??= latest.runId;
          if (latest.runDir) {
            eventsPath = join(latest.runDir, "events.jsonl");
          } else if (TERMINAL_STATES.has(latest.state) && !pendingTerminalFiles()) {
            res.write("event: end\ndata: {}\n\n");
            res.end();
            cleanup();
            return;
          } else {
            if (pending) continue;
            return;
          }
        }
        // The live writer's in-memory seq (no I/O) says whether the file holds
        // anything past what this client already has. A batch already read, a
        // terminal in view, or a present log without a live writer reads the file.
        const live = liveRunEventSeq(eventsPath);
        const due = logMissing ? live !== null && live > missedAt : live === null || live > sent;
        let batch: EventReplayResult | undefined;
        if (nextBatch !== undefined || terminalSeen || due) {
          batch = nextBatch ?? (await readBatch());
          nextBatch = undefined;
          if (closed || res.writableEnded || res.destroyed) return cleanup();
          logMissing = batch.missing === true;
          if (logMissing) missedAt = live ?? 0;
        }
        if (batch && !logMissing) {
          cursor = batch.cursor;
          terminalSeen ||= batch.terminalSeen;
          for (const { seq, type, data, terminal } of batch.frames) {
            // Backpressure: a large replay into a slow client must not balloon
            // the socket buffer — pause the tail until the kernel drains it
            // (or the client goes away, which resolves via `close`).
            const flushed = res.write(`id: ${seq}\nevent: ${type}\ndata: ${data}\n\n`);
            sent = Math.max(sent, seq);
            if (!flushed) {
              await new Promise<void>((resolve) => {
                const done = (): void => {
                  res.off("drain", done);
                  res.off("close", done);
                  resolve();
                };
                res.once("drain", done);
                res.once("close", done);
              });
              if (closed || res.writableEnded || res.destroyed) return cleanup();
            }
            if (terminal && !pendingTerminalFiles()) {
              res.write("event: end\ndata: {}\n\n");
              res.end();
              cleanup();
              return;
            }
          }
          // A productive pass may have surfaced only a PREFIX of the tail: loop to
          // re-read from the advanced cursor before deciding anything.
          if (batch.progressed) continue;
        }
        if (!lifecycleDirty && !terminalSeen) {
          if (pending) continue;
          return;
        }
        claimLifecycle();
        const state = await readLifecycle();
        if (closed || res.writableEnded || res.destroyed) return cleanup();
        if (state === null) lifecycleDirty = true;
        if (terminalSeen || (state !== null && TERMINAL_STATES.has(state))) {
          lifecycleDirty = true;
          if (!pendingTerminalFiles()) {
            // A materialized run commits SQL terminal state with a file-publication
            // obligation. Its cleared obligation proves the canonical terminal is
            // readable after publication. Re-check the file
            // cursor: only conclude `end` when the file yields nothing new AND a
            // wakeup is not already pending — otherwise loop and deliver the tail,
            // whose canonical terminal ends the stream through the branch above.
            nextBatch = await readBatch();
            if (closed || res.writableEnded || res.destroyed) return cleanup();
            if (nextBatch.progressed || nextBatch.frames.length > 0 || pending) continue;
            if (nextBatch.missing) throw unreadableLog();
            res.write("event: end\ndata: {}\n\n");
            res.end();
            cleanup();
            return;
          }
        }
        if (pending) continue;
        return;
      }
    } catch (error) {
      if (!closed && !res.writableEnded && !res.destroyed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            code: thrownProblemCode(error),
            message: "Run event stream could not be read.",
            retryable: true,
            fieldErrors: [],
            requiredActions: ["reconnect"],
            evidenceRefs: [],
            context: {},
          })}\n\n`,
        );
        res.end();
      }
      cleanup();
    } finally {
      draining = false;
    }
  };
  // Push: a bus event for this run pokes the tailer immediately (and lets it
  // look for a missing log again); the file remains the single ordered source
  // so push and poll can never disagree.
  unsubscribe = ctx.opts.bus?.subscribe((event) => {
    if (closed || event.run_id !== (runId ?? rec.id)) return;
    logMissing = false;
    void writeAvailable();
  });
  // A committed change of this job's rows marks its lifecycle, and a missing
  // log, for one re-read.
  // The wake leaves the committing mutation's notification first.
  unobserve = notices?.((changed) => {
    if (closed) return;
    if (changed && !changed.has(rec.id) && !(runId && changed.has(runId))) return;
    lifecycleDirty = true;
    logMissing = false;
    queueMicrotask(() => void writeAvailable());
  });
  timer = setInterval(() => void writeAvailable(), ctx.opts.pollMs ?? 250);
  timer.unref?.();
  await writeAvailable();
}
