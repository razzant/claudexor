import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProcessTiming } from "@claudexor/util";
import { expect, it } from "vitest";
import { trackRequest } from "./request-timing.js";
import { OPERATION_CATALOG } from "./operation-catalog.js";

it("aggregates every catalog template and never retains URL identifiers or queries", () => {
  const timing = new ProcessTiming();
  for (const operation of OPERATION_CATALOG.operations) {
    for (let i = 0; i < 2; i++) {
      const url =
        operation.path.replace(/:[^/]+/g, `private-id-${i}`).replace("<path>", "private/path") +
        "?secret=fixture";
      const res = new EventEmitter() as ServerResponse;
      trackRequest(
        { method: operation.method, url, socket: { destroyed: false } } as IncomingMessage,
        res,
        timing,
      );
      res.emit("finish");
      res.emit("close");
    }
  }
  const facts = timing.facts();
  expect(facts.routes).toHaveLength(OPERATION_CATALOG.operations.length);
  expect(facts.routes.every((route) => route.lifetime.count === 2)).toBe(true);
  expect(JSON.stringify(facts)).not.toMatch(/private-id|private\/path|secret=fixture/);
  expect(facts.routes.map((r) => `${r.method} ${r.route}`).sort()).toEqual(
    OPERATION_CATALOG.operations.map((o) => `${o.method} ${o.path}`).sort(),
  );
});

it("counts a disconnect once and puts arbitrary methods and URLs in one fixed bucket", () => {
  const timing = new ProcessTiming();
  for (let i = 0; i < 100; i++) {
    const res = new EventEmitter() as ServerResponse;
    trackRequest(
      {
        method: `UNKNOWN${i}`,
        url: `/private-${i}`,
        socket: { destroyed: false },
      } as IncomingMessage,
      res,
      timing,
    );
    res.emit("close");
    res.emit("finish");
  }
  expect(timing.facts().routes).toMatchObject([
    { method: "OTHER", route: "<unmatched>", lifetime: { count: 100 } },
  ]);
});

it.each([
  [200, false, true, "served"],
  [404, false, true, "not_found"],
  [503, false, true, "failed"],
  [200, false, false, "disconnected"],
  [200, true, false, "disconnected_at_entry"],
] as const)(
  "records route outcome for status %s / entry disconnect %s / finished %s",
  (statusCode, destroyed, writableFinished, outcome) => {
    const timing = new ProcessTiming();
    const res = Object.assign(new EventEmitter(), {
      statusCode,
      destroyed,
      writableFinished,
    }) as ServerResponse;
    trackRequest(
      {
        method: "GET",
        url: "/v2/runs/private",
        destroyed,
        complete: false,
        socket: { destroyed: false },
      } as IncomingMessage,
      res,
      timing,
    );
    res.emit(writableFinished ? "finish" : "close");
    res.emit("close");
    expect(timing.facts().routes).toMatchObject([
      {
        method: "GET",
        route: "/v2/runs/:id",
        outcomes: [{ outcome, lifetime: { count: 1 } }],
        lifetime: { count: 1 },
      },
    ]);
  },
);

it("does not label a completed request body as disconnected at entry", () => {
  const timing = new ProcessTiming();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: true,
  }) as ServerResponse;
  trackRequest(
    {
      method: "GET",
      url: "/v2/runs/run",
      destroyed: true,
      complete: true,
      socket: { destroyed: false },
    } as IncomingMessage,
    res,
    timing,
  );
  res.emit("finish");
  expect(timing.facts().routes[0]?.outcomes?.[0]?.outcome).toBe("served");
});

it("records an already lost socket at entry without awaiting another close event", () => {
  const timing = new ProcessTiming();
  const res = new EventEmitter() as ServerResponse;
  trackRequest(
    { method: "GET", url: "/v2/runs/run", socket: { destroyed: true } } as IncomingMessage,
    res,
    timing,
  );
  expect(timing.facts().routes[0]?.outcomes?.[0]?.outcome).toBe("disconnected_at_entry");
  expect(res.listenerCount("close")).toBe(0);
});
