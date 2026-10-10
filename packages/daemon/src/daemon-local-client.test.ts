import { sqlFixture } from "./store/test-support/sql-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "./client.js";
import { DaemonLocalClient } from "./daemon-local-client.js";
import { DaemonServer } from "./server.js";

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const TOKEN = "local-client-test-token";

/** A real daemon over a real command journal, serving `normal`. */
async function daemon(options: { listen?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cx-local-")));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "d.sock");
  const sql = await sqlFixture(dir);
  disposers.push(() => sql.close());
  const server = new DaemonServer({
    socketPath,
    token: TOKEN,
    commands: sql.graph.commands,
    runner: async () => ({ lifecycle: "succeeded" }),
  });
  if (options.listen !== false) {
    await server.start();
    disposers.push(() => server.stop());
  }
  return {
    server,
    socket: new DaemonClient(socketPath, TOKEN),
    local: new DaemonLocalClient(() => server),
  };
}

/** Everything a caller can observe about a settled call. */
async function outcome(call: Promise<unknown>) {
  try {
    return { result: await call };
  } catch (error) {
    const e = error as Error;
    return { error: { ...e, name: e.name, message: e.message } };
  }
}

async function settled(client: DaemonLocalClient, id: string) {
  for (let i = 0; i < 200; i += 1) {
    const record = await client.status(id);
    if (record.state !== "queued" && record.state !== "running") return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${id} did not settle`);
}

describe("DaemonLocalClient", () => {
  it("answers exactly like the socket client: success, typed problem, validation error, unknown method, thrown exception", async () => {
    const { socket, local } = await daemon();
    const request = { mode: "agent", prompt: "equivalence" };
    const accepted = await local.enqueue(request, { idempotencyKey: "k-1", clientId: "test" });
    await settled(local, accepted.id);

    // Success: the same durable command reads identically through both transports.
    const replay = { idempotencyKey: "k-1", clientId: "test" };
    expect(await outcome(local.enqueue(request, replay))).toStrictEqual(
      await outcome(socket.enqueue(request, replay)),
    );
    expect(await outcome(local.status(accepted.id))).toStrictEqual(
      await outcome(socket.status(accepted.id)),
    );
    expect(await outcome(local.list({ id: accepted.id }))).toStrictEqual(
      await outcome(socket.list({ id: accepted.id })),
    );
    expect(await outcome(local.findAccepted(request, replay))).toStrictEqual(
      await outcome(socket.findAccepted(request, replay)),
    );
    expect(await outcome(local.cancel(accepted.id))).toStrictEqual(
      await outcome(socket.cancel(accepted.id)),
    );

    const cases: Array<[string, (client: DaemonClient | DaemonLocalClient) => Promise<unknown>]> = [
      // Typed daemon refusal with code/status/retryable/requiredActions.
      [
        "continuation refusal",
        (client) =>
          client.enqueue({ ...request, continueFrom: "run-missing" }, { clientId: "test" }),
      ],
      ["delegation fence refusal", (client) => client.fenceDelegationParent("run-missing")],
      // Request validation at the RPC boundary.
      ["invalid list query", (client) => client.list({ bogus: true } as never)],
      ["missing list query", (client) => client.call("claudexor.list", {})],
      ["unknown method", (client) => client.call("claudexor.nope")],
      // An untyped exception thrown by the dispatcher.
      ["missing job", (client) => client.status("job-missing")],
    ];
    for (const [name, run] of cases) {
      const viaLocal = await outcome(run(local));
      expect(viaLocal, name).toHaveProperty("error");
      expect(viaLocal, name).toStrictEqual(await outcome(run(socket)));
    }
  });

  it("projects every problem field through the shared wire rules, byte for byte", async () => {
    const { server, socket, local } = await daemon();
    const dispatch = vi.spyOn(server, "dispatch");
    const thrown: unknown[] = [
      Object.assign(new Error("typed refusal"), {
        code: "example_refused",
        status: 409,
        retryable: false,
        context: { head: "run-head", nested: { attempt: 2 } },
        requiredActions: ["Continue the head run instead."],
      }),
      // Non-wire values: a non-number status and a non-boolean retryable are
      // dropped by the socket's JSON projection, so the local path drops them.
      Object.assign(new Error("odd fields"), { status: "teapot", retryable: "yes" }),
      "a thrown string",
    ];
    for (const value of thrown) {
      dispatch.mockRejectedValueOnce(value).mockRejectedValueOnce(value);
      const viaLocal = await outcome(local.status("job-any"));
      const viaSocket = await outcome(socket.status("job-any"));
      expect(viaLocal).toStrictEqual(viaSocket);
    }
    dispatch.mockRejectedValueOnce(thrown[0]);
    const typed = await outcome(local.status("job-any"));
    expect(typed.error).toMatchObject({
      code: "example_refused",
      status: 409,
      retryable: false,
      context: { head: "run-head", nested: { attempt: 2 } },
      requiredActions: ["Continue the head run instead."],
    });
    // A result the wire cannot carry is the same typed transport failure.
    dispatch.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const missing = await outcome(local.status("job-any"));
    expect(missing).toStrictEqual(await outcome(socket.status("job-any")));
    expect(missing.error).toMatchObject({
      code: "daemon_unavailable",
      status: 503,
      retryable: true,
    });
  });

  it("dispatches in process with no socket round trip", async () => {
    const { server, socket, local } = await daemon();
    const connections = vi.spyOn(server as unknown as { onConnection(): void }, "onConnection");
    const dispatch = vi.spyOn(server, "dispatch");
    await local.health();
    const { id } = await local.enqueue({ prompt: "counted" }, { clientId: "test" });
    await local.status(id);
    await local.list({ id });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(connections).not.toHaveBeenCalled();
    // The counter does see a real socket round trip.
    await socket.status(id);
    expect(connections).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(5);
  });

  it("serves a daemon whose socket never listens, resolving the server per call", async () => {
    let target: DaemonServer | undefined;
    const local = new DaemonLocalClient(() => {
      if (!target) throw new Error("server is not composed yet");
      return target;
    });
    // Composed before the server exists, as the daemon composition root does.
    await expect(local.health()).rejects.toThrow("server is not composed yet");
    const { server } = await daemon({ listen: false });
    target = server;
    await expect(local.health()).resolves.toMatchObject({ ok: true, servingMode: "normal" });
  });

  it("keeps caller-owned and server-owned objects apart, as the wire does", async () => {
    const { socket, local } = await daemon();
    const request = { prompt: "apart", nested: { kept: 1, dropped: undefined }, absent: undefined };
    const { id } = await local.enqueue(request, { clientId: "test" });
    request.nested.kept = 2;
    const first = await local.status(id);
    expect(first.params).toStrictEqual({ prompt: "apart", nested: { kept: 1 } });
    // Undefined fields are absent exactly as on the socket.
    expect("error" in first).toBe(false);
    (first.params as { prompt: string }).prompt = "mutated by the caller";
    expect((await local.status(id)).params).toStrictEqual(
      (await socket.status(id)).params as unknown,
    );
    expect(((await local.status(id)).params as { prompt: string }).prompt).toBe("apart");
  });
});
