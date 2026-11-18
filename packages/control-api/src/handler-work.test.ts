import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { processTiming } from "@claudexor/util";
import { DaemonControlApiServer } from "./daemon-server.js";
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

const handler = () =>
  processTiming.facts().work.find((entry) => entry.kind === "control.handler")?.lifetime ?? {
    count: 0,
    totalMs: 0,
  };

describe("main-thread work of the control API", () => {
  it("counts a request's synchronous handling as control.handler time", async () => {
    api = new DaemonControlApiServer({ token: "token", daemon, host: "127.0.0.1", port: 0 });
    const { host, port } = await api.start();
    const before = handler();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host, port, path: "/healthz", headers: { host: "127.0.0.1" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    const after = handler();
    expect(after.count).toBeGreaterThan(before.count);
    expect(after.totalMs).toBeGreaterThan(before.totalMs);
  });
});
