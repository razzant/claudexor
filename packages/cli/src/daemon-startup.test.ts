import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer } from "@claudexor/daemon";
import { CONTROL_PROTOCOL_MAJOR } from "@claudexor/schema";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStartupAdmission, proveRecoveryTransport } from "./daemon-startup.js";
import { legacyCommandFixture } from "../../daemon/src/store/test-support/legacy-command-fixture.js";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
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
  afterEach(async () => {
    for (const stop of stopServers.splice(0)) await stop();
  });

  it("accepts a recovery-only socket health report without a control plane", async () => {
    await expect(
      proveRecoveryTransport({
        socketPath: await servingSocket("recovery_only"),
        identity: { version: "3.4.0", sha: "a".repeat(40) },
        token: "token",
        control: null,
      }),
    ).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();

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
