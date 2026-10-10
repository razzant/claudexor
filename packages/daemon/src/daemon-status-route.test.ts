import { legacyCommandFixture } from "./store/test-support/legacy-command-fixture.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { DurableJournal } from "./store/test-support/fixtures/legacy/journal/index.js";
import { ControlDaemonStatus } from "@claudexor/schema";
import { expect, it, vi } from "vitest";
import { DaemonServer } from "./server.js";
import { DaemonClient } from "./client.js";
import { CommandStore } from "./store/test-support/fixtures/legacy/daemon/command-store.js";
import { recordAdmissionMemory } from "./memory-facts.js";
import { loopFacts, startLoopFacts } from "./loop-facts.js";
import { DaemonControlApiServer } from "../../control-api/src/daemon-server.js";

it("authenticates status, samples real memory without reading commands, and keeps handshake unchanged", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cx-memory-")));
  const token = randomUUID();
  const journal = new DurableJournal({ rootDir: join(root, "journal"), partition: "global" });
  const store = new CommandStore(journal);
  store.accept({
    id: "history",
    params: { prompt: "retained" },
    idempotencyKey: randomUUID(),
    clientId: "test",
  });
  store.update("history", { state: "succeeded" });
  let mode: "normal" | "recovery_only" = "recovery_only";
  const socketPath = join(root, "daemon.sock");
  const daemon = new DaemonServer({
    socketPath,
    token,
    commands: legacyCommandFixture({ current: () => store }),
    servingMode: () => mode,
    runner: async () => ({ lifecycle: "succeeded" }),
  });
  const api = new DaemonControlApiServer({
    token,
    daemon: new DaemonClient(socketPath, token),
    servingMode: () => mode,
  });
  try {
    await daemon.start();
    const { host, port } = await api.start();
    const base = `http://${host}:${port}/v2`;
    const headers = {
      authorization: ["Bearer", token].join(" "),
      "X-Claudexor-Protocol-Major": "3",
      "content-type": "application/json",
    };
    expect((await fetch(`${base}/daemon/status`)).status).toBe(401);
    const records = vi.spyOn(store, "records").mockImplementation(() => {
      throw new Error("health read history");
    });
    const read = async () => {
      const response = await fetch(`${base}/daemon/status`, { headers });
      expect(response.status).toBe(200);
      return ControlDaemonStatus.parse(await response.json());
    };
    const recovery = await read();
    expect(recovery).toMatchObject({
      servingMode: "recovery_only",
      jobs: 0,
      memory: { atAdmission: null },
      loop: null,
    });
    // Loop facts are served from the last completed window, in recovery-only
    // mode too, without reading history.
    const stopLoopFacts = startLoopFacts(20);
    try {
      for (let i = 0; i < 250 && loopFacts() === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const measured = await read();
      expect(measured.loop?.windowMs).toBeGreaterThan(0);
      expect(measured.loop?.gc.count).toBeGreaterThanOrEqual(0);
    } finally {
      stopLoopFacts();
    }
    expect((await read()).loop).toBeNull();
    recordAdmissionMemory();
    mode = "normal";
    const status = await read();
    expect(status).toMatchObject({ ok: true, servingMode: "normal", jobs: 1 });
    expect(status.memory.heapLimitBytes).toBe(getHeapStatistics().heap_size_limit);
    expect(status.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(status.memory.atAdmission).toEqual({
      heapUsedBytes: expect.any(Number),
      rssBytes: expect.any(Number),
      at: expect.any(String),
    });
    recordAdmissionMemory();
    expect((await read()).memory.atAdmission).toEqual(status.memory.atAdmission);
    expect(records).not.toHaveBeenCalled();
    const handshake = await fetch(`${base}/handshake`, {
      method: "POST",
      headers,
      body: JSON.stringify({ protocolMajor: 3, client: "memory-test" }),
    });
    expect(handshake.status).toBe(200);
    expect(Object.keys((await handshake.json()) as object).sort()).toEqual([
      "compatible",
      "engine",
      "operationsPath",
      "protocolMajor",
      "servingMode",
    ]);
    const catalog = (await (await fetch(`${base}/operations`, { headers })).json()) as {
      operations: Array<{ path: string; mutability: string }>;
    };
    expect(catalog.operations.find((op) => op.path === "/v2/daemon/status")?.mutability).toBe(
      "read_only",
    );
    records.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await api.stop();
    await daemon.stop();
    journal.close();
    rmSync(root, { recursive: true, force: true });
  }
});
