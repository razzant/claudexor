import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonControlApiServer } from "@claudexor/control-api";
import { DaemonLocalClient, DaemonServer } from "@claudexor/daemon";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonStartupAdmission,
  bindRecoveryTransport,
  proveRecoveryTransport,
} from "./daemon-startup.js";
import { legacyCommandFixture } from "../../daemon/src/store/test-support/legacy-command-fixture.js";
import { afterEachClosed } from "./test-support/after-each-closed.js";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
}, 0); // synchronous cleanup: no deadline (#376, see vitest.setup.ts)
function tempRoot(name: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
it("starts recovery-only and opens normal admission through the coordinator only", () => {
  const admission = new DaemonStartupAdmission();
  expect(admission.snapshot()).toBe("recovery_only");
  admission.openNormal();
  expect(admission.snapshot()).toBe("normal");
});
describe("recovery transport proof (issue #165 D5 stage 3)", () => {
  /** A REAL daemon socket serving `mode`; the proof must dial it itself. */
  async function servingSocket(mode: "normal" | "recovery_only"): Promise<string> {
    const socketPath = join(tempRoot("tp"), "d.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      servingMode: () => mode,
      commands: legacyCommandFixture({ all: () => [] }),
      runner: async () => ({}),
    });
    await server.start();
    stopServers.push(() => server.stop());
    return socketPath;
  }
  const stopServers: Array<() => Promise<void>> = [];
  afterEachClosed(async () => {
    // This test's folders, taken before its stops: the file-level hook of a later test never
    // removes what a failed stop kept.
    const owned = cleanup.splice(0);
    for (const stop of stopServers.splice(0)) await stop();
    return () => {
      for (const dispose of owned) dispose();
    };
  });

  it("accepts a recovery-only socket health report without a control plane", async () => {
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("recovery_only"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).resolves.toBe("proved");
  });

  it("refuses a socket that does not prove the recovery-only serving daemon", async () => {
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("normal"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).rejects.toThrow(/transport proof failed/);
  });

  it("dials the socket itself: a missing or wrong-token socket fails the proof", async () => {
    // Nothing else can stand in for the socket: an absent endpoint is a
    // transport failure, and a live one still demands the daemon token.
    await expect(
      proveRecoveryTransport({
        socketPath: join(tempRoot("tp-absent"), "d.sock"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("recovery_only"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "not-the-token",
        control: null,
      }),
    ).rejects.toThrow(/unauthorized/);
  });

  it("proves exact identity through the REAL control handshake and refuses a mismatch", async () => {
    const identity = { version: "3.4.0", sha: "b".repeat(40) };
    const serve = (engine: { version: string; sha: string }): Promise<Server> =>
      new Promise((resolve) => {
        const server = createServer((req, res) => {
          if (req.method === "POST" && req.url === "/v2/handshake") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                protocolMajor: CONTROL_PROTOCOL_MAJOR,
                compatible: true,
                operationsPath: "/v2/operations",
                engine: { ...engine, entry: "/opt/claudexor/daemon.js" },
                servingMode: "recovery_only",
              }),
            );
            return;
          }
          res.writeHead(404).end();
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
        cleanup.push(() => server.close());
      });

    const socketPath = await servingSocket("recovery_only");
    const matching = await serve(identity);
    const matchingPort = (matching.address() as { port: number }).port;
    await expect(
      proveRecoveryTransport({
        socketPath,
        identity,
        token: "token",
        control: { host: "127.0.0.1", port: matchingPort },
      }),
    ).resolves.toBe("proved");

    const foreign = await serve({ version: "3.3.7", sha: "c".repeat(40) });
    const foreignPort = (foreign.address() as { port: number }).port;
    await expect(
      proveRecoveryTransport({
        socketPath,
        identity,
        token: "token",
        control: { host: "127.0.0.1", port: foreignPort },
      }),
    ).rejects.toThrow(/exact recovery-only runtime/);
  });
});

describe("a Stop during the startup transport bind or proof (issue #278)", () => {
  const identity = { version: "3.4.0", sha: "d".repeat(40) };
  const stopAfter: Array<() => Promise<unknown>> = [];
  afterEachClosed(async () => {
    // This test's folders, taken before its stops: a failed or late stop retains them.
    const owned = cleanup.splice(0);
    for (const stop of stopAfter.splice(0)) await stop();
    return () => {
      for (const dispose of owned) dispose();
    };
  });
  /** A REAL recovery-only daemon socket server; the test decides when it starts. */
  function recoverySocket(startupBarrier?: () => Promise<void>) {
    const root = tempRoot("stop");
    const socketPath = join(root, "d.sock");
    const server = new DaemonServer({
      socketPath,
      token: "token",
      servingMode: () => "recovery_only",
      commands: legacyCommandFixture({ all: () => [] }),
      runner: async () => ({}),
      ...(startupBarrier ? { startupBarrier } : {}),
    });
    stopAfter.push(() => server.stop());
    return { server, root, socketPath, logPath: join(root, "claudexord.log") };
  }
  async function http(answer: (res: ServerResponse) => void): Promise<ControlAddress> {
    const server = createServer((_req, res) => answer(res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    return { host: "127.0.0.1", port: (server.address() as { port: number }).port };
  }
  type ControlAddress = { host: string; port: number };

  it("reports cancellation when startup is aborted during the socket health dial", async () => {
    const { server, socketPath } = recoverySocket();
    await server.start();
    const startup = new AbortController();
    const proof = proveRecoveryTransport({
      socketPath,
      identity,
      token: "token",
      control: null,
      signal: startup.signal,
    });
    // daemon.stop's order: abort startup, then stop the socket the proof dials.
    startup.abort();
    const stopped = server.stop();
    await expect(proof).resolves.toBe("cancelled");
    await stopped;
  });

  it("reports cancellation when startup is aborted during the Control handshake", async () => {
    const { server, socketPath } = recoverySocket();
    await server.start();
    const startup = new AbortController();
    // The Stop arrives while the handshake is in flight; the stopping Control
    // API then refuses it, as DaemonControlApiServer.stop() does.
    const control = await http((res) => {
      startup.abort();
      res.writeHead(503, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ code: "daemon_stopping", retryable: true }));
    });
    await expect(
      proveRecoveryTransport({
        socketPath,
        identity,
        token: "token",
        control,
        signal: startup.signal,
      }),
    ).resolves.toBe("cancelled");
  });

  it("keeps decided proof failures failures under a startup signal", async () => {
    const { server, socketPath } = recoverySocket();
    await server.start();
    const startup = new AbortController();
    const foreign = await http((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ engine: { version: "3.3.7", sha: "c".repeat(40) } }));
    });
    const proof = (input: { socketPath: string; control: ControlAddress | null }) =>
      proveRecoveryTransport({ ...input, identity, token: "token", signal: startup.signal });
    const mismatch = proof({ socketPath, control: foreign });
    await expect(mismatch).rejects.toThrow(/exact recovery-only runtime/);
    await expect(
      proof({ socketPath: join(tempRoot("absent"), "d.sock"), control: null }),
    ).rejects.toMatchObject({ code: "daemon_unavailable" });
    // A Stop after the proof decided does not turn that decision into a cancel.
    startup.abort();
    await expect(mismatch).rejects.toThrow(/exact recovery-only runtime/);
  });

  it("reports shutdown, not failure, when a Stop arrives during the socket listen", async () => {
    let stopping = false;
    const socket = recoverySocket(async () => {
      // The listen is under way when shutdown fences and stops this server.
      stopping = true;
      void socket.server.stop();
    });
    await expect(
      bindRecoveryTransport({
        ...socket,
        control: null,
        requested: () => stopping,
        daemonDir: socket.root,
      }),
    ).resolves.toBeNull();
  });

  it("reports shutdown, not failure, when a Stop arrives during the Control listen", async () => {
    const socket = recoverySocket();
    const control = new DaemonControlApiServer({
      token: "token",
      daemon: new DaemonLocalClient(() => socket.server),
    });
    stopAfter.push(() => control.stop());
    let stopping = false;
    const starting = () => {
      const started = control.start();
      stopping = true;
      void control.stop();
      return started;
    };
    await expect(
      bindRecoveryTransport({
        ...socket,
        control: { start: starting },
        requested: () => stopping,
        daemonDir: socket.root,
      }),
    ).resolves.toBeNull();
    expect(existsSync(join(socket.root, "control-api.json"))).toBe(false);
  });

  it("keeps other bind failures failures, even while a Stop is under way", async () => {
    const socket = recoverySocket();
    const busy = await http(() => undefined);
    const control = new DaemonControlApiServer({
      token: "token",
      daemon: new DaemonLocalClient(() => socket.server),
      port: busy.port,
    });
    stopAfter.push(() => control.stop());
    let stopping = false;
    const starting = () => {
      const started = control.start();
      stopping = true;
      return started;
    };
    const bind = { ...socket, requested: () => stopping, daemonDir: socket.root };
    await expect(
      bindRecoveryTransport({ ...bind, control: { start: starting } }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    // A typed stopping refusal counts only when this shutdown requested it.
    stopping = false;
    const refusal = Object.assign(new Error("stopping"), { code: "daemon_stopping" });
    await expect(
      bindRecoveryTransport({
        ...bind,
        server: { start: () => Promise.reject(refusal) },
        control: null,
      }),
    ).rejects.toBe(refusal);
  });
});
