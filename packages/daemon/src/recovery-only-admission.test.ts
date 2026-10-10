import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { afterAll, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { DaemonServer } from "./server.js";
import { recoveryOnlyRefusal, servingModeOf, type DaemonServingMode } from "./serving-admission.js";

const reapDirs: string[] = [];
afterAll(() => {
  for (const dir of reapDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `claudexor-${name}-`)));
  reapDirs.push(dir);
  return dir;
}

describe("serving admission snapshot", () => {
  it("defaults to normal when the embedder wires no snapshot", () => {
    expect(servingModeOf(undefined)).toBe("normal");
    expect(servingModeOf(() => "recovery_only")).toBe("recovery_only");
  });

  it("shapes the typed recovery-only refusal", () => {
    const refusal = recoveryOnlyRefusal("claudexor.enqueue");
    expect(refusal).toMatchObject({
      code: "daemon_recovery_only",
      status: 503,
      retryable: true,
    });
    expect(refusal.message).toContain("claudexor.enqueue");
  });
});

describe("DaemonServer recovery-only admission (issue #165 D5)", () => {
  it("starts without touching command projections, refuses product RPCs typed, keeps health + shutdown reachable, and opens admission live", async () => {
    const dir = tempDir("recovery-admission");
    const socketPath = join(dir, "daemon.sock");
    let mode: DaemonServingMode = "recovery_only";
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    const store = new CommandStore(journal);
    store.recoverAfterStartup();
    let projectionTouchesWhileClosed = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      servingMode: () => mode,
      commands: legacyCommandFixture({
        current: () => {
          // The registry must stay untouched while product admission is
          // closed: the journal projections are not activated yet (D5).
          if (mode !== "normal") {
            projectionTouchesWhileClosed += 1;
            throw new Error("command projection touched during recovery-only admission");
          }
          return store;
        },
      }),
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(client.health()).resolves.toMatchObject({
        ok: true,
        servingMode: "recovery_only",
        jobs: 0,
      });
      await expect(
        client.enqueue({ value: 1 }, { idempotencyKey: "recovery-1", clientId: "test" }),
      ).rejects.toMatchObject({
        code: "daemon_recovery_only",
        status: 503,
        retryable: true,
      });
      await expect(
        client.list({ page: { limit: 200, state: null, cursor: null } }),
      ).rejects.toMatchObject({ code: "daemon_recovery_only" });
      expect(projectionTouchesWhileClosed).toBe(0);

      mode = "normal";
      await expect(client.health()).resolves.toMatchObject({ ok: true, servingMode: "normal" });
      const accepted = await client.enqueue(
        { value: 2 },
        { idempotencyKey: "normal-1", clientId: "test" },
      );
      expect(accepted).toMatchObject({ id: expect.any(String) });
    } finally {
      await server.stop();
      journal.close();
    }
  });

  it("keeps the operator shutdown RPC reachable while admission is closed", async () => {
    const dir = tempDir("recovery-shutdown");
    const socketPath = join(dir, "daemon.sock");
    const journal = new DurableJournal({ rootDir: join(dir, "journal"), partition: "global" });
    const store = new CommandStore(journal);
    store.recoverAfterStartup();
    let shutdownRequested = 0;
    const server = new DaemonServer({
      socketPath,
      token: "token",
      servingMode: () => "recovery_only",
      commands: legacyCommandFixture({ current: () => store }),
      onShutdownRequested: async () => {
        shutdownRequested += 1;
        await server.stop();
      },
      runner: async () => ({ lifecycle: "succeeded" }),
    });
    await server.start();
    try {
      const client = new DaemonClient(socketPath, "token");
      await expect(client.shutdown()).resolves.toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(shutdownRequested).toBe(1);
    } finally {
      await server.stop();
      journal.close();
    }
  });
});
