import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlJournalEvent, type ControlJournalEvent as JournalEvent } from "@claudexor/schema";
import { redactedSseLine } from "./sse-shared.js";

export interface JournalEventRouteContext {
  services?: {
    journalEvents?: (partition: string, afterCursor?: string) => Promise<unknown>;
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

async function streamPartition(
  ctx: JournalEventRouteContext,
  partition: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const service = ctx.services?.journalEvents;
  if (!service) return ctx.json(res, 501, { error: "durable journal events are unavailable" });
  let cursor: string | undefined;
  let initial: JournalEvent[];
  try {
    cursor = lastEventId(req);
    initial = parseEvents(await service(partition, cursor));
  } catch (error) {
    return ctx.requestError(res, error);
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  ctx.sseClients.add(res);
  let closed = false;
  let reading = false;
  const write = (events: JournalEvent[]) => {
    for (const event of events) {
      cursor = event.cursor;
      res.write(
        `id: ${event.cursor}\nevent: ${event.type}\ndata: ${redactedSseLine(JSON.stringify(event))}\n\n`,
      );
    }
  };
  write(initial);
  const poll = setInterval(() => {
    if (closed || reading) return;
    reading = true;
    void service(partition, cursor)
      .then((value) => write(parseEvents(value)))
      .catch(() => {
        if (!closed) res.destroy();
      })
      .finally(() => {
        reading = false;
      });
  }, ctx.pollMs ?? 250);
  poll.unref?.();
  const heartbeat = setInterval(() => {
    if (!closed) res.write(`: ping ${Date.now()}\n\n`);
  }, ctx.heartbeatMs ?? 15_000);
  heartbeat.unref?.();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    ctx.sseClients.delete(res);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
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

function parseEvents(value: unknown): JournalEvent[] {
  if (!Array.isArray(value)) throw new Error("journal event service returned a non-array");
  return value.map((event) => ControlJournalEvent.parse(event));
}
