import { Agent, request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonControlApiServer } from "./daemon-server.js";
import { CONTROL_HTTP_TIMEOUTS } from "./http-server-options.js";
import type { DaemonFacadeClient } from "./run-record.js";

const unused = async (): Promise<never> => {
  throw new Error("the daemon facade is not used by this test");
};
const daemon: DaemonFacadeClient = {
  enqueue: unused,
  status: unused,
  list: unused,
  cancel: unused,
};

let api: DaemonControlApiServer | null = null;
afterEach(async () => {
  await api?.stop();
  api = null;
});

describe("control API HTTP server timeouts", () => {
  it("applies explicit keep-alive, header and request timeouts to the live server", async () => {
    api = new DaemonControlApiServer({ token: "token", daemon, host: "127.0.0.1", port: 0 });
    const { host, port } = await api.start();
    const server = (api as unknown as { server: Server }).server;
    expect({
      keepAliveTimeout: server.keepAliveTimeout,
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
    }).toEqual(CONTROL_HTTP_TIMEOUTS);
    // Idle sockets outlive the 5 s client keep-alive expiry; headers wait
    // longer than an idle socket lives; requests are never cut mid-receipt.
    expect(server.keepAliveTimeout).toBeGreaterThan(5_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBe(0);
    // A keep-alive client is told the longer idle window.
    const keepAlive = await new Promise<string | undefined>((resolve, reject) => {
      const req = request(
        { host, port, path: "/healthz", headers: { host: "127.0.0.1" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(String(res.headers["keep-alive"])));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(keepAlive).toBe("timeout=65");
  });

  it("stops without waiting out keep-alive for a response still in flight at stop", async () => {
    let answer!: (value: unknown) => void;
    let called!: () => void;
    const reached = new Promise<void>((resolve) => {
      called = resolve;
    });
    api = new DaemonControlApiServer({
      token: "token",
      daemon: {
        ...daemon,
        health: () => {
          called();
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
      host: "127.0.0.1",
      port: 0,
    });
    const { host, port } = await api.start();
    // A keep-alive client that never closes its socket on its own.
    const agent = new Agent({ keepAlive: true });
    try {
      const response = new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          {
            agent,
            host,
            port,
            path: "/v2/daemon/status",
            headers: {
              host: "127.0.0.1",
              authorization: ["Bearer", "token"].join(" "),
              "x-claudexor-protocol-major": "3",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end();
      });
      await reached;
      const stopped = api.stop().then(() => "stopped");
      api = null;
      answer({ ok: true });
      expect(await response).toBeGreaterThanOrEqual(200);
      // Without the close-on-finish hook the socket idles for the 65 s
      // keep-alive window; the bound here is a hang detector, not a speed check.
      const hang = new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20_000));
      expect(await Promise.race([stopped, hang])).toBe("stopped");
    } finally {
      agent.destroy();
    }
  }, 30_000);
});
