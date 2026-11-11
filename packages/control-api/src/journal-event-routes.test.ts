import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import {
  handleJournalEventRoute,
  type JournalEventPageRequest,
  type JournalEventRouteContext,
} from "./journal-event-routes.js";

type Service = (partition: string, request: JournalEventPageRequest) => Promise<unknown>;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function event(seq: number, text = "") {
  return {
    schemaVersion: 1,
    cursor: `c${seq}`,
    partition: "global",
    type: "fixture.event",
    observedAt: "2026-10-29T00:00:00.000Z",
    payload: { seq, text },
  };
}
const page = (events: unknown[], position: string, through = "head", more = false) => ({
  events,
  position,
  through,
  more,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The route alone over a real socket, so tests can observe its response buffer. */
async function serve(service: Service, options: { pollMs?: number; heartbeatMs?: number } = {}) {
  const responses: ServerResponse[] = [];
  const sseClients = new Set<ServerResponse>();
  const ctx: JournalEventRouteContext = {
    services: { journalEvents: service },
    pollMs: options.pollMs ?? 5,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    sseClients,
    json: (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    requestError: (res, error) => {
      const problem = error as { status?: number; code?: string; message?: string };
      res.writeHead(problem.status ?? 500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ code: problem.code ?? "internal", message: problem.message }));
    },
  };
  const server = createServer((req, res) => {
    responses.push(res);
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleJournalEventRoute(ctx, req.method ?? "GET", path, req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const open = (headers: Record<string, string> = {}) => {
    const req = request({ host: "127.0.0.1", port, path: "/global/events", headers });
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      req.on("response", resolve);
      req.on("error", reject);
    });
    req.end();
    return { req, response };
  };
  return {
    responses,
    sseClients,
    open,
    connect: (headers?: Record<string, string>) => open(headers).response,
  };
}

/** Complete SSE frames as they arrive; comments are kept so tests can see pings. */
function frames(response: IncomingMessage) {
  const received: string[] = [];
  let buffered = "";
  const done = new Promise<void>((resolve) => {
    response.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        received.push(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
      }
    });
    response.on("close", resolve);
  });
  const ids = () =>
    received.filter((frame) => frame.startsWith("id: ")).map((frame) => frame.split("\n")[0]!);
  return { received, ids, done };
}

it("walks every page through the head its first page captured, then tails from a new head", async () => {
  const requests: JournalEventPageRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const initial = [
    page([event(1), event(2)], "c2", "h1", true),
    page([event(3)], "c3", "h1", true),
    page([event(4)], "c4", "h1", false),
  ];
  let tailed = false;
  const { connect } = await serve(async (_partition, req) => {
    requests.push(req);
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await pause(2);
    inFlight -= 1;
    const next = initial.shift();
    if (next) return next;
    if (!tailed && req.after === "c4") {
      tailed = true;
      return page([event(5)], "c5", "h2", false);
    }
    return page([], req.after!, "h3");
  });
  const stream = frames(await connect());
  await vi.waitFor(() => expect(stream.ids()).toHaveLength(5));
  expect(stream.ids()).toEqual(["id: c1", "id: c2", "id: c3", "id: c4", "id: c5"]);
  expect(requests.slice(0, 5)).toEqual([
    { after: undefined },
    { after: "c2", through: "h1" },
    { after: "c3", through: "h1" },
    { after: "c4", through: undefined },
    { after: "c5", through: undefined },
  ]);
  expect(maxInFlight).toBe(1);
});

it("holds the next page until a paused client drains, and pings never add to a full socket", async () => {
  const payload = "p".repeat(1024 * 1024);
  let calls = 0;
  const total = 64;
  const { connect, responses } = await serve(
    async (_partition, req) => {
      calls += 1;
      const seq = req.after ? Number(req.after.slice(1)) + 1 : 1;
      if (seq > total) return page([], req.after!);
      return page([event(seq, payload)], `c${seq}`, `c${total}`, seq < total);
    },
    { heartbeatMs: 5 },
  );
  const client = await connect();
  const res = responses[0]!;
  // Operating-system socket buffers absorb some frames first; then the walk waits.
  for (let seen = -1; seen !== calls; await pause(100)) seen = calls;
  const held = { calls, bytes: res.writableLength };
  await pause(100);
  expect(res.writableNeedDrain).toBe(true);
  expect(calls).toBe(held.calls);
  expect(res.writableLength).toBeLessThanOrEqual(held.bytes);
  // At most one frame waits beyond the socket's own buffer.
  expect(res.writableLength).toBeLessThan(2 * payload.length);
  expect(calls).toBeLessThan(total);
  const stream = frames(client);
  await vi.waitFor(() => expect(stream.ids()).toHaveLength(total), { timeout: 20_000 });
  expect(stream.ids()).toEqual(Array.from({ length: total }, (_, i) => `id: c${i + 1}`));
});

it("stops when the client leaves before headers, during a page read, or while the socket is full", async () => {
  // Before headers: the first read finishes after the client left.
  const first = deferred<unknown>();
  let early = 0;
  const before = await serve(async () => {
    early += 1;
    return first.promise;
  });
  const leaving = before.open();
  leaving.response.catch(() => {});
  await vi.waitFor(() => expect(early).toBe(1));
  leaving.req.destroy();
  await vi.waitFor(() => expect(before.responses[0]!.destroyed).toBe(true));
  first.resolve(page([event(1)], "c1", "c1"));
  await pause(30);
  expect(early).toBe(1);
  expect(before.responses[0]!.headersSent).toBe(false);
  expect(before.sseClients.size).toBe(0);

  // During a later page read.
  const second = deferred<unknown>();
  let reads = 0;
  const during = await serve(async (_partition, req) => {
    reads += 1;
    return req.after ? second.promise : page([event(1)], "c1", "c2", true);
  });
  const client = await during.connect();
  const stream = frames(client);
  await vi.waitFor(() => expect(stream.ids()).toEqual(["id: c1"]));
  await vi.waitFor(() => expect(reads).toBe(2));
  client.destroy();
  await vi.waitFor(() => expect(during.sseClients.size).toBe(0));
  second.resolve(page([event(2)], "c2", "c2", true));
  await pause(30);
  expect(reads).toBe(2);

  // While the socket is full.
  let fullReads = 0;
  const full = await serve(async (_partition, req) => {
    fullReads += 1;
    const seq = req.after ? Number(req.after.slice(1)) + 1 : 1;
    return page([event(seq, "f".repeat(1024 * 1024))], `c${seq}`, "c99", true);
  });
  const paused = await full.connect();
  for (let seen = -1; seen !== fullReads; await pause(100)) seen = fullReads;
  expect(full.responses[0]!.writableNeedDrain).toBe(true);
  const atDisconnect = fullReads;
  paused.destroy();
  await vi.waitFor(() => expect(full.sseClients.size).toBe(0));
  await pause(30);
  expect(fullReads).toBe(atDisconnect);
});

it("refuses a cursor before headers and closes the stream when a later page is refused", async () => {
  const refused = await serve(async () => {
    throw Object.assign(new Error("journal cursor is stale epoch; resnapshot is required"), {
      status: 409,
      code: "journal_cursor_invalid",
    });
  });
  const answer = await refused.connect({ "Last-Event-ID": "stale" });
  expect(answer.statusCode).toBe(409);
  expect(answer.headers["content-type"]).toContain("application/problem+json");
  answer.resume();

  let calls = 0;
  const replaced = await serve(async () => {
    calls += 1;
    if (calls === 1) return page([event(1)], "c1", "c1");
    throw Object.assign(new Error("journal cursor is stale epoch; resnapshot is required"), {
      status: 409,
      code: "journal_cursor_invalid",
    });
  });
  const live = await replaced.connect();
  expect(live.statusCode).toBe(200);
  const stream = frames(live);
  live.on("error", () => {});
  await stream.done;
  expect(stream.ids()).toEqual(["id: c1"]);
  expect(stream.received.some((frame) => frame.startsWith("event: end"))).toBe(false);
  await vi.waitFor(() => expect(replaced.sseClients.size).toBe(0));

  // The former whole-array contract is not a page.
  const legacy = await serve(async () => [event(1)]);
  const invalid = await legacy.connect();
  expect(invalid.statusCode).toBe(500);
  invalid.resume();
});

it("keeps idle streams alive with pings", async () => {
  const { connect: open } = await serve(async (_partition, req) => page([], req.after ?? "c0"), {
    heartbeatMs: 5,
  });
  const stream = frames(await open());
  await vi.waitFor(() =>
    expect(stream.received.filter((frame) => frame.startsWith(": ping")).length).toBeGreaterThan(2),
  );
});
