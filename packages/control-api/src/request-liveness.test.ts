import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { DaemonControlApiServer } from "./daemon-server.js";
import type { DaemonFacadeClient } from "./run-record.js";
import { requestGone } from "./request-liveness.js";
import { serveRunDetail } from "./run-detail-route.js";
import { summarizeRunPage } from "./run-list.js";

it("distinguishes a normally consumed body from a lost connection", () => {
  const socket = { destroyed: false };
  const req = {
    complete: true,
    destroyed: true,
    aborted: false,
    socket,
  } as IncomingMessage;
  const res = { destroyed: false } as ServerResponse;
  expect(requestGone(req, res)).toBe(false);
  req.complete = false;
  expect(requestGone(req, res)).toBe(true);
  req.complete = true;
  req.aborted = true;
  expect(requestGone(req, res)).toBe(true);
  req.aborted = false;
  socket.destroyed = true;
  expect(requestGone(req, res)).toBe(true);
});

it("does no request handling when already disconnected at entry", async () => {
  const list = vi.fn();
  const api = new DaemonControlApiServer({
    token: "fixture",
    daemon: { list } as unknown as DaemonFacadeClient,
  });
  const req = {
    aborted: true,
    get url() {
      throw new Error("parsed an abandoned URL");
    },
  } as unknown as IncomingMessage;
  const handle = api as unknown as {
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  };
  await handle.handle(req, { destroyed: true } as ServerResponse);
  expect(list).not.toHaveBeenCalled();
});

it.each(["lookup", "children"] as const)(
  "skips heavy detail after a real disconnect during %s, but projects a live request",
  async (phase) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const project = vi.fn(async () => JSON.stringify({ projected: true }));
    let held = true;
    const block = async (at: string): Promise<void> => {
      if (held && phase === at) {
        entered();
        await gate;
      }
    };
    const pending: Promise<void>[] = [];
    const server = createServer((req, res) => {
      res.once("close", closed);
      pending.push(
        serveRunDetail(
          {
            findRun: async () => {
              await block("lookup");
              return { id: "job", state: "running" };
            },
            children: async () => {
              await block("children");
              return [];
            },
            project,
            cursor: async () => 0,
            serialized: (response, body) => response.end(body),
            json: (response, status, body) => {
              response.writeHead(status, { "content-type": "application/json" });
              response.end(JSON.stringify(body));
            },
          },
          "job",
          req,
          res,
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/v2/runs/job`;
    const client = request(url);
    client.on("error", () => {});
    client.end();
    try {
      await waiting;
      client.destroy();
      await disconnected;
      release();
      await Promise.all(pending);
      expect(project).not.toHaveBeenCalled();
      held = false;
      const live = await fetch(url);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ projected: true });
      expect(project).toHaveBeenCalledOnce();
    } finally {
      release();
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("stops a yielding run page before projecting another row after disconnect", async () => {
  let active = true;
  const project = vi.fn((record) => {
    setImmediate(() => {
      active = false;
    });
    return record.id;
  });
  expect(
    await summarizeRunPage(
      [
        { id: "one", state: "running" },
        { id: "two", state: "running" },
      ],
      project,
      () => active,
    ),
  ).toEqual(["one"]);
  expect(project).toHaveBeenCalledOnce();
});
