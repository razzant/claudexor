import { createServer, type RequestListener } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent, type Dispatcher } from "undici";
import { RequestDelivery, type ResponseBounds } from "./request-delivery.js";
import { boundReached } from "./response-bounds.js";

const originalDispatcher = getGlobalDispatcher();
afterEach(() => setGlobalDispatcher(originalDispatcher));
const bodyOf = (text: string) => new RequestDelivery(Buffer.from(text, "utf8"));

async function endpoint(handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const send = (url: string, delivery: RequestDelivery, bounds?: ResponseBounds) =>
  fetch(url, {
    method: "POST",
    headers: { "content-length": String(delivery.bytes.length) },
    ...delivery.request(bounds),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
/** A peer in another thread: it answers at once and keeps writing a chunk
 * every 100 ms, whatever the thread of the test does. Posts its port. */
const SENDING_PEER = `
  const { createServer } = require("node:http");
  const { parentPort } = require("node:worker_threads");
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tick = setInterval(() => res.write(": keep-alive\\n\\n"), 100);
    res.on("close", () => clearInterval(tick));
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;
/** The code of the first error in a cause chain that has one. */
const causeCode = (error: unknown): unknown => {
  for (let current = error; current && typeof current === "object";)
    if ("code" in current && typeof current.code === "string") return current.code;
    else current = (current as { cause?: unknown }).cause;
  return undefined;
};

describe("request delivery proof on the existing dispatcher", () => {
  it("keeps an existing proxy dispatcher and its connection ownership", async () => {
    const destination = await endpoint((req, res) => {
      req.resume();
      req.on("end", () => res.end("through proxy"));
    });
    const sockets: Duplex[] = [];
    let tunnels = 0;
    const proxy = createServer();
    proxy.on("connect", (_req, downstream, head) => {
      tunnels += 1;
      const upstream = connect(Number(new URL(destination.url).port), "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream).pipe(downstream);
      });
      sockets.push(upstream, downstream);
      downstream.on("error", () => upstream.destroy());
      upstream.on("error", () => downstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing proxy listener");
    const owner = new ProxyAgent(`http://127.0.0.1:${address.port}`);
    setGlobalDispatcher(owner);
    try {
      const delivery = bodyOf("x".repeat(200_000));
      const response = await send(destination.url, delivery);
      expect(await response.text()).toBe("through proxy");
      expect(tunnels).toBe(1);
      expect(getGlobalDispatcher()).toBe(owner);
      expect(delivery.facts()).toMatchObject({ handedOffBytes: 200_000, responseReceived: true });
      expect(delivery.notDelivered()).toBeNull();
    } finally {
      await owner.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await destination.close();
    }
  });

  it("preserves exact UTF-8 bytes, length and concurrent request identity", async () => {
    const received: Buffer[] = [];
    const server = await endpoint((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received.push(Buffer.concat(chunks));
        res.end("ok");
      });
    });
    const requests = Array.from({ length: 5 }, (_, i) =>
      bodyOf(JSON.stringify({ text: "Я🦉".repeat(20_000 + i) })),
    );
    try {
      await Promise.all(
        requests.map(async (request) => {
          const response = await send(server.url, request);
          expect(await response.text()).toBe("ok");
        }),
      );
      for (const request of requests) {
        expect(received.some((bytes) => bytes.equals(request.bytes))).toBe(true);
        expect(request.facts()).toMatchObject({
          handedOffBytes: request.bytes.length,
          dispatches: 1,
          responseReceived: true,
        });
        expect(request.notDelivered()).toBeNull();
      }
      expect(getGlobalDispatcher()).toBe(originalDispatcher);
    } finally {
      await server.close();
    }
  });

  it("proves an early incomplete upload, but never a full handoff followed by a broken connection", async () => {
    const server = await endpoint((req, res) => {
      req.on("error", () => {});
      req.on("data", () => {
        if (req.url === "/early") req.socket.destroy();
      });
      req.on("end", () => {
        if (req.url === "/late") req.socket.destroy();
        else res.end("ok");
      });
    });
    try {
      const early = bodyOf("x".repeat(8 * 1024 * 1024));
      await expect(send(server.url + "/early", early)).rejects.toThrow();
      expect(early.notDelivered()).toMatchObject({
        basis: "incomplete_upload",
        state: "not_delivered",
      });
      expect(early.facts().handedOffBytes).toBeLessThan(early.bytes.length);
      const late = bodyOf("x".repeat(200_000));
      await expect(send(server.url + "/late", late)).rejects.toThrow();
      expect(late.facts().handedOffBytes).toBe(late.bytes.length);
      expect(late.notDelivered()).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("proves a refused connection through the dispatch callback, preserving an unobserved byte count", async () => {
    const server = await endpoint((_req, res) => res.end("unused"));
    await server.close();
    const delivery = bodyOf("complete body");
    await expect(send(server.url, delivery)).rejects.toThrow();
    expect(delivery.notDelivered()).toMatchObject({
      basis: "connect_failure",
      handedOffBytes: null,
      observedChunks: 0,
      errorCodes: ["ECONNREFUSED"],
    });
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "ENOTFOUND",
    "CERT_HAS_EXPIRED",
    // Not on any list: the place in the callback order is the proof, not the code.
    "EADDRNOTAVAIL",
    "EHOSTUNREACH",
    "ENETDOWN",
    undefined,
  ])("requires the pre-connect callback provenance for %s", async (code) => {
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              handler.onError?.(Object.assign(new Error("fixture connector refusal"), { code }));
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const delivery = bodyOf("body");
    await expect(send("http://localhost/", delivery)).rejects.toThrow();
    expect(delivery.notDelivered()).toMatchObject({
      basis: "connect_failure",
      errorCodes: [code ?? null],
    });
  });

  it("proves nothing for a dispatch that reported no error, such as a caller giving up before any callback", async () => {
    const cancel = new AbortController();
    // The dispatcher holds the request and calls nothing back, as while a
    // connection is still being set up; then the caller cancels.
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return () => {
              setImmediate(() => cancel.abort());
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const delivery = bodyOf("body");
    await expect(
      fetch("http://localhost/", {
        method: "POST",
        ...delivery.request(),
        signal: cancel.signal,
      }),
    ).rejects.toThrow();
    // The send was observed; what is missing is an error from the dispatcher.
    expect(delivery.facts().dispatches).toBe(1);
    expect(delivery.notDelivered()).toBeNull();
  });

  it("does not erase a prior response or handoff when a later same-fetch request cannot connect", async () => {
    const delivery = bodyOf("body");
    const observer = delivery.request().dispatcher;
    let attempt = 0;
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              if (attempt++ === 0) {
                handler.onConnect?.(() => {});
                // Native implementations pass the chunk, despite the declaration
                // in both undici-types6 and undici7 describing two numeric args.
                (handler.onBodySent as unknown as (chunk: Buffer) => void)?.(Buffer.from("body"));
              }
              handler.onError?.(Object.assign(new Error("connector"), { code: "ECONNREFUSED" }));
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const options = { origin: "http://localhost", path: "/", method: "POST" as const };
    const handler = {
      onConnect() {},
      onError() {},
      onHeaders() {
        return true;
      },
      onData() {
        return true;
      },
      onComplete() {},
    };
    observer.dispatch(options, handler);
    observer.dispatch(options, handler);
    expect(delivery.facts().dispatches).toBe(2);
    expect(delivery.notDelivered()).toBeNull();
  });

  it("forwards an unfamiliar public callback shape without throwing or inventing bytes", () => {
    const observed: unknown[][] = [];
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (_opts: unknown, handler: Dispatcher.DispatchHandler) => {
              handler.onBodySent?.(2, 2);
              handler.onError?.(Object.assign(new Error("connector"), { code: "ECONNREFUSED" }));
              return false;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const delivery = bodyOf("body");
    const returned = delivery.request().dispatcher.dispatch(
      { origin: "http://localhost", path: "/", method: "POST" },
      {
        onBodySent: (...args: unknown[]) => {
          observed.push(args);
        },
        onError() {},
      },
    );
    expect(returned).toBe(false);
    expect(observed).toEqual([[2, 2]]);
    expect(delivery.facts().handedOffBytes).toBeNull();
    expect(delivery.notDelivered()).toBeNull();
  });

  it.each(["onConnect", "onRequestStart"] as const)(
    "keeps an error after %s unknown even though no body chunk was handed off",
    (began) => {
      setGlobalDispatcher(
        new Proxy(originalDispatcher, {
          get(target, key) {
            if (key === "dispatch")
              return (_opts: unknown, handler: Record<string, (...args: unknown[]) => void>) => {
                // The library began to write this request, then the socket failed.
                handler[began]?.(() => {});
                handler.onError?.(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
                return true;
              };
            return Reflect.get(target, key, target);
          },
        }),
      );
      const delivery = bodyOf("body");
      delivery
        .request()
        .dispatcher.dispatch({ origin: "http://localhost", path: "/", method: "POST" }, {
          onConnect() {},
          onRequestStart() {},
          onError() {},
        } as never);
      expect(delivery.facts()).toMatchObject({ dispatches: 1, observedChunks: 0 });
      expect(delivery.notDelivered()).toBeNull();
    },
  );

  it("observes the newer handler generation through the real dispatcher", async () => {
    const server = await endpoint((req, res) => {
      req.on("error", () => {});
      req.resume();
      req.on("end", () => {
        if (req.url === "/reset") req.socket.destroy();
        else res.end("ok");
      });
    });
    const closed = await endpoint((_req, res) => res.end("unused"));
    await closed.close();
    const run = (origin: string, path: string) =>
      new Promise<RequestDelivery>((resolve) => {
        const delivery = bodyOf("body");
        delivery.request().dispatcher.dispatch(
          {
            origin,
            path,
            method: "POST",
            headers: { "content-length": "4" },
            body: delivery.bytes,
          },
          {
            onRequestStart() {},
            onResponseStart() {},
            onResponseData() {},
            onResponseEnd: () => resolve(delivery),
            onResponseError: () => resolve(delivery),
          } as never,
        );
      });
    try {
      // Refused before the request began; the error follows the callback's controller.
      expect((await run(closed.url, "/")).notDelivered()).toMatchObject({
        basis: "connect_failure",
        errorCodes: ["ECONNREFUSED"],
      });
      // Reset after the request began: unknown.
      const reset = await run(server.url, "/reset");
      expect(reset.notDelivered()).toBeNull();
      expect(reset.facts().responseReceived).toBe(false);
      expect((await run(server.url, "/fine")).facts().responseReceived).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("sets its bounds on its own request and leaves a request without bounds as the dispatcher has it", () => {
    const seen: Array<Record<string, unknown>> = [];
    setGlobalDispatcher(
      new Proxy(originalDispatcher, {
        get(target, key) {
          if (key === "dispatch")
            return (options: Record<string, unknown>) => {
              seen.push(options);
              return true;
            };
          return Reflect.get(target, key, target);
        },
      }),
    );
    const options = { origin: "http://localhost", path: "/", method: "POST" as const };
    bodyOf("body").request({ headMs: 1_000, silenceMs: 2_000 }).dispatcher.dispatch(options, {});
    bodyOf("body").request().dispatcher.dispatch(options, {});
    expect(seen[0]).toEqual({ ...options, headersTimeout: 1_000, bodyTimeout: 2_000 });
    expect(seen[1]).toBe(options);
  });

  it("stops waiting for a response head at its bound, and for a silent body at its bound", async () => {
    const server = await endpoint((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/silent-body") res.write("first chunk");
        // Neither request is ever answered further.
      });
    });
    try {
      const head = bodyOf("body");
      const headError = await send(server.url + "/no-head", head, {
        headMs: 300,
        silenceMs: 60_000,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(causeCode(headError)).toBe("UND_ERR_HEADERS_TIMEOUT");
      // The whole body was handed off: the outcome is unknown, not undelivered.
      expect(head.notDelivered()).toBeNull();
      const body = bodyOf("body");
      const response = await send(server.url + "/silent-body", body, {
        headMs: 60_000,
        silenceMs: 300,
      });
      const bodyError = await response.text().then(
        () => null,
        (error: unknown) => error,
      );
      expect(causeCode(bodyError)).toBe("UND_ERR_BODY_TIMEOUT");
      expect(body.facts().responseReceived).toBe(true);
      // The words name the library's report and the engine's setting, nothing else.
      expect(boundReached(headError)).toBe(
        " The HTTP library reported a response-head timeout; the engine asks for 300 s on this request.",
      );
      expect(boundReached(bodyError)).toBe(
        " The HTTP library reported a response-body timeout; the engine asks for 300 s on this request.",
      );
    } finally {
      await server.close();
    }
  });

  it("does not end a stream whose reader stalled for longer than the body bound while the peer kept sending", async () => {
    const peer = new Worker(SENDING_PEER, { eval: true });
    try {
      const port = await new Promise<number>((resolve) => peer.once("message", resolve));
      const response = await send(`http://127.0.0.1:${port}/`, bodyOf("body"), {
        headMs: 60_000,
        silenceMs: 3_000,
      });
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      // This thread does nothing for longer than the bound. The bound is the
      // library's clock, counted in ticks that stop with this thread: it is not
      // a wall-clock deadline, and the bytes that arrived meanwhile are read.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4_500);
      for (let i = 0; i < 5; i += 1) expect((await reader.read()).done).toBe(false);
      await reader.cancel();
    } finally {
      await peer.terminate();
    }
  }, 30_000);
});
