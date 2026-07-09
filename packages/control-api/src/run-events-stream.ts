import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { DaemonRunRecord } from "./daemon-server.js";
import { TERMINAL_STATES, readNewLines, redactedSseLine } from "./sse-shared.js";

export interface StreamEventsCtx {
findRun(id: string): Promise<DaemonRunRecord | null | undefined>;
json(res: ServerResponse, status: number, value: unknown): void;
opts: { daemon: { status(id: string): Promise<DaemonRunRecord> }; bus?: { subscribe(fn: (event: { run_id?: string }) => void): () => void } | undefined; pollMs?: number; heartbeatMs?: number };
sseClients: Set<ServerResponse>;
}

/**
 * GET /runs/:id/events — replay + live tail of the run's events.jsonl as SSE
 * (snapshot-then-subscribe with durable seq cursors, drain-await
 * backpressure, and a single re-entrancy flag across the queued-phase
 * status await). Extracted from DaemonControlApiServer verbatim; the ctx
 * object carries the four server facilities the stream needs.
 */
export async function streamRunEvents(ctx: StreamEventsCtx, id: string, lastEventId: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rec = await ctx.findRun(id);
  if (!rec) return ctx.json(res, 404, { error: "no such run" });
  // A QUEUED job has no runDir yet — that is a wait, not a 404:
  // the stream opens with heartbeats and binds the events file once the
  // run starts, so `follow <jobId>` works from enqueue time. 404 stays for
  // truly unknown ids only.
  let eventsPath = rec.runDir ? join(rec.runDir, "events.jsonl") : null;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ctx.sseClients.add(res);

  let lineNo = 0;
  let offset = 0;
  let carry = "";
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    unsubscribe?.();
    ctx.sseClients.delete(res);
  };
  // Heartbeat: a quiet harness phase (long tool call, slow model) must not be
  // indistinguishable from a dead connection — clients and proxies need bytes.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, ctx.opts.heartbeatMs ?? 15_000);
  heartbeat.unref?.();
  let draining = false;
  const writeAvailable = async () => {
    if (closed || draining) return;
    // The re-entrancy guard must cover the QUEUED-phase status await too:
    // with drain-await backpressure in the replay loop, two triggers (poll
    // timer + bus push) passing this point concurrently could interleave
    // out-of-order seq writes. One flag spans the whole invocation.
    draining = true;
    if (!eventsPath) {
      // Still queued: poll the job until the run binds its dir (then tail
      // it) or the job goes terminal without one (validation failure — a
      // run that never materialized ends the stream honestly).
      const latest = await ctx.opts.daemon.status(rec.id).catch(() => rec);
      if (latest.runDir) {
        eventsPath = join(latest.runDir, "events.jsonl");
      } else if (TERMINAL_STATES.has(latest.state)) {
        res.write("event: end\ndata: {}\n\n");
        res.end();
        cleanup();
        return;
      } else {
        draining = false;
        return;
      }
    }
    if (!existsSync(eventsPath)) {
      draining = false;
      return;
    }
    try {
      const { lines, nextOffset, rest } = readNewLines(eventsPath, offset, carry);
      offset = nextOffset;
      carry = rest;
      for (const raw of lines) {
        lineNo += 1;
        // Durable cursor: the event's own persisted seq. Legacy lines without
        // one fall back to their line number (matching EventLog's counter
        // init), so resume ids stay consistent either way.
        let seq = lineNo;
        let type = "run";
        try {
          const parsed = JSON.parse(raw) as { type?: string; seq?: number };
          type = String(parsed.type ?? "run");
          if (typeof parsed.seq === "number" && Number.isFinite(parsed.seq)) seq = parsed.seq;
        } catch {
          type = "malformed";
        }
        if (seq <= lastEventId) continue;
        // Backpressure: a large replay into a slow client must not balloon
        // the socket buffer — pause the tail until the kernel drains it
        // (or the client goes away, which resolves via `close`).
        if (!res.write(`id: ${seq}\nevent: ${type}\ndata: ${redactedSseLine(raw)}\n\n`)) {
          await new Promise<void>((resolve) => {
            const done = (): void => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
          if (closed) return;
        }
        if (type === "run.completed" || type === "run.failed" || type === "run.blocked") {
          res.write("event: end\ndata: {}\n\n");
          res.end();
          cleanup();
          return;
        }
      }
      const latest = await ctx.opts.daemon.status(rec.id).catch(() => rec);
      if (TERMINAL_STATES.has(latest.state)) {
        res.write("event: end\ndata: {}\n\n");
        res.end();
        cleanup();
      }
    } finally {
      draining = false;
    }
  };
  // Push: a bus event for this run pokes the tailer immediately; the file
  // remains the single ordered source so push and poll can never disagree.
  unsubscribe = ctx.opts.bus?.subscribe((event) => {
    if (!closed && event.run_id === (rec.runId ?? rec.id)) void writeAvailable();
  });
  const timer = setInterval(() => void writeAvailable(), ctx.opts.pollMs ?? 250);
  timer.unref?.();
  req.on("close", cleanup);
  res.on("close", cleanup);
  await writeAvailable();
}
