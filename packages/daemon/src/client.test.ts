import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "./client.js";
import { rpcProblem } from "./rpc-problem.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function socketPath() {
  const root = mkdtempSync(join(tmpdir(), "cx-rpc-"));
  roots.push(root);
  return process.platform === "win32" ? `\\\\.\\pipe\\cx-${randomUUID()}` : join(root, "d.sock");
}
async function withSocket(
  onConnect: (socket: Socket) => void,
  run: (client: DaemonClient) => Promise<void>,
) {
  const path = socketPath();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnect(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await run(new DaemonClient(path, randomUUID()));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

describe("daemon RPC transport", () => {
  it("bounds a silent socket at ten seconds with retryable daemon_busy", async () => {
    await withSocket(
      () => {},
      async (client) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const answer = expect(client.health()).rejects.toMatchObject({
          code: "daemon_busy",
          status: 503,
          retryable: true,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await answer;
        vi.useRealTimers();
      },
    );
  });
  it("reports a missing socket and immediate close as unavailable", async () => {
    await expect(new DaemonClient(socketPath(), randomUUID()).health()).rejects.toMatchObject({
      code: "daemon_unavailable",
      status: 503,
      retryable: true,
    });
    await withSocket(
      (s) => s.end(),
      async (client) => {
        await expect(client.health()).rejects.toMatchObject({
          code: "daemon_unavailable",
          status: 503,
          retryable: true,
        });
      },
    );
  });
  it.each(["not json", "null", "{}"])("refuses an invalid response: %s", async (response) => {
    await withSocket(
      (s) => s.end(response + "\n"),
      async (client) => {
        await expect(client.health()).rejects.toMatchObject({
          code: "daemon_unavailable",
          status: 503,
        });
      },
    );
  });
  it("preserves a normal result and daemon-authored 404/409 problems", async () => {
    for (const status of [200, 404, 409]) {
      const problem = Object.assign(new Error("predecessor refusal"), {
        status,
        code: status === 404 ? "predecessor_unknown" : "continuation_superseded",
        retryable: false,
        context: { head: "run-head" },
        requiredActions: ["continue_head"],
      });
      await withSocket(
        (s) =>
          s.once("data", (data) => {
            const { id } = JSON.parse(data.toString());
            s.end(
              JSON.stringify({
                id,
                ...(status === 200 ? { result: { ok: true } } : { error: rpcProblem(problem) }),
              }) + "\n",
            );
          }),
        async (client) => {
          if (status === 200) await expect(client.health()).resolves.toEqual({ ok: true });
          else
            await expect(client.health()).rejects.toMatchObject({
              status,
              code: problem.code,
              retryable: false,
              context: problem.context,
              requiredActions: problem.requiredActions,
            });
        },
      );
    }
  });
});
