import type { IncomingMessage, ServerResponse } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ControlJournalEvent, type ControlJournalEvent as JournalEvent } from "@claudexor/schema";
import { requestGone } from "./request-liveness.js";
import { sseDataLine } from "./sse-shared.js";

/** Opaque positions from the journal owner; the route never decodes them. */
export interface JournalEventPageRequest {
  after?: string;
  through?: string;
}

interface JournalEventPage {
  events: JournalEvent[];
  position: string;
  through: string;
  more: boolean;
}

export interface JournalEventRouteContext {
  services?: {
    /** One bounded page of retained events (`{ events, position, through, more }`). */
    journalEvents?: (partition: string, request: JournalEventPageRequest) => Promise<unknown>;
  };
  pollMs?: number;
  heartbeatMs?: number;
  sseClients: Set<ServerResponse>;
  json(res: ServerResponse, status: number, body: unknown): void;
  requestError(res: ServerResponse, error: unknown): void;
}

export async function handleJournalEventRoute(
  ctx: JournalEventRouteContext,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method === "GET" && path === "/global/events") {
    await streamPartition(ctx, "global", req, res);
    return true;
  }
  const projectEventsMatch = /^\/projects\/([^/]+)\/events$/.exec(path);
  if (method === "GET" && projectEventsMatch) {
    const projectId = decodeURIComponent(projectEventsMatch[1] as string);
    await streamPartition(ctx, `project:${projectId}`, req, res);
    return true;
  }
  return false;
}

/**
 * Replay then tail one partition. Each walk reads bounded pages through the
 * head its first page captured; the poll starts the next walk. One read is in
 * flight per connection, a full socket is drained before the next frame, and a
 * departed client stops the walk. Cursor refusals arrive before headers;
 * later failures, including a replaced generation, close the stream so the
 * client resumes with its last cursor and receives the refusal.
 */
async function streamPartition(
  ctx: JournalEventRouteContext,
  partition: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const service = ctx.services?.journalEvents;
  if (!service) return ctx.json(res, 501, { error: "durable journal events are unavailable" });
  let closed = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
  };
  req.on("close", () => {
    if (requestGone(req, res)) cleanup();
  });
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  const gone = () => {
    if (closed || res.destroyed || res.writableEnded) cleanup();
    return closed;
  };
  const read = async (request: JournalEventPageRequest) =>
    parsePage(await service(partition, request));
  let first: JournalEventPage;
  try {
    first = await read({ after: lastEventId(req) });
  } catch (error) {
    if (gone()) return;
    return ctx.requestError(res, error);
  }
  if (gone()) return;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ctx.sseClients.add(res);
  let position = first.position;
  const deliver = async (events: readonly JournalEvent[]): Promise<boolean> => {
    for (const event of events) {
      const frame = `id: ${event.cursor}\nevent: ${event.type}\ndata: ${sseDataLine(JSON.stringify(event))}\n\n`;
      if (res.write(frame)) continue;
      if (gone()) return false;
      await drained(res);
      if (gone()) return false;
    }
    return true;
  };
  let walking = true;
  const walk = async (page?: JournalEventPage) => {
    let through: string | undefined;
    try {
      // An ended response (daemon stop) or departed client reads no further page.
      while (!gone()) {
        page ??= await read({ after: position, through });
        if (gone()) return;
        through = page.through;
        if (!(await deliver(page.events))) return;
        position = page.position;
        if (!page.more) return;
        page = undefined;
        // Other requests run between pages of one replay.
        await nextTurn();
      }
    } catch {
      if (!gone()) res.destroy();
    } finally {
      walking = false;
    }
  };
  poll = setInterval(() => {
    if (walking || gone()) return;
    walking = true;
    void walk();
  }, ctx.pollMs ?? 250);
  poll.unref?.();
  heartbeat = setInterval(() => {
    // A ping waits for the drain like any frame.
    if (!gone() && !res.writableNeedDrain) res.write(`: ping ${Date.now()}\n\n`);
  }, ctx.heartbeatMs ?? 15_000);
  heartbeat.unref?.();
  // Not awaited: the handler must not hold server stop on a slow client.
  void walk(first);
}

/** Resolve when the socket accepts more bytes or the response closes. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

function lastEventId(req: IncomingMessage): string | undefined {
  const header = req.headers["last-event-id"];
  if (Array.isArray(header))
    throw Object.assign(new Error("Last-Event-ID may appear once"), { status: 400 });
  if (header === undefined) return undefined;
  if (!header.trim())
    throw Object.assign(new Error("Last-Event-ID must not be empty"), { status: 400 });
  return header.trim();
}

function parsePage(value: unknown): JournalEventPage {
  const page = value as Partial<Record<keyof JournalEventPage, unknown>> | null;
  if (
    !page ||
    !Array.isArray(page.events) ||
    typeof page.position !== "string" ||
    !page.position ||
    typeof page.through !== "string" ||
    !page.through ||
    typeof page.more !== "boolean"
  )
    throw new Error("journal event service returned an invalid page");
  return {
    events: page.events.map((event) => ControlJournalEvent.parse(event)),
    position: page.position,
    through: page.through,
    more: page.more,
  };
}
